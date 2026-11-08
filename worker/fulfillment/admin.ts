import { museBalance, museConfigured, museProducts } from '../muse/client.ts'
import { fulfillMuse, museCheckoutEnabled, museMapping, musePurchase } from '../muse/service.ts'
import { ApiError, body, json, type Env } from '../platform.ts'
import { getOrder } from '../order-state.ts'
import { isServicePlan } from '../../shared/fulfillment.ts'
import { serviceCatalog, serviceCheckoutEnabled, sendServiceMail, serviceOrderSummary, taskFor } from './service.ts'
import { openVault, seal, vaultReady } from './vault.ts'

const text = (value: unknown, name: string, limit = 100, optional = false) => {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > limit || (limit <= 100 && /[\r\n]/.test(value)) || Array.from(value).some(c => (c.charCodeAt(0) < 32 && !['\n', '\r', '\t'].includes(c)) || c.charCodeAt(0) === 127)) throw new ApiError(name + '格式不正确。')
  return value.trim()
}
function cents(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 10000000) throw new ApiError('售价必须为 0.01–100000 元。')
  return Number(value)
}
const audit = (env: Env, action: string, target: string, note: string) => env.INTEREST_DB.prepare('INSERT INTO admin_audit(id,action,target_id,note,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(), action, target, note, Date.now())

/** Invoked only after requireAdmin. No inventory endpoint returns plaintext codes. */
export async function inventoryAdmin(request: Request, env: Env, url: URL) {
  const path = url.pathname, db = env.INTEREST_DB
  if (path === '/api/admin/inventory' && request.method === 'GET') {
    const products = (await db.prepare('SELECT * FROM service_products ORDER BY category,name').all()).results
    return json({ products, plans: await serviceCatalog(env), encryptionReady: await vaultReady(env), checkoutReady: await serviceCheckoutEnabled(env) })
  }
  if (path === '/api/admin/inventory/muse' && request.method === 'GET') {
    if (!museConfigured(env)) return json({ configured: false, checkoutReady: false, products: [] })
    return json({ configured: true, checkoutReady: museCheckoutEnabled(env), products: await museProducts(env), balance: await museBalance(env) })
  }
  if (request.method !== 'POST' && !path.endsWith('/stock')) throw new ApiError('请求方式不支持。', 405)
  if (path === '/api/admin/inventory/products/visibility') {
    const data = await body(request)
    if (typeof data.id !== 'string' || !isServicePlan(data.id) || typeof data.hidden !== 'boolean' || !Number.isSafeInteger(data.version) || Number(data.version) < 0) throw new ApiError('商品上下架参数无效。')
    const current = await db.prepare('SELECT id,name,hidden,version FROM service_products WHERE id=?').bind(data.id).first<{ id: string; name: string; hidden: number; version: number }>()
    if (!current) throw new ApiError('商品不存在。', 404)
    if (current.version !== data.version) throw new ApiError('商品已更新，请刷新。', 409)
    if (Boolean(current.hidden) === data.hidden) return json({ id: current.id, hidden: current.hidden, version: current.version })
    const event = crypto.randomUUID()
    await db.batch([
      db.prepare('UPDATE service_products SET hidden=?,version=version+1 WHERE id=? AND version=?').bind(Number(data.hidden), current.id, current.version),
      db.prepare("INSERT INTO admin_audit(id,action,target_id,note,created_at) SELECT ?,'service-product-visibility',id,?,? FROM service_products WHERE id=? AND version=? AND hidden=?")
        .bind(event, `${env.ADMIN_USERNAME}: ${data.hidden ? '下架并隐藏' : '恢复展示'} ${current.name}`, Date.now(), current.id, current.version + 1, Number(data.hidden)),
    ])
    if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(event).first()) throw new ApiError('商品已更新，请刷新。', 409)
    return json({ id: current.id, hidden: Number(data.hidden), version: current.version + 1 })
  }
  if (path === '/api/admin/inventory/products') {
    const data = await body(request, 12000)
    const name = text(data.name, '商品名称'), category = text(data.category, '分类', 60), description = text(data.description ?? '', '商品说明', 2000, true)
    const id = typeof data.id === 'string' ? data.id : 'custom-' + crypto.randomUUID()
    if (!isServicePlan(id)) throw new ApiError('商品编号无效。')
    const exists = await db.prepare('SELECT version FROM service_products WHERE id=?').bind(id).first<{ version: number }>()
    if (exists) {
      if (exists.version !== data.version) throw new ApiError('商品已更新，请刷新。', 409)
      const event = crypto.randomUUID()
      await db.batch([
        db.prepare("INSERT INTO admin_audit(id,action,target_id,note,created_at) SELECT ?,'service-product-update',id,'更新商品分类及说明',? FROM service_products WHERE id=? AND version=?").bind(event, Date.now(), id, exists.version),
        db.prepare('UPDATE service_products SET name=?,category=?,description=?,version=version+1 WHERE id=? AND version=?').bind(name, category, description, id, exists.version),
      ])
      if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(event).first()) throw new ApiError('商品已更新，请刷新。', 409)
    } else {
      if (data.id) throw new ApiError('商品不存在。', 404)
      await db.batch([db.prepare('INSERT INTO service_products(id,name,category,description) VALUES(?,?,?,?)').bind(id, name, category, description), audit(env, 'service-product-create', id, '创建商品：' + name)])
    }
    return json({ id })
  }
  if (path === '/api/admin/inventory/plans') {
    const data = await body(request, 14000), name = text(data.name, '规格名称'), price = cents(data.priceCents)
    const instructions = text(data.instructions ?? '', '交付说明', 2000), purchaseNote = text(data.purchaseNote ?? '', '购买说明', 2000)
    if (!['stock', 'manual', 'muse'].includes(String(data.kind))) throw new ApiError('请选择已实现的交付方式。')
    const isMuse = data.kind === 'muse'
    const kind = isMuse ? 'manual' : String(data.kind)
    const supplierCode = isMuse ? text(data.supplierCode, '供货商品代码') : ''
    if (isMuse && (!/^muse(?:[-_]|$)[A-Za-z0-9_.:-]*$/i.test(supplierCode) || !Number.isSafeInteger(data.maxCostCents) || Number(data.maxCostCents) <= 0 || Number(data.maxCostCents) >= price)) throw new ApiError('供货商品代码或采购上限无效；上限必须低于售价。')
    if (typeof data.enabled !== 'boolean') throw new ApiError('销售状态无效。')
    const productId = text(data.productId, '商品编号')
    if (!await db.prepare('SELECT id FROM service_products WHERE id=?').bind(productId).first()) throw new ApiError('商品不存在。', 404)
    const id = typeof data.id === 'string' ? data.id : 'custom-' + crypto.randomUUID()
    const current = await db.prepare('SELECT version,delivery_type,product_id FROM catalog_plans WHERE id=?').bind(id).first<{ version: number; delivery_type: string; product_id: string }>()
    if (!isServicePlan(id)) throw new ApiError('规格编号无效。')
    if (current) {
      if (current.version !== data.version) throw new ApiError('规格已更新，请刷新。', 409)
      const mapping = await museMapping(env, id)
      if (Boolean(mapping) !== isMuse || (mapping && (mapping.product_code !== supplierCode || mapping.max_cost_cents !== data.maxCostCents))) throw new ApiError('已有供货规格不能修改货源或采购上限，请新建规格。', 409)
      if (current.delivery_type !== kind || current.product_id !== productId) throw new ApiError('已有规格不能切换交付方式或所属商品，请新建规格。', 409)
      const event = crypto.randomUUID()
      await db.batch([
        db.prepare("INSERT INTO admin_audit(id,action,target_id,note,created_at) SELECT ?,'service-plan-update',id,'更新规格价格、说明及销售状态',? FROM catalog_plans WHERE id=? AND version=?").bind(event, Date.now(), id, current.version),
        db.prepare('UPDATE catalog_plans SET name=?,price_cents=?,enabled=?,purchase_note=?,delivery_instructions=?,version=version+1,updated_at=? WHERE id=? AND version=?').bind(name, price, Number(data.enabled), purchaseNote, instructions, Date.now(), id, current.version),
      ])
      if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(event).first()) throw new ApiError('规格已更新，请刷新。', 409)
    } else {
      if (data.id) throw new ApiError('规格不存在。', 404)
      await db.batch([
        db.prepare('INSERT INTO catalog_plans(id,product_id,name,price_cents,enabled,partner_enabled,purchase_note,delivery_instructions,delivery_type,updated_at) VALUES(?,?,?,?,?,0,?,?,?,?)').bind(id, productId, name, price, Number(data.enabled), purchaseNote, instructions, kind, Date.now()),
        ...(isMuse ? [db.prepare('INSERT INTO muse_plans(plan,product_code,max_cost_cents) VALUES(?,?,?)').bind(id, supplierCode, Number(data.maxCostCents))] : []),
        audit(env, 'service-plan-create', id, '创建规格：' + name + '；交付方式：' + String(data.kind)),
      ])
    }
    return json({ id })
  }
  const stock = path.match(/^\/api\/admin\/inventory\/([^/]+)\/stock$/)
  if (stock) {
    const plan = await db.prepare("SELECT id FROM catalog_plans WHERE id=? AND delivery_type='stock'").bind(stock[1]).first()
    if (!plan) throw new ApiError('该规格不支持自有库存。', 404)
    if (request.method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? 1)
      if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new ApiError('页码无效。')
      const rows = (await db.prepare('SELECT id,state,order_id,cost_cents,created_at,delivered_at FROM cdk_stock WHERE plan=? ORDER BY created_at DESC,id LIMIT 50 OFFSET ?').bind(stock[1], (page - 1) * 50).all()).results
      const counts = (await db.prepare('SELECT state,COUNT(*) count FROM cdk_stock WHERE plan=? GROUP BY state').bind(stock[1]).all()).results
      return json({ rows, counts, page })
    }
    if (request.method !== 'POST') throw new ApiError('请求方式不支持。', 405)
    const data = await body(request, 600000)
    if (data.action === 'quarantine') {
      const event = crypto.randomUUID()
      await db.batch([
        db.prepare("INSERT INTO admin_audit(id,action,target_id,note,created_at) SELECT ?,'stock-quarantine',id,'停用未分配库存',? FROM cdk_stock WHERE id=? AND plan=? AND state='available'").bind(event, Date.now(), String(data.id), stock[1]),
        db.prepare("UPDATE cdk_stock SET state='quarantined' WHERE id=? AND plan=? AND state='available'").bind(String(data.id), stock[1]),
      ])
      if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(event).first()) throw new ApiError('只能停用未分配的库存，请刷新。', 409)
      return json({ ok: true })
    }
    if (data.action !== 'import' || typeof data.values !== 'string') throw new ApiError('导入操作无效。')
    const values = data.values.split(/\r?\n/).map(v => v.trim()).filter(Boolean)
    if (!values.length || values.length > 100 || values.some(v => v.length > 8192 || Array.from(v).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))) throw new ApiError('每次导入 1–100 条，一行一条，每条最多 8192 字。')
    if (!Number.isSafeInteger(data.costCents) || Number(data.costCents) < 0 || Number(data.costCents) > 10000000) throw new ApiError('采购成本无效。')
    if (new Set(values).size !== values.length) throw new ApiError('本次导入包含重复内容，未导入。', 409)
    const vault = await openVault(env)
    const rows = await Promise.all(values.map(async value => {
      const id = crypto.randomUUID()
      return { id, fingerprint: await vault.fingerprint(value), encrypted: await vault.seal(value, 'stock:' + id) }
    }))
    if (await db.prepare('SELECT id FROM cdk_stock WHERE fingerprint IN (' + rows.map(() => '?').join(',') + ') LIMIT 1').bind(...rows.map(v => v.fingerprint)).first()) throw new ApiError('存在已导入的卡密，整批未导入。', 409)
    try {
      const inserts = []
      // At most 96 bound parameters per statement, including a full 100-code import.
      for (let offset = 0; offset < rows.length; offset += 16) {
        const chunk = rows.slice(offset, offset + 16)
        inserts.push(db.prepare('INSERT INTO cdk_stock(id,plan,fingerprint,encrypted_value,cost_cents,created_at) VALUES ' + chunk.map(() => '(?,?,?,?,?,?)').join(','))
          .bind(...chunk.flatMap(row => [row.id, stock[1], row.fingerprint, row.encrypted, Number(data.costCents), Date.now()])))
      }
      await db.batch([
        ...inserts,
        audit(env, 'stock-import', stock[1], '导入库存 ' + rows.length + ' 条'),
      ])
    } catch { throw new ApiError('导入未完成，可能存在并发重复内容；请刷新核对后重试。', 409) }
    return json({ imported: rows.length }, 201)
  }
  const task = path.match(/^\/api\/admin\/inventory\/orders\/([A-Z0-9-]+)$/)
  if (task && request.method === 'POST') {
    const data = await body(request, 20000), order = await getOrder(env, task[1]), current = await taskFor(env, order.id)
    if (!current) throw new ApiError('交付任务不存在。', 404)
    if (data.action === 'retry-mail') { await db.batch([audit(env, 'service-mail-retry', order.id, '核对原交付邮件，不重新分配库存')]); await sendServiceMail(env, order.id); return json({ ok: true }) }
    if (await musePurchase(env, order.id)) {
      if (data.action !== 'sync') throw new ApiError('供货订单只能核对原采购单，不能手工替换交付内容。', 409)
      await fulfillMuse(env, order.id); await sendServiceMail(env, order.id)
      return json({ ok: true })
    }
    if (current.kind !== 'manual') throw new ApiError('自有库存订单由系统分配，不能替换交付内容。', 409)
    if (current.state === 'delivered' && data.action === 'complete') return json(await serviceOrderSummary(env, order))
    if (!['start', 'complete'].includes(String(data.action))) throw new ApiError('交付操作无效。')
    if (order.version !== data.version) throw new ApiError('订单已更新，请刷新。', 409)
    const note = text(data.note, '处理说明', 500), value = data.action === 'complete' ? text(data.value, '交付结果', 8192) : ''
    const encrypted = value ? await seal(env, value, 'task:' + order.id) : null, now = Date.now(), event = crypto.randomUUID()
    await db.batch([
      db.prepare(`UPDATE orders SET status=?,updated_at=?,started_at=COALESCE(started_at,?),version=version+1,last_event_id=? WHERE id=? AND version=? AND status IN ('session','processing') AND mode='live' AND payment_status='paid' AND is_test=0 AND refund_hold=0 AND refunded_cents=0 AND redemption_blocked=0 AND EXISTS(SELECT 1 FROM fulfillment_tasks t WHERE t.order_id=orders.id AND t.kind='manual' AND t.state IN ('queued','running'))`).bind(data.action === 'complete' ? 'success' : 'processing', now, now, event, order.id, order.version),
      db.prepare("UPDATE fulfillment_tasks SET state=?,encrypted_value=COALESCE(?,encrypted_value),delivered_at=?,updated_at=? WHERE order_id=? AND EXISTS(SELECT 1 FROM orders WHERE id=order_id AND last_event_id=?)").bind(data.action === 'complete' ? 'delivered' : 'running', encrypted, data.action === 'complete' ? now : null, now, order.id, event),
      db.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,?,'service-manual',?,status,?,version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, 'admin:' + env.ADMIN_USERNAME, order.status, note, now, order.id, event),
    ])
    if (!await db.prepare('SELECT id FROM order_events WHERE id=?').bind(event).first()) throw new ApiError('订单未付款、已暂停或状态已更新。', 409)
    await sendServiceMail(env, order.id)
    return json({ ok: true })
  }
  throw new ApiError('未找到库存管理接口。', 404)
}

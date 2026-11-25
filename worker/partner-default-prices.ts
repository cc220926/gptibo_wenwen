import { productNameForId } from '../shared/email-products.ts'
import type { DefaultSupplyPlan, DefaultSupplySettings } from '../shared/partner-default-prices.ts'
import { ApiError, body, json, type Env } from './platform.ts'
import { backfillPartnerPrices } from './partner-price-backfill.ts'

export async function defaultSupplySettings(env: Env): Promise<DefaultSupplySettings> {
  const settings = await env.INTEREST_DB.prepare('SELECT version FROM partner_default_price_settings WHERE id=1').first<{ version: number }>()
  if (!settings) throw new ApiError('统一供货价设置暂不可用，请稍后重试。', 503)
  const plans = (await env.INTEREST_DB.prepare('SELECT c.id,c.product_id,c.name,c.price_cents,c.renewal_only,c.version catalog_version,COALESCE(d.cost_cents,c.price_cents) cost_cents,(SELECT MIN(pp.price_cents) FROM partner_prices pp WHERE pp.plan=c.id) min_partner_price_cents FROM catalog_plans c LEFT JOIN partner_default_prices d ON d.plan=c.id ORDER BY c.rowid').all<DefaultSupplyPlan>()).results
  return { version: settings.version, plans }
}

export async function defaultSupplyRoute(request: Request, env: Env) {
  if (request.method === 'GET') return json(await defaultSupplySettings(env))
  if (request.method !== 'POST') throw new ApiError('请通过统一供货价表单保存。', 405)
  const data = await body(request)
  if (!Number.isSafeInteger(data.version) || Number(data.version) < 0) throw new ApiError('设置版本无效，请刷新重试。')
  const current = await defaultSupplySettings(env)
  if (data.version !== current.version) throw new ApiError('统一供货价已更新，请刷新后再保存。', 409)
  if (!Array.isArray(data.prices) || data.prices.length !== current.plans.length) throw new ApiError('请填写所有商品的统一供货价。')
  const seen = new Set<string>()
  const prices = data.prices.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('统一供货价格式无效。')
    const row = value as Record<string, unknown>
    const plan = current.plans.find(plan => plan.id === row.plan)
    if (!plan || seen.has(plan.id)) throw new ApiError('商品无效或重复，请刷新后重试。')
    seen.add(plan.id)
    if (!Number.isSafeInteger(row.costCents) || Number(row.costCents) < 1 || Number(row.costCents) > 10000000) throw new ApiError('拿货价需为 ¥0.01–¥100,000.00，最多两位小数。')
    if (row.catalogVersion !== plan.catalog_version) throw new ApiError('平台售价已更新，请刷新后再保存。', 409)
    if (Number(row.costCents) > plan.price_cents) throw new ApiError('统一供货价不能高于当前平台售价。')
    if (plan.min_partner_price_cents != null && Number(row.costCents) > plan.min_partner_price_cents) throw new ApiError(`${productNameForId(plan.product_id)} ${plan.name} 的供货价高于现有代理售价（最低 ¥${(plan.min_partner_price_cents / 100).toFixed(2)}），请先协调代理调整售价。本次未保存。`, 409)
    return { plan, cost: Number(row.costCents) }
  })
  const id = crypto.randomUUID(); const now = Date.now(); const db = env.INTEREST_DB
  // Claim one revision only if every catalog row still matches. All writes and
  // the audit record share this claim inside the same database transaction.
  // Bind one JSON array rather than 5 parameters per plan (D1 parameter limit).
  const guards = JSON.stringify(prices.map(row => ({ plan: row.plan.id, version: row.plan.catalog_version, cost: row.cost })))
  const note = env.ADMIN_USERNAME + '：修改统一供货价并同步全部代理（保留售价及历史订单）；' + prices.map(row => `${productNameForId(row.plan.product_id) + ' ' + row.plan.name} ¥${(row.plan.cost_cents / 100).toFixed(2)} → ¥${(row.cost / 100).toFixed(2)}`).join('；')
  await db.batch([
    db.prepare(`UPDATE partner_default_price_settings SET version=version+1,change_id=?,updated_at=?
      WHERE id=1 AND version=? AND (SELECT COUNT(*) FROM catalog_plans)=?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) row
        WHERE NOT EXISTS(SELECT 1 FROM catalog_plans c WHERE c.id=json_extract(row.value,'$.plan') AND c.version=json_extract(row.value,'$.version') AND c.price_cents>=json_extract(row.value,'$.cost'))
        OR EXISTS(SELECT 1 FROM partner_prices pp WHERE pp.plan=json_extract(row.value,'$.plan') AND pp.price_cents<json_extract(row.value,'$.cost')))
    `).bind(id, now, current.version, current.plans.length, guards),
    ...prices.map(row => db.prepare('INSERT INTO partner_default_prices(plan,cost_cents) SELECT ?,? WHERE EXISTS(SELECT 1 FROM partner_default_price_settings WHERE id=1 AND change_id=?) ON CONFLICT(plan) DO UPDATE SET cost_cents=excluded.cost_cents').bind(row.plan.id, row.cost, id)),
    // Cost and version change together; concurrent checkout/retail edits using
    // the old offer version must retry. Never rewrite retail or order snapshots.
    db.prepare(`UPDATE partner_prices SET cost_cents=(SELECT d.cost_cents FROM partner_default_prices d WHERE d.plan=partner_prices.plan),version=version+1
      WHERE EXISTS(SELECT 1 FROM partner_default_price_settings WHERE id=1 AND change_id=?)
      AND EXISTS(SELECT 1 FROM partner_default_prices d WHERE d.plan=partner_prices.plan AND d.cost_cents<>partner_prices.cost_cents)`).bind(id),
    db.prepare("INSERT INTO admin_audit(id,target_id,action,note,created_at) SELECT ?,'partner-default-prices','partner-default-prices',?,? FROM partner_default_price_settings WHERE id=1 AND change_id=?").bind(id, note, now, id),
    backfillPartnerPrices(env, id),
  ])
  if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(id).first()) throw new ApiError('统一供货价、平台或代理售价已更新，请刷新核对后再保存。', 409)
  return json(await defaultSupplySettings(env))
}

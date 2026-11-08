import { useEffect, useRef, useState } from 'react'
import { Plus, Package, Upload } from 'lucide-react'
import { api, errorMessage, type CatalogPlan } from '@/lib/api'
import { useResource } from '@/lib/use-resource'
import { Feedback } from '@/components/workspace-loading'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { ServiceProduct } from '../../shared/fulfillment'
import './inventory.css'

type Plan = CatalogPlan & { delivery_type: 'stock' | 'manual'; product_name: string; stock_available: number }
const money = (value: number) => '¥' + (value / 100).toFixed(2)
const priceCents = (value: string) => /^\d{1,6}(\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : NaN
const stockLabels: Record<string, string> = { available: '可售', reserved: '待付款预留', delivered: '已交付', quarantined: '已停用' }

function ProductEditor({ product, categories, onClose, onSaved }: { product?: ServiceProduct; categories: string[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(product?.name ?? ''), [category, setCategory] = useState(product?.category ?? ''), [description, setDescription] = useState(product?.description ?? '')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), lock = useRef(false)
  async function save() {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await api('/api/admin/inventory/products', { id: product?.id, version: product?.version, name, category, description }); onSaved(); onClose() }
    catch (e) { setError(errorMessage(e)) } finally { lock.current = false; setBusy(false) }
  }
  return <Dialog open onOpenChange={v => { if (!v && !busy) onClose() }}><DialogContent className="motion-dialog service-dialog"><DialogHeader><DialogTitle>{product ? '编辑商品' : '新建商品'}</DialogTitle><DialogDescription>分类用于浏览，交付方式在规格中设置。</DialogDescription></DialogHeader><form className="service-form" onSubmit={e => { e.preventDefault(); void save() }}>
    <label htmlFor="inventory-name">商品名称</label><Input id="inventory-name" required maxLength={100} value={name} onChange={e => setName(e.target.value)} disabled={busy} />
    <label htmlFor="inventory-category">商品分类</label><Input id="inventory-category" required list="inventory-categories" maxLength={60} value={category} onChange={e => setCategory(e.target.value)} disabled={busy} placeholder="选择已有分类，或填写新分类" /><datalist id="inventory-categories">{categories.map(v => <option key={v} value={v} />)}</datalist>
    <label htmlFor="inventory-description">商品介绍</label><textarea id="inventory-description" rows={4} maxLength={2000} value={description} onChange={e => setDescription(e.target.value)} disabled={busy} />
    <Feedback error={error} /><Button type="submit" disabled={busy}>{busy ? '保存中…' : '保存商品'}</Button>
  </form></DialogContent></Dialog>
}
function PlanEditor({ product, plan, onClose, onSaved }: { product: ServiceProduct; plan?: Plan; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(plan?.name ?? ''), [price, setPrice] = useState(plan ? (plan.price_cents / 100).toFixed(2) : '')
  const [kind, setKind] = useState<'stock' | 'manual' | 'muse'>(plan?.delivery_provider === 'muse' ? 'muse' : plan?.delivery_type ?? 'stock'), [enabled, setEnabled] = useState(Boolean(plan?.enabled))
  const [supplierCode, setSupplierCode] = useState(plan?.muse_product_code ?? ''), [maxCost, setMaxCost] = useState(plan?.muse_max_cost_cents ? (plan.muse_max_cost_cents / 100).toFixed(2) : '')
  const [purchaseNote, setPurchaseNote] = useState(plan?.purchase_note ?? ''), [instructions, setInstructions] = useState(plan?.delivery_instructions ?? '')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), lock = useRef(false)
  async function save() {
    if (lock.current) return
    const cents = priceCents(price)
    if (!Number.isSafeInteger(cents) || cents < 1 || cents > 10000000) { setError('请输入有效售价，最多两位小数。'); return }
    lock.current = true; setBusy(true); setError('')
    try { await api('/api/admin/inventory/plans', { id: plan?.id, version: plan?.version, productId: product.id, name, priceCents: cents, kind, enabled, supplierCode, maxCostCents: priceCents(maxCost), purchaseNote, instructions }); onSaved(); onClose() }
    catch (e) { setError(errorMessage(e)) } finally { lock.current = false; setBusy(false) }
  }
  return <Dialog open onOpenChange={v => { if (!v && !busy) onClose() }}><DialogContent className="motion-dialog service-dialog"><DialogHeader><DialogTitle>{plan ? '编辑规格' : '添加规格'}</DialogTitle><DialogDescription>{product.name} · 每个规格使用独立库存。</DialogDescription></DialogHeader><form className="service-form" onSubmit={e => { e.preventDefault(); void save() }}>
    <label htmlFor="inventory-plan-name">规格名称</label><Input id="inventory-plan-name" required maxLength={100} value={name} onChange={e => setName(e.target.value)} disabled={busy} placeholder="例如：月卡、年卡、单次服务" />
    <label htmlFor="inventory-price">售价（元）</label><Input id="inventory-price" required inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} disabled={busy} />
    <label htmlFor="inventory-kind">交付方式</label><select id="inventory-kind" value={kind} onChange={e => setKind(e.target.value as typeof kind)} disabled={busy || Boolean(plan)}><option value="stock">自有库存自动交付</option><option value="manual">人工服务交付</option><option value="muse">Muse 原生 API 自动采购</option></select>
    <p className="admin-subtle">{kind === 'muse' ? '确认付款后，按原订单向供货平台采购一份，成功后加密交付并发邮件。采购上限及货源保存后不可更改。' : kind === 'stock' ? '确认付款后，分配一条库存；订单页可领取，并发送邮件。' : '确认付款后，进入人工处理；填写交付结果后在订单页展示并发送邮件。'}{plan && ' 交付方式不可切换，需要时请新建规格。'}</p>
    {kind === 'muse' && <><label htmlFor="muse-code">供货商品代码（从下方供货列表复制）</label><Input id="muse-code" required value={supplierCode} onChange={e => setSupplierCode(e.target.value)} disabled={busy || Boolean(plan)} maxLength={100} /><label htmlFor="muse-cost">采购上限（元，低于售价）</label><Input id="muse-cost" required inputMode="decimal" value={maxCost} onChange={e => setMaxCost(e.target.value)} disabled={busy || Boolean(plan)} /></>}
    <label htmlFor="inventory-purchase-note">购买说明（下单前可见）</label><textarea id="inventory-purchase-note" required rows={3} maxLength={2000} value={purchaseNote} onChange={e => setPurchaseNote(e.target.value)} disabled={busy} placeholder="适用范围、地区、有效期与售后条件" />
    <label htmlFor="inventory-instructions">交付说明（随商品发送）</label><textarea id="inventory-instructions" required rows={3} maxLength={2000} value={instructions} onChange={e => setInstructions(e.target.value)} disabled={busy} placeholder="兑换步骤或服务结果说明，不要在这里填写专属卡密" />
    <label className="admin-checkbox"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={busy} />开放新购买</label>
    <Feedback error={error} /><Button type="submit" disabled={busy}>{busy ? '保存中…' : '保存规格'}</Button>
  </form></DialogContent></Dialog>
}
function StockPanel({ plan, onSaved }: { plan: Plan; onSaved: () => void }) {
  const panel = useRef<HTMLElement>(null)
  useEffect(() => { panel.current?.scrollIntoView({ block: 'start', behavior: 'instant' }) }, [])
  const [revision, setRevision] = useState(0), [page, setPage] = useState(1)
  const resource = useResource<{ rows: { id: string; state: string; order_id: string | null; cost_cents: number; created_at: number }[]; counts: { state: string; count: number }[] }>(`/api/admin/inventory/${plan.id}/stock?page=${page}`, revision)
  const [values, setValues] = useState(''), [cost, setCost] = useState('0'), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), lock = useRef(false)
  async function act(action: 'import' | 'quarantine', id?: string) {
    if (lock.current) return
    const cents = priceCents(cost)
    if (action === 'import' && (!Number.isSafeInteger(cents) || cents < 0 || cents > 10000000)) { setError('请输入有效单条成本。'); return }
    lock.current = true; setBusy(true); setError(''); setMessage('')
    try { const result = await api<{ imported?: number }>(`/api/admin/inventory/${plan.id}/stock`, { action, id, values, costCents: cents }); if (action === 'import') setValues(''); setMessage(action === 'import' ? `已导入 ${result.imported} 条库存` : '已停用该条库存'); setRevision(v => v + 1); onSaved() }
    catch (e) { setError(errorMessage(e)) } finally { lock.current = false; setBusy(false) }
  }
  const total = resource.data?.counts.reduce((sum, v) => sum + v.count, 0) ?? 0
  return <section ref={panel} className="admin-panel inventory-stock"><h2>{plan.product_name} · {plan.name} · 库存</h2><div className="inventory-counts">{resource.data?.counts.map(v => <span key={v.state}>{stockLabels[v.state]} <strong>{v.count}</strong></span>)}</div>
    <form className="service-form" onSubmit={e => { e.preventDefault(); void act('import') }}><label htmlFor="inventory-values">批量导入（一行一条，每次最多 100 条）</label><textarea id="inventory-values" required rows={6} value={values} onChange={e => setValues(e.target.value)} disabled={busy} autoComplete="off" spellCheck={false} placeholder="粘贴 CDK、账号资料或领取链接" />
      <label htmlFor="inventory-cost">每条采购成本（元）</label><Input id="inventory-cost" inputMode="decimal" value={cost} onChange={e => setCost(e.target.value)} disabled={busy} /><p className="admin-subtle">整批检查重复后导入。已交付的内容不会因退款重新上架。</p><Feedback error={error} />{message && <p role="status">{message}</p>}<Button type="submit" disabled={busy || !values.trim()}><Upload size={15} />{busy ? '处理中…' : '导入库存'}</Button>
    </form><Feedback error={resource.error} loading={resource.loading} data={resource.data} />
    {resource.data && <><div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>库存编号</th><th>状态</th><th>关联订单</th><th>成本</th><th>操作</th></tr></thead><tbody>{resource.data.rows.map(row => <tr key={row.id}><td>{row.id.slice(0, 8)}<small>{new Date(row.created_at).toLocaleString('zh-CN')}</small></td><td>{stockLabels[row.state]}</td><td>{row.order_id ?? '未分配'}</td><td>{money(row.cost_cents)}</td><td>{row.state === 'available' && <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('quarantine', row.id)}>停用</Button>}</td></tr>)}</tbody></table></div><div className="admin-pagination"><span>共 {total} 条 · 第 {page} 页</span><Button variant="outline" disabled={page === 1} onClick={() => setPage(v => v - 1)}>上一页</Button><Button variant="outline" disabled={page * 50 >= total} onClick={() => setPage(v => v + 1)}>下一页</Button></div></>}
  </section>
}
export default function InventoryPage({ revision }: { revision: number }) {
  const [local, setLocal] = useState(0), resource = useResource<{ products: ServiceProduct[]; plans: Plan[]; encryptionReady: boolean; checkoutReady: boolean }>('/api/admin/inventory', revision + local)
  const [category, setCategory] = useState(''), [productEditor, setProductEditor] = useState<{ product?: ServiceProduct }>(), [planEditor, setPlanEditor] = useState<{ product: ServiceProduct; plan?: Plan }>(), [stock, setStock] = useState<Plan>()
  const [visibilityBusy, setVisibilityBusy] = useState(''), [visibilityError, setVisibilityError] = useState(''), [visibilityMessage, setVisibilityMessage] = useState('')
  const visibilityLock = useRef(false)
  const refresh = () => setLocal(v => v + 1), categories = [...new Set(resource.data?.products.map(p => p.category) ?? [])]
  async function toggleVisibility(product: ServiceProduct) {
    if (visibilityLock.current) return
    visibilityLock.current = true; setVisibilityBusy(product.id); setVisibilityError(''); setVisibilityMessage('')
    try {
      const hidden = !product.hidden
      await api('/api/admin/inventory/products/visibility', { id: product.id, version: product.version, hidden })
      setVisibilityMessage(`${product.name}已${hidden ? '下架并从前台隐藏' : '恢复展示'}。已有订单仍可查询和处理。`)
      refresh()
    } catch (error) { setVisibilityError(errorMessage(error)); refresh() }
    finally { visibilityLock.current = false; setVisibilityBusy('') }
  }
  return <><section className="admin-panel"><div className="admin-panel-title"><div><h2>自有商品与库存</h2><p className="admin-subtle">新建商品 → 添加规格 → 导入库存 → 开放销售。每单交付一份，当前支持平台直营。</p></div><Button onClick={() => setProductEditor({})}><Plus size={15} />新建商品</Button></div><Feedback error={resource.error} loading={resource.loading} data={resource.data} />
    {visibilityError && <p className="admin-error" role="alert">{visibilityError}</p>}{visibilityMessage && <p className="admin-success" role="status">{visibilityMessage}</p>}
    {resource.data && <>{!resource.data.encryptionReady && <p role="alert" className="service-policy">库存加密尚未配置，导入与购买暂不可用，请联系部署管理员。</p>}{resource.data.encryptionReady && !resource.data.checkoutReady && <p className="service-policy">自有商品暂未开放购买，请检查收款、邮件及开店配置。可先准备商品与库存。</p>}<label className="inventory-category-filter">筛选分类<select value={category} onChange={e => setCategory(e.target.value)}><option value="">全部分类</option>{categories.map(v => <option key={v} value={v}>{v}</option>)}</select></label>
    {!resource.data.products.length && <div className="admin-empty"><Package /><h3>还没有自有商品</h3><p>添加商品与规格后，可导入 CDK 或提供人工服务。</p></div>}
    <MuseSupplyPanel />{resource.data.products.filter(p => !category || p.category === category).map(product => <article key={product.id} className="inventory-product"><header><div><small>{product.category}</small><h3>{product.name}</h3><p>{product.description}</p><span className={'admin-pill' + (product.hidden ? '' : ' available')}>{product.hidden ? '已下架 · 前台隐藏' : '前台展示中'}</span></div><div><Button variant="ghost" onClick={() => setProductEditor({ product })}>编辑商品</Button><Button variant="outline" onClick={() => setPlanEditor({ product })}>添加规格</Button><Button variant="outline" disabled={Boolean(visibilityBusy)} onClick={() => void toggleVisibility(product)}>{visibilityBusy === product.id ? '处理中…' : product.hidden ? '恢复展示' : '下架并隐藏'}</Button></div></header><div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>规格</th><th>售价</th><th>交付方式</th><th>销售状态</th><th>可售库存</th><th>操作</th></tr></thead><tbody>{resource.data!.plans.filter(p => p.product_id === product.id).map(plan => <tr key={plan.id}><td>{plan.name}</td><td>{money(plan.price_cents)}</td><td>{plan.delivery_provider === 'muse' ? 'Muse 自动采购' : plan.delivery_type === 'stock' ? '库存自动交付' : '人工服务'}</td><td>{plan.enabled ? product.hidden ? '商品已下架' : '已开放' : '已暂停'}</td><td>{plan.delivery_provider === 'muse' ? '下单时检查供货' : plan.delivery_type === 'stock' ? plan.stock_available : '—'}</td><td><Button variant="ghost" onClick={() => setPlanEditor({ product, plan })}>编辑规格</Button>{plan.delivery_type === 'stock' && <Button variant="outline" onClick={() => setStock(plan)}>管理库存</Button>}</td></tr>)}</tbody></table></div></article>)}</>}
  </section>{stock && <StockPanel key={stock.id} plan={stock} onSaved={refresh} />}{productEditor && <ProductEditor product={productEditor.product} categories={categories} onClose={() => setProductEditor(undefined)} onSaved={refresh} />}{planEditor && <PlanEditor {...planEditor} onClose={() => setPlanEditor(undefined)} onSaved={refresh} />}</>
}

function MuseSupplyPanel() {
  const [revision, setRevision] = useState(0)
  const result = useResource<{ configured: boolean; checkoutReady: boolean; balance?: { available_minor: number; frozen_minor: number }; products: { code: string; name: string; supply_minor: number; enabled: boolean; available: boolean }[] }>('/api/admin/inventory/muse', revision)
  return <section className="admin-panel"><div className="admin-panel-title"><h3>Muse 原生 API 供货</h3><Button variant="outline" onClick={() => setRevision(v => v + 1)} disabled={result.loading}>刷新供货</Button></div><Feedback error={result.error} />{result.data && <><p>{result.data.configured ? result.data.checkoutReady ? '接口已配置，允许新采购。' : '接口已配置，新采购开关未开放。' : '尚未配置服务端 MUSE_KEY_ID / MUSE_API_SECRET。'}{result.data.balance && ` 可用余额 ${money(result.data.balance.available_minor)}，冻结 ${money(result.data.balance.frozen_minor)}。`}</p><p className="admin-subtle">先核对供货商品、交付内容、售后与收款渠道允许的商品范围，再添加自动采购规格。查询不采购、不扣款。</p><div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>供货商品</th><th>商品代码</th><th>渠道价</th><th>可购状态</th></tr></thead><tbody>{result.data.products.map(p => <tr key={p.code}><td>{p.name}</td><td><code>{p.code}</code></td><td>{money(p.supply_minor)}</td><td>{p.enabled && p.available ? '可采购' : '暂不可采购'}</td></tr>)}</tbody></table></div></>}</section>
}

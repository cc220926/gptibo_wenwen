import { useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { useResource } from '@/lib/use-resource'
import { Feedback } from '@/components/workspace-loading'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { STOREFRONT_PRODUCTS, type StorefrontProductId } from '../../shared/product-order'
import './platform-product-visibility.css'

type Visibility = { hiddenProductIds: StorefrontProductId[]; version: number }

function VisibilityForm({ settings }: { settings: Visibility }) {
  const [saved, setSaved] = useState(settings)
  const [hiddenIds, setHiddenIds] = useState(settings.hiddenProductIds)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const changed = [...hiddenIds].sort().join(',') !== [...saved.hiddenProductIds].sort().join(',')
  const toggle = (id: StorefrontProductId) => {
    setHiddenIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])
    setError(''); setMessage('')
  }
  async function save() {
    if (busy || !changed || !note.trim()) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await api<Visibility>('/api/admin/product-visibility', { hiddenProductIds: hiddenIds, version: saved.version, note: note.trim() })
      setSaved(result); setHiddenIds(result.hiddenProductIds); setNote(''); setMessage('商品上下架设置已保存，主站已生效。')
    } catch (caught) { setError(errorMessage(caught)) }
    finally { setBusy(false) }
  }
  return <>
    <p className="admin-product-visibility-help">下架后，主站不再展示商品及其套餐，直达详情页显示已下架，且不能创建新订单。已有订单可继续查询和处理；代理商店的独立设置不受影响。</p>
    <div className="admin-table-scroll"><table className="admin-table admin-product-visibility-table"><thead><tr><th>商品</th><th>主站状态</th><th>操作</th></tr></thead><tbody>{STOREFRONT_PRODUCTS.map(product => {
      const hidden = hiddenIds.includes(product.id)
      const pending = hidden !== saved.hiddenProductIds.includes(product.id)
      return <tr key={product.id}><td><strong>{product.name}</strong></td><td><span className={'admin-pill' + (hidden ? '' : ' available')}>{hidden ? '已下架' : '展示中'}</span>{pending && <small>待保存</small>}</td><td><Button type="button" variant="outline" disabled={busy} onClick={() => toggle(product.id)} aria-label={`${hidden ? '上架' : '下架'} ${product.name}`}>{hidden ? '上架' : '下架'}</Button></td></tr>
    })}</tbody></table></div>
    <form className="admin-product-visibility-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <label htmlFor="admin-product-visibility-note">修改说明</label>
      <Input id="admin-product-visibility-note" value={note} onChange={event => setNote(event.target.value)} maxLength={500} placeholder="例如：暂停 Gmail、X Premium 等商品销售" disabled={busy} />
      <Button type="submit" disabled={busy || !changed || !note.trim()}>{busy ? '保存中…' : '保存上下架设置'}</Button>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {message && <p className="admin-success" role="status">{message}</p>}
    </form>
  </>
}

export function PlatformProductVisibility({ revision }: { revision: number }) {
  const { data, error, loading } = useResource<Visibility>('/api/admin/product-visibility', revision)
  return <section className="admin-panel"><div className="admin-panel-title"><h2>主站商品上下架</h2><span>修改后同步至前台</span></div>
    <Feedback error={error} loading={loading} data={data} />
    {data && <VisibilityForm key={`${revision}:${data.version}`} settings={data} />}
  </section>
}

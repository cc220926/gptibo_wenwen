import { useState } from 'react'
import { ArrowUpRight, Search } from 'lucide-react'
import { useResource } from '@/lib/use-resource'
import { Feedback } from '@/components/workspace-loading'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MANUAL_DELIVERY_STATES, type ManualDeliveryQueue } from '../../shared/manual-delivery'

const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })

export function ManualDeliveryPage({ revision, onSelect, onProducts }: { revision: number; onSelect: (id: string) => void; onProducts: () => void }) {
  const [state, setState] = useState('active'), [page, setPage] = useState(1)
  const [search, setSearch] = useState(''), [q, setQ] = useState('')
  const params = new URLSearchParams({ state, page: String(page), q })
  const resource = useResource<ManualDeliveryQueue>(`/api/admin/inventory/manual?${params}`, revision)
  const data = resource.data
  return <section className="admin-panel">
    <div className="admin-panel-title"><div><h2>人工交付工作台</h2><p className="admin-subtle">付款确认后进入队列，优先展示较早的订单。打开订单后可开始处理或填写交付结果。</p></div><Button variant="outline" onClick={onProducts}>上架人工商品 <ArrowUpRight size={15} /></Button></div>
    <form className="admin-filters" onSubmit={event => { event.preventDefault(); setQ(search); setPage(1) }}>
      <div className="admin-search"><Search size={16} /><Input value={search} maxLength={320} onChange={event => setSearch(event.target.value)} placeholder="搜索订单号或下单邮箱" aria-label="搜索人工交付订单" /></div>
      <select aria-label="人工交付状态" value={state} onChange={event => { setState(event.target.value); setPage(1) }}>
        <option value="active">待处理{data ? `（${data.counts.queued + data.counts.running}）` : ''}</option>
        {Object.entries(MANUAL_DELIVERY_STATES).map(([value, label]) => <option key={value} value={value}>{label}{data ? `（${data.counts[value as keyof typeof data.counts]}）` : ''}</option>)}
        <option value="all">全部人工交付</option>
      </select>
      <Button type="submit" variant="outline">查询</Button>
    </form>
    <Feedback {...resource} />
    {data && <>{data.rows.length ? <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>订单 / 下单时间</th><th>商品规格</th><th>下单邮箱</th><th>金额</th><th>交付状态</th><th>操作</th></tr></thead><tbody>{data.rows.map(row => <tr key={row.id}>
      <td><button className="admin-order-id" onClick={() => onSelect(row.id)}>{row.id}</button><small>{time(row.createdAt)}</small></td>
      <td>{row.productName}<small>{row.planName}</small></td><td>{row.customerEmail ?? '未留邮箱'}</td><td className="admin-numeric">¥{(row.priceCents / 100).toFixed(2)}</td>
      <td>{MANUAL_DELIVERY_STATES[row.state]}{row.refundHold && <small>售后处理中</small>}{row.refundedCents > 0 && <small>已退款 ¥{(row.refundedCents / 100).toFixed(2)}</small>}{row.redemptionBlocked && <small>已禁止兑换</small>}<small>{time(row.updatedAt)}</small></td>
      <td><Button variant="ghost" onClick={() => onSelect(row.id)}>{['queued', 'running'].includes(row.state) ? '处理交付' : '查看订单'} <ArrowUpRight size={14} /></Button></td>
    </tr>)}</tbody></table></div> : <div className="admin-empty"><Search size={25} /><h3>没有符合条件的人工交付订单</h3><p>已付款的人工商品会显示在这里，可切换状态查看暂停或已交付订单。</p></div>}
      <div className="admin-pagination"><span>共 {data.total} 条 · 第 {page} 页</span><div><Button variant="outline" disabled={resource.loading || page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button><Button variant="outline" disabled={resource.loading || page * 20 >= data.total} onClick={() => setPage(value => value + 1)}>下一页</Button></div></div>
    </>}
  </section>
}

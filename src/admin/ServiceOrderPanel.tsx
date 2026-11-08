import { useRef, useState } from 'react'
import type { ServerOrder } from '@/lib/use-store'
import { api, errorMessage } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Feedback } from '@/components/workspace-loading'

export function ServiceOrderPanel({ order, onUpdated }: { order: ServerOrder; onUpdated: () => void }) {
  const [value, setValue] = useState(''), [note, setNote] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), lock = useRef(false)
  const task = order.serviceDelivery
  if (!task) return null
  const canComplete = !task.provider && task.kind === 'manual' && ['queued', 'running'].includes(task.state) && order.paymentStatus === 'paid' && !order.refundHold && !order.refundedCents && !order.redemptionBlocked
  async function act(action: string) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await api(`/api/admin/inventory/orders/${order.id}`, { action, value, note, version: order.version }); setValue(''); setNote(''); onUpdated() }
    catch (e) { setError(errorMessage(e)) } finally { lock.current = false; setBusy(false) }
  }
  return <section className="admin-panel"><h3>{task.productName} · {task.provider === 'muse' ? 'Muse 自动采购交付' : task.kind === 'stock' ? '库存自动交付' : '人工服务交付'}</h3><p>任务状态：{({ reserved: '待付款预留', queued: '等待人工处理', running: '人工处理中', delivered: '已交付', expired: '预留已到期', review: '收款与库存待核对' } as Record<string, string>)[task.state] ?? task.state}</p>
    {task.provider === 'muse' && <><p>供货状态：{({ prepared: '等待确认付款与发起采购', creating: '正在提交原采购单', unknown: '原单结果待核对，请勿重复采购或退款', pending: '等待原单交付', succeeded: '原单已交付', failed: '供货明确失败，可从原订单处理售后' } as Record<string, string>)[task.supplierState ?? ''] ?? '待核对'}</p><Button variant="outline" disabled={busy} onClick={() => void act('sync')}>核对原采购单</Button></>}
    {!task.provider && task.state === 'review' && <p className="service-policy">订单到期后确认收款，原库存可能已释放。请核对收款、库存及退款情况，通过原订单处理售后，避免重复发货。</p>}
    {task.state === 'delivered' && <><p>邮件通知：{({ pending: '等待发送或重试', sending: '发送中', sent: '邮件服务已受理', review: '超过重试窗口，请核查邮件服务记录' } as Record<string, string>)[task.mailState]}</p>{order.delivery?.value && <details><summary>查看本订单交付内容</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{order.delivery.value}</pre></details>}{task.mailState === 'pending' && <Button variant="outline" disabled={busy} onClick={() => void act('retry-mail')}>重试原邮件</Button>}</>}
    {canComplete && <form className="service-form" onSubmit={e => { e.preventDefault(); void act('complete') }}><label htmlFor="service-result">交付结果（客户可见）</label><textarea id="service-result" required rows={4} maxLength={8192} value={value} onChange={e => setValue(e.target.value)} disabled={busy} /><label htmlFor="service-note">处理说明</label><textarea id="service-note" required rows={2} maxLength={500} value={note} onChange={e => setNote(e.target.value)} disabled={busy} /><div className="membership-delivery-actions">{task.state === 'queued' && <Button type="button" variant="outline" disabled={busy || !note.trim()} onClick={() => void act('start')}>开始处理</Button>}<Button type="submit" disabled={busy || !value.trim() || !note.trim()}>{busy ? '保存中…' : '确认交付并通知客户'}</Button></div></form>}<Feedback error={error} />
  </section>
}

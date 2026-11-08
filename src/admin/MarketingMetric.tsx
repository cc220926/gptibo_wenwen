import { useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { useResource } from '@/lib/use-resource'
import { Feedback } from '@/components/workspace-loading'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { MarketingMetric as Metric } from '../../shared/marketing-metric'
import './marketing-metric.css'

type Settings = Metric & { baseCount: number; newCompletedCount: number; automatic: boolean; autoCountSince: number | null; version: number }

function MetricForm({ settings }: { settings: Settings }) {
  const [saved, setSaved] = useState(settings)
  const [enabled, setEnabled] = useState(settings.enabled)
  const [automatic, setAutomatic] = useState(settings.automatic)
  const [displayText, setDisplayText] = useState(settings.displayText)
  const [displayCount, setDisplayCount] = useState(String(settings.baseCount))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const count = Number(displayCount)
  const valid = displayText.trim() === displayText && displayText.length >= 1 && displayText.length <= 120 && displayText.split('{count}').length === 2 && !/[\r\n<>]/.test(displayText) && /^\d+$/.test(displayCount) && Number.isSafeInteger(count) && count <= 999999
  const changed = enabled !== saved.enabled || automatic !== saved.automatic || displayText !== saved.displayText || count !== saved.baseCount
  async function save() {
    if (busy || !valid || !changed) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await api<Settings>('/api/admin/marketing-metric', { enabled, automatic, displayText, displayCount: count, version: saved.version })
      setSaved(result); setEnabled(result.enabled); setAutomatic(result.automatic); setDisplayText(result.displayText); setDisplayCount(String(result.baseCount)); setMessage('展示设置已保存，主站刷新后生效。')
    } catch (caught) { setError(errorMessage(caught)) }
    finally { setBusy(false) }
  }
  return <form className="admin-marketing-metric" onSubmit={event => { event.preventDefault(); void save() }}>
    <p>主站 ChatGPT 购买区域使用这里设置的文案和数值。开启自动累加后，以基础数值加上启用后新建并开通成功的本站 ChatGPT 订单；现有订单不重复计入，全额退款或账务冻结的订单不计入。</p>
    <label className="admin-marketing-metric-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy} />启用自定义展示</label>
    <label className="admin-marketing-metric-toggle"><input type="checkbox" checked={automatic} onChange={event => { const next = event.target.checked; if (saved.automatic) setDisplayCount(String(next ? saved.baseCount : saved.displayCount)); setAutomatic(next) }} disabled={busy} />自动累加新开通成功订单</label>
    <label htmlFor="marketing-metric-text">展示文案</label>
    <Input id="marketing-metric-text" value={displayText} onChange={event => setDisplayText(event.target.value)} maxLength={120} placeholder="例如：活动展示数：{count}" disabled={busy} />
    <small>用 {'{count}'} 标出数字的位置，必须出现一次。下方为后台示意预览。</small>
    <label htmlFor="marketing-metric-count">{automatic ? '历史基础数值' : '展示数值'}</label>
    <Input id="marketing-metric-count" type="number" min="0" max="999999" step="1" value={displayCount} onChange={event => setDisplayCount(event.target.value)} disabled={busy} />
    {saved.automatic && <small>启用后新增且当前有效的完成订单：{saved.newCompletedCount} 笔。关闭自动累加时，会把当前总数带入基础数值。</small>}
    <div className="admin-marketing-metric-preview">前台预览：{valid ? displayText.replace('{count}', String(count + (automatic && saved.automatic ? saved.newCompletedCount : 0))) : '请填写有效文案和数值'}<small>示意数字</small></div>
    <Button type="submit" disabled={busy || !valid || !changed}>{busy ? '保存中…' : '保存展示设置'}</Button>
    {error && <p className="admin-error" role="alert">{error}</p>}
    {message && <p className="admin-success" role="status">{message}</p>}
  </form>
}

export function MarketingMetric({ revision }: { revision: number }) {
  const { data, error, loading } = useResource<Settings>('/api/admin/marketing-metric', revision)
  return <section className="admin-panel"><div className="admin-panel-title"><h2>主站展示信息</h2><span>文案与数值可配置</span></div>
    <Feedback error={error} loading={loading} data={data} />
    {data && <MetricForm key={`${revision}:${data.version}`} settings={data} />}
  </section>
}

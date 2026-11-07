import { useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { useResource } from '@/lib/use-resource'
import { Feedback } from '@/components/workspace-loading'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { MarketingMetric as Metric } from '../../shared/marketing-metric'
import './marketing-metric.css'

type Settings = Metric & { version: number }

function MetricForm({ settings }: { settings: Settings }) {
  const [saved, setSaved] = useState(settings)
  const [enabled, setEnabled] = useState(settings.enabled)
  const [displayText, setDisplayText] = useState(settings.displayText)
  const [displayCount, setDisplayCount] = useState(String(settings.displayCount))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const count = Number(displayCount)
  const valid = displayText.trim() === displayText && displayText.length >= 1 && displayText.length <= 120 && displayText.split('{count}').length === 2 && !/[\r\n<>]/.test(displayText) && /^\d+$/.test(displayCount) && Number.isSafeInteger(count) && count <= 999999
  const changed = enabled !== saved.enabled || displayText !== saved.displayText || count !== saved.displayCount
  async function save() {
    if (busy || !valid || !changed) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await api<Settings>('/api/admin/marketing-metric', { enabled, displayText, displayCount: count, version: saved.version })
      setSaved(result); setEnabled(result.enabled); setDisplayText(result.displayText); setDisplayCount(String(result.displayCount)); setMessage('展示设置已保存，主站刷新后生效。')
    } catch (caught) { setError(errorMessage(caught)) }
    finally { setBusy(false) }
  }
  return <form className="admin-marketing-metric" onSubmit={event => { event.preventDefault(); void save() }}>
    <p>主站 ChatGPT 购买区域使用这里设置的文案和数值。启用后会替换原有的真实下单窗口访客数；关闭时仍显示原有统计。手动数值不会随实际订单变化。</p>
    <label className="admin-marketing-metric-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy} />启用自定义展示</label>
    <label htmlFor="marketing-metric-text">展示文案</label>
    <Input id="marketing-metric-text" value={displayText} onChange={event => setDisplayText(event.target.value)} maxLength={120} placeholder="例如：活动展示数：{count}" disabled={busy} />
    <small>用 {'{count}'} 标出数字的位置，必须出现一次。前台会注明这是商家设置的展示信息。</small>
    <label htmlFor="marketing-metric-count">展示数值</label>
    <Input id="marketing-metric-count" type="number" min="0" max="999999" step="1" value={displayCount} onChange={event => setDisplayCount(event.target.value)} disabled={busy} />
    <div className="admin-marketing-metric-preview">前台预览：{valid ? displayText.replace('{count}', displayCount) : '请填写有效文案和数值'}<small>商家设置的展示信息 · 非实时成交统计</small></div>
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

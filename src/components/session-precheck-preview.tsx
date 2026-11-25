import { useState } from 'react'
import { ArrowUpRight, Check, Moon, RotateCcw, ShieldCheck, Sun } from 'lucide-react'
import { LiveCheckout } from './live-checkout'
import { BrandMark } from './brand'
import type { ServerOrder } from '@/lib/use-store'
import type { PlanId } from '@/lib/demo-orders'
import { RequestError, type api } from '@/lib/api'
import type { SessionPrecheck } from './session-precheck'
import '@/App.css'
import '@/styles/motion.css'
import '@/styles/session-precheck-preview.css'

const cases: { id: string; label: string; note: string; state: SessionPrecheck['state']; code: string }[] = [
  { id: 'saved-retry', label: '使用原资料重试', note: '订阅未到期，保留原订单', state: 'wait', code: 'web_wait_expiry' },
  { id: 'saved-opt-in', label: '选择保存资料', note: '默认勾选，可取消加密保存', state: 'eligible', code: 'web_wait_expiry' },
  { id: 'saved-unknown', label: '核对原提交', note: '结果未确认，只核对同一笔提交', state: 'unknown', code: 'check_unavailable' },
  { id: 'saved-expired', label: '保存资料已失效', note: '仍可提交新的 Session', state: 'expired', code: 'locally_expired' },
  { id: 'replacement-failed', label: '重新提交 Session', note: '失败后重新粘贴资料', state: 'wait', code: 'web_wait_expiry' },
  { id: 'replacement-expired', label: '资料已过期', note: '获取新 Session 后重新提交', state: 'expired', code: 'locally_expired' },
  { id: 'pass', label: '检测通过', note: 'PHP 网页 Plus 升级 Pro', state: 'eligible', code: 'php_web_plus_upgrade' },
  { id: 'store', label: '商店订阅等待期', note: '到期后还未满 72 小时', state: 'wait', code: 'store_wait_72h' },
  { id: 'web', label: '网页订阅未到期', note: '普通续费需要等待', state: 'wait', code: 'web_wait_expiry' },
  { id: 'expired', label: 'Session 已过期', note: '引导重新获取登录资料', state: 'expired', code: 'locally_expired' },
  { id: 'invalid', label: '校验无效', note: '官方 401／403', state: 'invalid', code: 'upstream_blocked' },
  { id: 'currency', label: '升级条件不符', note: '原订阅账单为非 PHP', state: 'ineligible', code: 'upgrade_requires_php' },
  { id: 'limited', label: '请求限流', note: '自动提交，由上游继续判断', state: 'deferred', code: 'rate_limited' },
  { id: 'timeout', label: '检测超时', note: '等待 10 秒后自动提交', state: 'deferred', code: 'query_timeout' },
  { id: 'unknown', label: '信息不足', note: '资料不全，提交上游判断', state: 'deferred', code: 'business_evidence_missing' },
]
const sample = JSON.stringify({ user: { email: 'demo@example.com' }, accessToken: 'demo-local-synthetic-only', expires: '2099-01-01T00:00:00Z' }, null, 2)
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException('cancelled', 'AbortError')); return }
  const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
  const timer = setTimeout(finish, ms)
  const abort = () => { clearTimeout(timer); reject(new DOMException('cancelled', 'AbortError')) }
  signal?.addEventListener('abort', abort, { once: true })
})
function PreviewOrder({ selected }: { selected: typeof cases[number] }) {
  const unknown = selected.id === 'saved-unknown'
  const expired = selected.id === 'saved-expired' || selected.id === 'replacement-expired'
  const saved = ['saved-retry', 'saved-unknown', 'saved-expired'].includes(selected.id)
  const replacement = selected.id.startsWith('replacement-') || saved
  const retentionAvailable = saved || selected.id === 'saved-opt-in'
  const plan: PlanId = replacement || retentionAvailable || selected.id === 'web' || selected.id === 'store' ? 'plus' : 'pro-20x'
  const [submitted, setSubmitted] = useState(false)
  const [order, setOrder] = useState<ServerOrder>(() => {
    const now = Date.now(), attemptId = crypto.randomUUID()
    return {
      id: 'LOCAL-PREVIEW', plan, planName: plan === 'plus' ? 'Plus' : 'Pro 10×', price: 100, createdAt: now,
      updatedAt: now, version: 1, mode: 'live', status: unknown ? 'processing' : replacement ? 'failed' : 'session', paymentStatus: 'paid',
      fulfillment: {
        canRetainCredential: retentionAvailable,
        savedCredential: saved ? { attemptId, savedAt: now, retainUntil: now + 30 * 86400000, expired, canReuse: !expired } : null,
        failureCode: unknown || !replacement ? null : expired ? 'session_invalid' : 'account_has_subscription',
        precheckRequired: !replacement && !retentionAvailable,
        paymentUrl: null, expiresAt: null, rechargeStatus: unknown ? 'unknown' : replacement ? 'failed' : null,
        retryKey: unknown ? attemptId : null, retryMode: unknown ? 'session' : null, canSubmit: true,
        message: unknown || !replacement ? null : expired
          ? '登录凭据已失效，请重新获取 Session 后提交，无需再次付款。'
          : '该账号已有有效订阅，本次未充值。当前套餐有效至 2026-11-28 12:06（平台显示时间）。核对到期后，可在本订单重新提交充值资料，无需再次付款。',
        accountEmailMasked: replacement ? 'd***@example.com' : null, finishedAt: null,
      },
    }
  })
  const transport: typeof api = async <T,>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> => {
    if (path.endsWith('/session-precheck')) {
      await sleep(selected.id === 'timeout' ? 10000 : 1800, signal)
      return { precheck: { state: selected.state, code: selected.code, target: plan, eligibleAt: selected.state === 'wait' ? new Date(Date.now() + (selected.id === 'store' ? 24 : 12) * 3600000).toISOString() : null, receipt: ['eligible', 'deferred'].includes(selected.state) ? 'local-preview-no-authority' : undefined } } as T
    }
    const request = data as { action?: string; key?: string; sourceAttemptId?: string; retainCredential?: boolean; credential?: unknown } | undefined
    if (request?.action === 'retry-saved') {
      const previous = order.fulfillment?.savedCredential
      if (!previous?.canReuse || request.sourceAttemptId !== previous.attemptId || !request.key ||
        (unknown ? request.key !== previous.attemptId : request.key === previous.attemptId) || 'credential' in request)
        throw new RequestError('演示请求无效，请重新选择场景。', 409)
    }
    if (request?.action === 'submit' || request?.action === 'retry-saved') {
      await sleep(1100, signal); setSubmitted(true)
      const savedCredential = request.action === 'submit' && request.retainCredential && request.key
        ? { attemptId: request.key, savedAt: Date.now(), retainUntil: Date.now() + 30 * 86400000, expired: false, canReuse: true }
        : null
      if (selected.id === 'saved-opt-in' && request.action === 'submit') return { order: { ...order, status: 'failed', fulfillment: {
        ...order.fulfillment, savedCredential, canSubmit: true, rechargeStatus: 'failed', failureCode: 'account_has_subscription',
        message: '该账号已有有效订阅，核对到期后可在原订单继续处理，无需再次付款。',
      } } } as T
      return { order: { ...order, status: 'processing', fulfillment: {
        ...order.fulfillment, canSubmit: false, rechargeStatus: 'queued', progressStage: 'queued', retryKey: null,
      } } } as T
    }
    return { order } as T
  }
  return <div className="precheck-preview-order"><div className="precheck-preview-receipt"><span>完成付款 · 连接账号</span><strong>ChatGPT {order.planName}<ArrowUpRight size={16} /></strong></div>
    <LiveCheckout order={order} open onOrderUpdated={setOrder} onOrders={() => {}} transport={transport} initialSession={replacement ? '' : sample} />
    <div className="precheck-preview-proof"><ShieldCheck size={14} /><span>{submitted ? '演示请求已处理，未发起真实充值。' : replacement ? '此订单由本地模拟，可体验原资料重试或重新提交。' : '演示账号已填入。勾选确认后，点击按钮体验完整流程。'}</span></div>
  </div>
}
export default function SessionPrecheckPreview() {
  const [selected, setSelected] = useState(cases[0])
  const [revision, setRevision] = useState(0)
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'))
  return <main className="precheck-preview"><header><div><BrandMark /><span>GPTibo <small>本地体验</small></span></div><button type="button" onClick={() => { document.documentElement.classList.toggle('dark'); setDark(!dark) }} aria-label="切换深浅色">{dark ? <Sun size={18} /> : <Moon size={18} />}</button></header>
    <div className="precheck-preview-intro"><span>ACCOUNT CHECK · LOCAL PREVIEW</span><h1>先确认账号，<br />再安心充值。</h1><p>新的 Session 提交体验。请选择一种情况，查看客户会收到的提示。</p></div>
    <div className="precheck-preview-grid"><aside><div className="precheck-preview-label">体验不同结果 <span>{cases.length} 种情况</span></div>{cases.map(item => <button type="button" key={item.id} className="precheck-preview-case" aria-pressed={selected.id === item.id} onClick={() => { setSelected(item); setRevision(v => v + 1) }}><span><strong>{item.label}</strong><small>{item.note}</small></span>{selected.id === item.id && <Check size={16} />}</button>)}<button type="button" className="precheck-preview-reset" onClick={() => setRevision(v => v + 1)}><RotateCcw size={14} />重新体验当前情况</button><p className="precheck-preview-note">仅本地模拟，不读取真实账号，不发起支付或充值。本页不代表真实订单状态。</p></aside><PreviewOrder key={`${selected.id}:${revision}`} selected={selected} /></div>
  </main>
}

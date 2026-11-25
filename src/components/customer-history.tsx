import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Mail, Pause, Play } from 'lucide-react'
import { customerHistoryFeed, type CustomerHistoryView } from '@/lib/customer-history'
import { useStorefrontI18n } from '@/lib/storefront-i18n'
import { storefrontScopeHeaders } from '@/lib/storefront-routing'
import '@/styles/customer-history.css'

export function CustomerHistory({ partner }: { partner?: string }) {
  const { locale } = useStorefrontI18n()
  const english = locale === 'en'
  const [view, setView] = useState<CustomerHistoryView | null>(null)
  const [paused, setPaused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [visible, setVisible] = useState(() => !document.hidden)
  const [inViewport, setInViewport] = useState(() => !('IntersectionObserver' in window))
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [moving, setMoving] = useState(false)
  const section = useRef<HTMLElement>(null)
  const feed = useRef<ReturnType<typeof customerHistoryFeed> | null>(null)
  const hasData = Boolean(view)

  useEffect(() => {
    const controller = new AbortController()
    const session = customerHistoryFeed({
      publish: setView,
      request: async cursor => {
        const query = new URLSearchParams({ product: 'chatgpt', cursor: String(cursor) })
        if (partner) { query.set('scope', 'platform'); query.set('partner', partner) }
        const response = await fetch('/api/customer-history?' + query, {
          credentials: 'same-origin', headers: storefrontScopeHeaders(),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        })
        if (!response.ok) throw new Error('Customer history unavailable')
        return response.json()
      },
    })
    feed.current = session
    return () => { session.stop(); controller.abort(); feed.current = null }
  }, [partner])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const motionChanged = () => { setReducedMotion(media.matches); setMoving(false) }
    const visibilityChanged = () => setVisible(!document.hidden)
    media.addEventListener('change', motionChanged)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => { media.removeEventListener('change', motionChanged); document.removeEventListener('visibilitychange', visibilityChanged) }
  }, [])

  useEffect(() => {
    if (!hasData || !section.current) return
    if (!('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver(entries => setInViewport(entries.some(entry => entry.isIntersecting)), { threshold: 0 })
    observer.observe(section.current)
    return () => observer.disconnect()
  }, [hasData])

  const shouldPause = paused || hovered || focused || !visible || !inViewport || reducedMotion
  useEffect(() => {
    if (!view?.canAdvance || moving || shouldPause) return
    const timer = window.setTimeout(() => setMoving(true), 3200)
    return () => window.clearTimeout(timer)
  }, [view, moving, shouldPause])

  if (!view) return null
  const next = () => { feed.current?.advance(); setMoving(false) }
  const toggleLabel = english ? paused ? 'Resume scrolling' : 'Pause scrolling' : paused ? '继续滚动' : '暂停滚动'
  return <section ref={section} className="customer-history page-width" aria-labelledby="customer-history-title"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}>
    <div className="customer-history-heading"><h2 id="customer-history-title">{english ? 'Past paying customers' : '历史已付款客户'}</h2><span>{english ? 'Masked emails' : '邮箱已脱敏'}</span></div>
    <div className="customer-history-window" style={{ height: 'var(--customer-history-row-height)' }}>
      <ul className={'customer-history-list' + (moving ? ' is-moving' : '')} aria-live="off" style={{ animationPlayState: shouldPause ? 'paused' : 'running' }}
        onAnimationEnd={event => { if (event.target === event.currentTarget && event.animationName === 'customer-history-step') next() }}>
        {view.emails.map((email, index) => <li key={`${index}:${email}`} aria-hidden={index >= 1 || undefined}><Mail size={14} aria-hidden="true" /><span className="customer-history-email" title={email}>{email}</span><span className="customer-history-plan">ChatGPT Plus</span></li>)}
      </ul>
    </div>
    {view.canAdvance && <div className="customer-history-controls">
      {!reducedMotion && <button type="button" onClick={() => setPaused(value => !value)} aria-label={toggleLabel} title={toggleLabel} aria-pressed={paused}>{paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}</button>}
      <button type="button" onClick={next} aria-label={english ? 'Show next customer' : '查看下一位客户'} title={english ? 'Show next customer' : '查看下一位客户'}><ChevronDown size={16} aria-hidden="true" /></button>
    </div>}
  </section>
}

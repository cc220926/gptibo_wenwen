export const PRESENCE_WINDOW_MS = 60_000
export const PRESENCE_POLL_MS = 30_000

type Page = Pick<Document, 'hidden' | 'hasFocus' | 'addEventListener' | 'removeEventListener'>
type WindowEvents = Pick<Window, 'addEventListener' | 'removeEventListener'>
type PresenceResponse = { others: number; windowSeconds: number }
type Options = {
  enabled: boolean
  checkout: boolean
  request: (activity?: { tabId: string; active: boolean }) => Promise<unknown>
  publish: (others: number | null) => void
  interaction: (event: Event) => boolean
  page?: Page
  win?: WindowEvents
  now?: () => number
  newId?: () => string
}

export function validPresence(value: unknown): value is PresenceResponse {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<PresenceResponse>
  return Number.isSafeInteger(data.others) && data.others! >= 0 && data.windowSeconds === PRESENCE_WINDOW_MS / 1000
}

// An activity ID belongs to one focused, non-idle checkout visit. A closed ID is
// never reused: the server can reject a heartbeat that arrives after its leave.
export function checkoutPresence({ enabled, checkout: initiallyCheckingOut, request, publish, interaction, page = document, win = window, now = Date.now, newId = () => crypto.randomUUID() }: Options) {
  if (!enabled) {
    publish(null)
    return { setCheckout: (_checkout: boolean) => {}, stop: () => {} }
  }
  let checkout = initiallyCheckingOut
  let focused = page.hasFocus()
  let lastActivity = now()
  let cycle: string | null = null
  let stopped = false
  let running = false
  let rerun = false
  let revision = 0
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  const visible = () => !page.hidden && focused
  const hide = () => { clearTimeout(expiryTimer); publish(null) }
  const leave = (tabId: string) => { void request({ tabId, active: false }).catch(() => { /* Server TTL bounds a failed leave. */ }) }
  const updateCycle = () => {
    const active = checkout && visible() && now() - lastActivity < PRESENCE_WINDOW_MS
    if (active && cycle === null) { cycle = newId(); revision++ }
    if (!active && cycle !== null) { const old = cycle; cycle = null; revision++; leave(old) }
  }
  const poll = async () => {
    clearTimeout(pollTimer)
    if (stopped || !visible()) return
    updateCycle()
    if (running) { rerun = true; return }
    running = true
    const version = revision, started = now(), tabId = cycle
    try {
      const result = await request(tabId ? { tabId, active: true } : undefined)
      if (!stopped && visible() && revision === version) {
        hide()
        // A late response cannot extend a stale observation's display lifetime.
        const remaining = PRESENCE_WINDOW_MS - (now() - started)
        if (validPresence(result) && result.others > 0 && remaining > 0) {
          publish(result.others)
          expiryTimer = setTimeout(hide, remaining)
        }
      }
    } catch {
      if (!stopped && revision === version) hide()
    } finally {
      running = false
      if (!stopped && visible()) {
        if (rerun) { rerun = false; void poll() }
        else pollTimer = setTimeout(() => { void poll() }, PRESENCE_POLL_MS)
      }
    }
  }
  const scheduleIdle = () => {
    clearTimeout(idleTimer)
    if (checkout) idleTimer = setTimeout(() => { updateCycle(); void poll() }, Math.max(0, lastActivity + PRESENCE_WINDOW_MS - now()))
  }
  const updateVisibility = () => {
    revision++
    updateCycle()
    clearTimeout(pollTimer)
    hide()
    if (visible()) void poll()
  }
  const focus = () => { focused = true; updateVisibility() }
  const blur = () => { focused = false; updateVisibility() }
  const activity = (event: Event) => {
    if (!checkout || !visible() || !interaction(event)) return
    lastActivity = now()
    const previous = cycle
    updateCycle()
    scheduleIdle()
    if (previous !== cycle) void poll()
  }
  const pagehide = () => { focused = false; updateVisibility() }
  const pageshow = () => { focused = page.hasFocus(); updateVisibility() }
  page.addEventListener('visibilitychange', updateVisibility)
  page.addEventListener('pointerdown', activity)
  page.addEventListener('keydown', activity)
  page.addEventListener('touchstart', activity, { passive: true })
  win.addEventListener('focus', focus)
  win.addEventListener('blur', blur)
  win.addEventListener('pagehide', pagehide)
  win.addEventListener('pageshow', pageshow)
  scheduleIdle()
  void poll()
  return {
    setCheckout(next: boolean) {
      if (stopped || checkout === next) return
      checkout = next
      if (next) lastActivity = now()
      updateCycle()
      scheduleIdle()
      void poll()
    },
    stop() {
      if (stopped) return
      stopped = true
      revision++
      clearTimeout(pollTimer); clearTimeout(idleTimer); clearTimeout(expiryTimer)
      if (cycle) { leave(cycle); cycle = null }
      page.removeEventListener('visibilitychange', updateVisibility)
      page.removeEventListener('pointerdown', activity)
      page.removeEventListener('keydown', activity)
      page.removeEventListener('touchstart', activity)
      win.removeEventListener('focus', focus)
      win.removeEventListener('blur', blur)
      win.removeEventListener('pagehide', pagehide)
      win.removeEventListener('pageshow', pageshow)
      hide()
    },
  }
}

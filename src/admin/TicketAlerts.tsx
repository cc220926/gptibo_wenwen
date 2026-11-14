import { useEffect, useRef, useState } from 'react'
import { Bell, Volume2, VolumeX } from 'lucide-react'
import { api, errorMessage, RequestError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import '@/components/ticket-workspace.css'

// `available: false` means this backend has no such workspace (Workers has no agent tickets).
type Summary = { version: number; pending: number; available?: boolean }
type Kind = 'tickets' | 'refunds' | 'manual'
const kinds: Kind[] = ['tickets', 'refunds', 'manual']
const endpoints: Record<Kind, string> = { tickets: '/api/admin/tickets/notifications', refunds: '/api/admin/refunds/notifications', manual: '/api/admin/inventory/manual/notifications' }
const spoken: Partial<Record<Kind, string>> = { refunds: '您有一单退款待处理', manual: '您有一单人工交付待处理' }
const errorLabels: Record<Kind, string> = { tickets: '工单提醒', refunds: '退款提醒', manual: '人工交付提醒' }
const empty = { tickets: '', refunds: '', manual: '' }
const unseenNone = { tickets: false, refunds: false, manual: false }

export function TicketAlerts({ onOpen, onRefunds, onManual }: { onOpen: () => void; onRefunds: () => void; onManual: () => void }) {
  const [summaries, setSummaries] = useState<Partial<Record<Kind, Summary>>>({})
  const [enabled, setEnabled] = useState(false)
  const [audioError, setAudioError] = useState('')
  const [errors, setErrors] = useState<Record<Kind, string>>(empty)
  const [unseen, setUnseen] = useState<Record<Kind, boolean>>(unseenNone)
  const audio = useRef<AudioContext | null>(null)
  const speech = useRef<SpeechSynthesisUtterance | null>(null)
  const sound = useRef(false)
  const mounted = useRef(false)
  const versions = useRef<Partial<Record<Kind, number>>>({})
  function stopSpeech() {
    if (speech.current) {
      speech.current.onerror = null
      speech.current = null
      window.speechSynthesis.cancel()
    }
  }
  function audioFailed(message: string) {
    if (!mounted.current) return
    sound.current = false; setEnabled(false); setAudioError(message)
    stopSpeech()
  }
  function announce(text: string) {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) throw new Error('speech unavailable')
    stopSpeech()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    const voices = window.speechSynthesis.getVoices()
    const voice = voices.find(v => /^zh[-_]CN$/i.test(v.lang)) || voices.find(v => /^zh/i.test(v.lang))
    if (voice) utterance.voice = voice
    utterance.onend = () => { if (speech.current === utterance) speech.current = null }
    utterance.onerror = event => {
      if (speech.current === utterance && event.error !== 'canceled' && event.error !== 'interrupted') audioFailed('语音播放失败，请检查设备中文语音和浏览器声音权限后重新开启。')
    }
    speech.current = utterance
    window.speechSynthesis.resume()
    window.speechSynthesis.speak(utterance)
  }
  async function chime() {
    const context = audio.current
    if (!context) return
    await context.resume()
    if (!sound.current) return
    if (context.state !== 'running') throw new Error('audio blocked')
    for (const [offset, frequency] of [[0, 660], [0.22, 880]]) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const start = context.currentTime + offset
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.16, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3)
      oscillator.connect(gain); gain.connect(context.destination)
      oscillator.start(start); oscillator.stop(start + 0.32)
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
    }
  }
  useEffect(() => {
    mounted.current = true
    let stopped = false
    const controller = new AbortController()
    const timers: Partial<Record<Kind, ReturnType<typeof setTimeout>>> = {}
    async function poll(kind: Kind) {
      let again = true
      try {
        const next = await api<Summary>(endpoints[kind], undefined, controller.signal)
        if (stopped) return
        // A workspace this backend does not provide is hidden and no longer polled.
        if (next.available === false) again = false
        const previous = versions.current[kind]
        const changed = next.available !== false && previous !== undefined && next.version > previous
        versions.current[kind] = next.version
        setSummaries(current => ({ ...current, [kind]: next }))
        setErrors(current => ({ ...current, [kind]: '' }))
        if (changed) {
          setUnseen(current => ({ ...current, [kind]: true }))
          if (sound.current) {
            try {
              const text = spoken[kind]
              if (text) announce(text)
              else await chime()
            } catch { if (!stopped) audioFailed('声音播放失败，请检查浏览器声音权限后重新开启。') }
          }
        }
      } catch (e) {
        if (stopped) return
        // A backend without this workspace (Go has no manual queue) hides the item.
        if (kind !== 'refunds' && e instanceof RequestError && e.status === 404) {
          again = false
          setSummaries(current => ({ ...current, [kind]: { version: 0, pending: 0, available: false } }))
          setErrors(current => ({ ...current, [kind]: '' }))
        } else setErrors(current => ({ ...current, [kind]: errorMessage(e) }))
      }
      finally { if (!stopped && again) timers[kind] = setTimeout(() => { void poll(kind) }, 15000) }
    }
    for (const kind of kinds) void poll(kind)
    return () => {
      stopped = true; mounted.current = false; controller.abort(); Object.values(timers).forEach(clearTimeout)
      sound.current = false; stopSpeech(); void audio.current?.close(); audio.current = null
    }
  }, [])
  function toggle() {
    if (sound.current) { sound.current = false; setEnabled(false); stopSpeech(); return }
    try {
      audio.current ??= new AudioContext()
      sound.current = true; setEnabled(true); setAudioError('')
      // Start speech within the click gesture so browsers can unlock playback.
      announce('提醒已开启')
      void chime().catch(() => audioFailed('无法播放提示音，请检查浏览器声音权限后重试。'))
    } catch { audioFailed('无法播放声音，请检查浏览器是否支持中文语音并允许声音后重试。') }
  }
  const tickets = summaries.tickets?.available !== false
  const manual = summaries.manual?.available !== false
  const shown = kinds.filter(kind => summaries[kind]?.available !== false)
  const connectionError = shown.filter(kind => errors[kind]).map(kind => `${errorLabels[kind]}连接中断：${errors[kind]}`).join('；')
  const label = (kind: Kind) => {
    const s = summaries[kind]
    if (kind === 'tickets') return unseen.tickets ? '收到新的代理工单消息' : s ? `待处理工单 ${s.pending} 条` : '工单提醒'
    if (kind === 'refunds') return unseen.refunds ? '收到新的退款申请' : s ? `待处理退款 ${s.pending} 单` : '退款提醒'
    return unseen.manual ? '收到新的人工交付订单' : s ? `待人工交付 ${s.pending} 单` : '人工交付提醒'
  }
  const open = (kind: Kind) => { setUnseen(current => ({ ...current, [kind]: false })); (kind === 'tickets' ? onOpen : kind === 'refunds' ? onRefunds : onManual)() }
  const count = (kind: Kind) => summaries[kind] ? ` (${summaries[kind]!.pending})` : ''
  return <section className="ticket-alert" aria-label="后台待办提醒"><div><strong><Bell size={15} className="inline" /> {shown.map(label).join(' · ')}</strong><p role="status">{connectionError || audioError || (enabled ? `声音已开启 · ${tickets ? '工单响铃，' : ''}退款${manual ? '与人工交付' : ''}语音播报；保持后台打开，约 15 秒检查一次。` : `点击开启并试听：新的退款${manual ? '与人工交付订单' : '申请'}会语音播报。`)}</p></div><div className="ticket-alert-actions"><Button variant="outline" size="sm" onClick={toggle}>{enabled ? <VolumeX size={14} /> : <Volume2 size={14} />}{enabled ? '关闭声音' : '开启声音提醒'}</Button>{tickets && <Button size="sm" onClick={() => open('tickets')}>查看工单{count('tickets')}</Button>}<Button variant="outline" size="sm" onClick={() => open('refunds')}>查看退款{count('refunds')}</Button>{manual && <Button variant="outline" size="sm" onClick={() => open('manual')}>人工交付{count('manual')}</Button>}</div></section>
}

import { useRef, type PointerEvent } from 'react'
import { ArrowUpRight, Check, UserRound } from 'lucide-react'
import '@/styles/gpt-account-scene.css'

/** Decorative product illustration; never contains a buyer's actual account. */
export function GptAccountScene({ large = false }: { large?: boolean }) {
  const scene = useRef<HTMLDivElement>(null)
  function move(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'mouse' || !scene.current) return
    const bounds = event.currentTarget.getBoundingClientRect()
    scene.current.style.setProperty('--account-x', String((event.clientX - bounds.left) / bounds.width * 2 - 1))
    scene.current.style.setProperty('--account-y', String((event.clientY - bounds.top) / bounds.height * 2 - 1))
  }
  function reset() {
    scene.current?.style.setProperty('--account-x', '0')
    scene.current?.style.setProperty('--account-y', '0')
  }
  return <div ref={scene} className={'gpt-account-scene' + (large ? ' large' : '')} aria-hidden="true" onPointerMove={move} onPointerLeave={reset}>
    <div className="gpt-account-halo" />
    <div className="gpt-account-back"><span>ChatGPT</span><span>PLUS <ArrowUpRight size={15} /></span></div>
    <div className="gpt-account-float"><div className="gpt-account-card">
      <div className="gpt-account-card-top"><img src="/brands/openai.svg" alt="" width="28" height="28" /><span>PLUS</span></div>
      <div className="gpt-account-card-title"><strong>ChatGPT Plus</strong><span>成品账号</span></div>
      <div className="gpt-account-card-bottom"><span><UserRound size={13} />账号资料 · 原订单领取</span><span className="gpt-account-check"><Check size={12} /></span></div>
      <div className="gpt-account-sheen" />
    </div></div>
    <span className="gpt-account-chip"><span />人工交付</span>
  </div>
}

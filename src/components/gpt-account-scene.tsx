import { useId } from 'react'
import '@/styles/gpt-account-scene.css'

const plusShape = 'M55 12H79Q86 12 86 19V48H115Q122 48 122 55V79Q122 86 115 86H86V115Q86 122 79 122H55Q48 122 48 115V86H19Q12 86 12 79V55Q12 48 19 48H48V19Q48 12 55 12Z'

/** Decorative artwork. Region labels must not imply an unconfigured account region. */
export function GptAccountScene({ large = false }: { large?: boolean }) {
  const id = 'account-plus-' + useId().replaceAll(':', '')
  return <div className={'gpt-account-scene' + (large ? ' large' : '')} aria-hidden="true">
    <div className="gpt-account-halo" />
    <div className="gpt-account-ground" />
    <div className="gpt-account-float"><div className="gpt-account-card">
      <div className="gpt-account-face">
        <div className="gpt-account-card-top"><span>PLUS EDITION</span><span className="gpt-account-badge"><i />1M</span></div>
        <div className="gpt-account-card-title"><strong>plus</strong><span>成品账号</span></div>
        <svg className="gpt-account-plus" viewBox="0 0 140 145" fill="none">
          <defs>
            <linearGradient id={id + '-depth'} x1="28" y1="20" x2="116" y2="135" gradientUnits="userSpaceOnUse"><stop stopColor="#bcb6d2" /><stop offset=".5" stopColor="#8c829f" /><stop offset="1" stopColor="#b1a6c3" /></linearGradient>
            <linearGradient id={id + '-face'} x1="23" y1="24" x2="116" y2="112" gradientUnits="userSpaceOnUse"><stop stopColor="#f0edf8" /><stop offset=".33" stopColor="#bfb6d7" /><stop offset=".48" stopColor="#f5f4ff" /><stop offset=".66" stopColor="#c4d4ed" /><stop offset="1" stopColor="#b8afcf" /></linearGradient>
            <linearGradient id={id + '-edge'} x1="25" y1="14" x2="103" y2="126" gradientUnits="userSpaceOnUse"><stop stopColor="white" /><stop offset=".55" stopColor="#eeeafb" /><stop offset="1" stopColor="#c6bfd7" /></linearGradient>
          </defs>
          <path d={plusShape} transform="translate(5 8)" fill={'url(#' + id + '-depth)'} stroke="#9e94b1" strokeWidth="1.4" />
          <path d={plusShape} transform="translate(2 3)" fill="#c8c0d9" />
          <path d={plusShape} fill={'url(#' + id + '-face)'} stroke={'url(#' + id + '-edge)'} strokeWidth="1.8" />
          <path d="M55 17H78Q81 17 81 21V51M43 53H20Q17 53 17 57V77M53 91V113" stroke="white" strokeOpacity=".7" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <div className="gpt-account-card-bottom"><span>DIGITAL ACCOUNT</span><span>PLUS / 1M</span></div>
      </div>
    </div></div>
  </div>
}

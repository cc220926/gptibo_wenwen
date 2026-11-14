import '@/styles/codex-credits.css'

export function CodexCreditsScene({ large = false }: { large?: boolean }) {
  return <div className={'codex-credits-scene' + (large ? ' large' : '')} aria-hidden="true">
    <img className="codex-credits-float" src="/products/codex-credits.svg" alt="" width="640" height="410" decoding="async" />
  </div>
}

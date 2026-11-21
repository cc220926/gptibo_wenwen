import { useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, ClipboardList, CreditCard, Package, Play } from 'lucide-react'
import { useStorefrontI18n } from '@/lib/storefront-i18n'
import { homeGuideCopy } from '@/lib/home-guidance'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

function GuideScene({ step, preview = false }: { step: number; preview?: boolean }) {
  const { locale } = useStorefrontI18n()
  const copy = homeGuideCopy(locale)
  const Icon = [Package, CreditCard, ClipboardList][step]
  return <div className={'home-guide-scene' + (preview ? ' home-guide-scene-preview' : '')} aria-hidden="true">
    <div className="home-guide-window">
      <div className="home-guide-window-bar"><span><i /><i /><i /></span><small>{copy.preview}</small></div>
      <div className="home-guide-window-body">
        <div className="home-guide-mini-progress">{copy.shortSteps.map((label, index) => <span className={index <= step ? 'current' : ''} key={label}><i>{index < step ? <Check size={10} /> : index + 1}</i>{label}</span>)}</div>
        <div className="home-guide-mini-order"><span className="home-guide-scene-icon"><Icon size={24} strokeWidth={1.5} /></span><div><strong>{copy.steps[step].scene}</strong><small>{copy.steps[step].note}</small></div><span className="home-guide-mini-lines"><i /><i /></span></div>
      </div>
    </div>
    {preview && <span className="home-guide-play"><Play size={23} fill="currentColor" /></span>}
  </div>
}

export function HomeGuidance() {
  const { locale } = useStorefrontI18n()
  const copy = homeGuideCopy(locale)
  const [demoOpen, setDemoOpen] = useState(false)
  const [step, setStep] = useState(0)
  const title = useRef<HTMLHeadingElement>(null)
  const openDemo = () => { setStep(0); setDemoOpen(true) }
  const finish = () => {
    setDemoOpen(false)
    document.getElementById('catalog-products')?.scrollIntoView({ behavior: 'auto', block: 'start' })
  }
  return <>
    <section className="home-guide page-width" aria-label={copy.region}>
      <header className="home-guide-header"><h2>{copy.title}</h2><span className="home-guide-current-label">{copy.demo}</span></header>
      <div className="home-guide-demo-panel">
        <button className="home-guide-preview" type="button" onClick={openDemo} aria-label={copy.openDemo}><GuideScene step={1} preview /></button>
        <div className="home-guide-copy"><h3>{copy.intro}</h3><ol className="home-guide-short-steps">{copy.shortSteps.map((label, index) => <li key={label}><span>{String(index + 1).padStart(2, '0')}</span>{label}{index < 2 && <ArrowRight size={13} aria-hidden="true" />}</li>)}</ol><p>{copy.subtitle}</p><Button variant="link" className="home-guide-link" onClick={openDemo}>{copy.openDemo}<ArrowRight size={15} /></Button></div>
      </div>
    </section>
    <Dialog open={demoOpen} onOpenChange={setDemoOpen}>
      <DialogContent className="home-guide-dialog" initialFocus={title}>
        <DialogHeader><DialogTitle ref={title} tabIndex={-1}>{copy.demoTitle}</DialogTitle><DialogDescription>{copy.demoDisclaimer}</DialogDescription></DialogHeader>
        <ol className="home-guide-step-picker" aria-label={copy.stepLabel}>{copy.shortSteps.map((label, index) => <li key={label}><button type="button" aria-current={step === index ? 'step' : undefined} onClick={() => setStep(index)}><span>{index + 1}</span>{label}</button></li>)}</ol>
        <GuideScene step={step} />
        <div className="home-guide-step-copy" aria-live="polite" aria-atomic="true"><small>{String(step + 1).padStart(2, '0')} / 03</small><h3>{copy.steps[step].title}</h3><p>{copy.steps[step].body}</p></div>
        <footer className="home-guide-dialog-actions"><Button variant="outline" disabled={step === 0} onClick={() => setStep(value => Math.max(0, value - 1))}><ArrowLeft size={15} />{copy.previous}</Button><Button onClick={step === 2 ? finish : () => setStep(value => Math.min(2, value + 1))}>{step === 2 ? copy.done : copy.next}<ArrowRight size={15} /></Button></footer>
      </DialogContent>
    </Dialog>
  </>
}

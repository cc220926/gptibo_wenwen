import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleHelp, ClipboardList, CreditCard, Package, Play, Search, X } from 'lucide-react'
import { useStorefrontI18n } from '@/lib/storefront-i18n'
import { homeGuideCopy, homeHelpCopy, searchHomeQuestions } from '@/lib/home-guidance'
import { Button } from './ui/button'
import { Input } from './ui/input'
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

export function HomeGuidance({ onOrders, onSupport }: { onOrders: () => void; onSupport: () => void }) {
  const { locale } = useStorefrontI18n()
  const copy = homeGuideCopy(locale)
  const helpCopy = homeHelpCopy(locale)
  const id = useId()
  const [tab, setTab] = useState(0)
  const [scenario, setScenario] = useState(0)
  const [demoOpen, setDemoOpen] = useState(false)
  const [step, setStep] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const questions = searchHomeQuestions(locale, query)
  const featured = searchHomeQuestions(locale).slice(0, 3)
  const openDemo = () => { setStep(0); setDemoOpen(true) }
  const openHelp = (question?: string) => { setQuery(''); setExpanded(question ?? null); setHelpOpen(true) }
  const leaveGuide = (destination: 'orders' | 'support') => {
    setHelpOpen(false)
    if (destination === 'orders') onOrders()
    else onSupport()
  }
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, current: number) => {
    const next = event.key === 'ArrowRight' ? (current + 1) % 3 : event.key === 'ArrowLeft' ? (current + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null
    if (next === null) return
    event.preventDefault(); setTab(next)
    document.getElementById(`${id}-tab-${next}`)?.focus()
  }
  const finish = () => {
    setDemoOpen(false)
    document.getElementById('catalog-products')?.scrollIntoView({ behavior: 'auto', block: 'start' })
  }
  return <>
    <section className="home-guide page-width" aria-label={copy.region}>
      <header className="home-guide-header"><h2>{copy.title}</h2><div className="home-guide-tabs" role="tablist" aria-label={copy.region}>{[copy.demo, helpCopy.help, helpCopy.cases].map((label, index) => <button type="button" key={label} id={`${id}-tab-${index}`} role="tab" aria-selected={tab === index} aria-controls={`${id}-panel-${index}`} tabIndex={tab === index ? 0 : -1} onClick={() => setTab(index)} onKeyDown={event => moveTab(event, index)}>{label}</button>)}</div></header>
      <div role="tabpanel" id={`${id}-panel-0`} aria-labelledby={`${id}-tab-0`} hidden={tab !== 0}>
      <div className="home-guide-demo-panel">
        <button className="home-guide-preview" type="button" onClick={openDemo} aria-label={copy.openDemo}><GuideScene step={1} preview /></button>
        <div className="home-guide-copy"><h3>{copy.intro}</h3><ol className="home-guide-short-steps">{copy.shortSteps.map((label, index) => <li key={label}><span>{String(index + 1).padStart(2, '0')}</span>{label}{index < 2 && <ArrowRight size={13} aria-hidden="true" />}</li>)}</ol><p>{copy.subtitle}</p><Button variant="link" className="home-guide-link" onClick={openDemo}>{copy.openDemo}<ArrowRight size={15} /></Button></div>
      </div>
      </div>
      <div role="tabpanel" id={`${id}-panel-1`} aria-labelledby={`${id}-tab-1`} hidden={tab !== 1}>
        <div className="home-guide-help-panel">
          <div className="home-guide-copy"><span className="home-guide-topic-icon" aria-hidden="true"><CircleHelp size={25} strokeWidth={1.5} /></span><h3>{helpCopy.helpTitle}</h3><p>{helpCopy.helpIntro}</p><Button variant="link" className="home-guide-link" onClick={() => openHelp()}><Search size={15} />{helpCopy.allQuestions}<ArrowRight size={15} /></Button></div>
          <div className="home-guide-featured-questions">{featured.map(question => <button type="button" key={question.id} onClick={() => openHelp(question.id)}>{question.title}<ChevronRight size={16} aria-hidden="true" /></button>)}</div>
        </div>
      </div>
      <div role="tabpanel" id={`${id}-panel-2`} aria-labelledby={`${id}-tab-2`} hidden={tab !== 2}>
        <div className="home-guide-cases-panel">
          <div className="home-guide-copy"><span className="home-guide-case-badge">{helpCopy.caseBadge}</span><h3>{helpCopy.caseTitle}</h3><p>{helpCopy.caseDisclaimer}</p><Button variant="link" className="home-guide-link" onClick={onOrders}>{helpCopy.orders}<ArrowRight size={15} /></Button></div>
          <div className="home-guide-case-content"><div className="home-guide-scenarios" role="group" aria-label={helpCopy.cases}>{helpCopy.scenarios.map((item, index) => <button type="button" key={item.id} aria-pressed={scenario === index} onClick={() => setScenario(index)}>{item.label}</button>)}</div><dl aria-live="polite" aria-atomic="true"><div><dt>{helpCopy.situation}</dt><dd>{helpCopy.scenarios[scenario].situation}</dd></div><div><dt>{helpCopy.nextStep}</dt><dd>{helpCopy.scenarios[scenario].nextStep}</dd></div></dl></div>
        </div>
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
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="home-guide-dialog home-guide-help-dialog" initialFocus={searchInput}>
        <DialogHeader><DialogTitle>{helpCopy.questionTitle}</DialogTitle><DialogDescription>{helpCopy.questionIntro}</DialogDescription></DialogHeader>
        <div className="home-guide-search"><Search size={17} aria-hidden="true" /><Input ref={searchInput} aria-label={helpCopy.search} placeholder={helpCopy.searchPlaceholder} value={query} maxLength={160} onChange={event => { setQuery(event.target.value); setExpanded(null) }} />{query && <Button variant="ghost" size="icon-sm" aria-label={helpCopy.clear} onClick={() => { setQuery(''); setExpanded(null); searchInput.current?.focus() }}><X size={15} /></Button>}</div>
        <p className="home-guide-results-count" role="status">{questions.length} {helpCopy.resultCount}</p>
        <div className="home-guide-question-list">{questions.length ? questions.map(question => <details key={question.id} open={expanded === question.id}><summary onClick={event => { event.preventDefault(); setExpanded(value => value === question.id ? null : question.id) }}>{question.title}<ChevronRight size={16} aria-hidden="true" /></summary><div><p>{question.answer}</p><Button variant="link" className="home-guide-link" onClick={() => leaveGuide(question.action)}>{question.action === 'orders' ? helpCopy.orders : helpCopy.support}<ArrowRight size={15} /></Button></div></details>) : <div className="home-guide-no-results"><p>{helpCopy.noResults}</p><Button variant="link" onClick={() => leaveGuide('support')}>{helpCopy.support}<ArrowRight size={15} /></Button></div>}</div>
      </DialogContent>
    </Dialog>
  </>
}

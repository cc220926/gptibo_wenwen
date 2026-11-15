import { emailProduct, productNameForId } from '../../shared/email-products'
import { useState } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Feedback } from '@/components/workspace-loading'
import { api, errorMessage } from '@/lib/api'
import { useResource } from '@/lib/use-resource'
import { money, toCents } from '@/partner/model'
import type { DefaultSupplyPlan, DefaultSupplySettings } from '../../shared/partner-default-prices'

const endpoint = '/api/admin/partners/default-prices'
const planName = (plan: DefaultSupplyPlan) => plan.product_id === 'chatgpt' ? 'ChatGPT ' + plan.name : productNameForId(plan.product_id) + ' · ' + plan.name

function DefaultPricesForm({ settings, loading, onEditing, onSaved }: { settings: DefaultSupplySettings; loading: boolean; onEditing: () => void; onSaved: () => void }) {
  const [values, setValues] = useState(() => Object.fromEntries(settings.plans.map(plan => [plan.id, (plan.cost_cents / 100).toFixed(2)])))
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const changed = settings.plans.some(plan => toCents(values[plan.id]) !== plan.cost_cents)
  const invalid = (plan: DefaultSupplyPlan) => {
    const cents = toCents(values[plan.id])
    return !Number.isSafeInteger(cents) || cents < 1 || cents > 10000000 || cents > plan.price_cents || (plan.min_partner_price_cents != null && cents > plan.min_partner_price_cents)
  }
  async function save() {
    if (busy || loading || !changed || settings.plans.some(invalid)) return
    setBusy(true); setError('')
    try {
      await api(endpoint, { version: settings.version, prices: settings.plans.map(plan => ({ plan: plan.id, costCents: toCents(values[plan.id]), catalogVersion: plan.catalog_version })) })
      onSaved()
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <form className="partner-default-form" onSubmit={event => { event.preventDefault(); void save() }}>
    <div className="partner-default-head" aria-hidden="true"><span>商品套餐</span><span>平台售价</span><span>统一供货价（元）</span></div>
    <div>{settings.plans.map(plan => <div className="partner-default-row" key={plan.id}>
      <div className="partner-default-product"><strong>{planName(plan)}</strong><span>{plan.renewal_only ? '仅续费' : emailProduct(plan.id) ? emailProduct(plan.id)!.duration + ' · 邮件交付' : plan.product_id === 'chatgpt' ? '按月订阅' : '按次服务'}</span></div>
      <div className="partner-default-retail"><span className="partner-default-mobile-label">平台售价</span><strong>{money(plan.price_cents)}</strong></div>
      <Field data-invalid={invalid(plan) || undefined}><FieldLabel className="partner-default-label" htmlFor={'default-cost-' + plan.id}><span className="sr-only">{planName(plan)}</span>统一供货价（元）</FieldLabel><Input id={'default-cost-' + plan.id} inputMode="decimal" autoComplete="off" value={values[plan.id]} onChange={event => { setValues(previous => ({ ...previous, [plan.id]: event.target.value })); setError(''); onEditing() }} maxLength={9} required disabled={busy || loading} aria-invalid={invalid(plan)} aria-describedby={invalid(plan) ? 'default-cost-error-' + plan.id : undefined} />{invalid(plan) && <FieldError id={'default-cost-error-' + plan.id}>供货价不能高于平台或任一代理的售价，最多两位小数。</FieldError>}</Field>
    </div>)}</div>
    <div className="partner-default-actions"><Feedback error={error} /><Button type="submit" disabled={busy || loading || !changed || settings.plans.some(invalid)}>{busy ? '保存中…' : '保存并同步所有代理'}</Button></div>
  </form>
}

export default function PartnerDefaultPrices({ revision, onSaved }: { revision: number; onSaved: () => void }) {
  const [localRevision, setLocalRevision] = useState(0); const [message, setMessage] = useState('')
  const { data, error, loading } = useResource<DefaultSupplySettings>(endpoint, revision + localRevision)
  return <section className="admin-panel partner-default-panel">
    <div className="admin-panel-title"><h2>统一供货价</h2><Button variant="ghost" size="icon" aria-label="刷新统一供货价" disabled={loading} onClick={() => { setMessage(''); setLocalRevision(value => value + 1) }}><RefreshCw size={15} /></Button></div>
    <p className="partner-default-description">保存后同步所有代理的供货价，保留代理自己的售价。仅影响新订单，历史订单与收益不变。若新供货价高于任一代理售价，整批拒绝保存，请先协调调整售价。</p>
    <Feedback error={error} loading={loading} data={data} shape="compact" />
    {data && <DefaultPricesForm key={data.version + ':' + data.plans.map(plan => plan.catalog_version).join(',')} settings={data} loading={loading} onEditing={() => setMessage('')} onSaved={() => { setMessage('统一供货价已保存并同步所有代理，代理售价与历史订单保持不变'); onSaved() }} />}
    {message && <p className="partner-default-success" role="status"><Check size={14} />{message}</p>}
  </section>
}

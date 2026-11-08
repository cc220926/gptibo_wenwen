import { useState } from 'react'
import { ArrowRight, Check, ChevronRight, FileText, LifeBuoy, LockKeyhole, Mail, Package, ShieldCheck, UserRound } from 'lucide-react'
import type { CatalogPlan } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { storefrontHref } from '@/lib/storefront-routing'
import { isMuseOffer, museQuota } from '../../shared/service-presentation'
import '@/styles/service-product.css'

const price = (cents: number) => (cents / 100).toFixed(2)
const paragraphs = (value?: string) => value?.split(/\n+/).map(line => line.trim()).filter(Boolean) ?? []
function ProductSymbol({ muse, large = false }: { muse: boolean; large?: boolean }) {
  return muse ? <span className={'service-muse-mark' + (large ? ' large' : '')} aria-hidden="true">M</span> : <Package size={large ? 104 : 36} strokeWidth={1.2} aria-hidden="true" />
}

export function ServiceProductPage({ productId, offers, ready, busy, checkoutEnabled, onBuy, onNavigate, onSupport }: {
  productId: string; offers: CatalogPlan[]; ready: boolean; busy: boolean; checkoutEnabled: boolean
  onBuy: (plan: CatalogPlan, noticeRead: boolean) => void; onNavigate: (page: string) => void; onSupport: () => void
}) {
  const [selected, setSelected] = useState('')
  const [noticeOpen, setNoticeOpen] = useState(false)
  const [acceptedNotice, setAcceptedNotice] = useState('')
  const plans = offers.filter(p => p.product_id === productId && p.delivery_type && p.delivery_type !== 'legacy')
  const plan = plans.find(p => p.id === selected) ?? plans.find(p => p.enabled) ?? plans[0]
  if (!plan) return <section className="empty-orders page-width"><h1>{ready ? '该商品已下架或暂不可用' : '正在读取商品'}</h1><p>已有订单仍可在「我的订单」查看。</p><Button onClick={() => onNavigate('store')}>返回商店</Button></section>
  const muse = isMuseOffer(plan), stock = plan.delivery_type === 'stock'
  const available = Boolean(ready && checkoutEnabled && plan.enabled)
  const status = available ? '可购买' : stock && !plan.stock_available ? '暂时缺货' : '暂停售卖'
  const noticeKey = JSON.stringify([plan.id, plan.version, plan.price_cents, plan.purchase_note, plan.delivery_instructions])
  const accepted = acceptedNotice === noticeKey
  const purchase = () => { if (available && !busy && accepted) onBuy(plan, true) }
  if (!muse) return <section className="page-width service-product-detail service-product-generic"><nav className="product-breadcrumb" aria-label="当前位置"><a href={storefrontHref('store')} onClick={event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onNavigate('store') }}>全部商品</a><ChevronRight size={13} /><span>{plan.category}</span></nav><div className="service-product-layout"><div className="service-product-intro"><Package size={48} strokeWidth={1.2} /><h1>{plan.product_name}</h1><p>{plan.description}</p><span><ShieldCheck size={16} />订单内查看交付与售后记录</span></div><div className="service-product-options"><h2>选择规格</h2><div role="group" aria-label="商品规格" className="service-specs">{plans.map(offer => <button key={offer.id} aria-pressed={offer.id === plan.id} onClick={() => setSelected(offer.id)}><span><strong>{offer.name}</strong><small>{offer.delivery_type === 'stock' ? offer.stock_available ? '付款确认后自动发货' : '暂时缺货' : '人工服务交付'}{!offer.enabled && ' · 暂不可购买'}</small></span><strong>¥{price(offer.price_cents)}</strong></button>)}</div><div className="service-product-note"><h3>购买前请确认</h3><p>{plan.purchase_note}</p><p>{stock ? '每单一份，付款确认后在订单页领取，同一份内容也会发送至下单邮箱。交付不代表已经激活或兑换。' : '每单一份，付款后由工作人员处理，交付结果将在原订单展示，并通过邮件通知。'}</p></div><Button className="primary-action" disabled={!available || busy} onClick={() => onBuy(plan, false)}>{available ? '确认规格，立即购买' : status}<ArrowRight size={16} /></Button></div></div></section>
  const steps = [
    { icon: Mail, title: '确认规格与收件邮箱', copy: '先阅读购买说明，核对所选规格和金额，再填写能正常收件的邮箱。' },
    { icon: Package, title: stock ? '付款后领取交付内容' : '付款后等待服务处理', copy: stock ? '付款确认后，系统将本单库存交付至原订单；邮件通知会单独发送。' : '工作人员按照订单要求处理，进度与结果都保存在原订单。' },
    { icon: ShieldCheck, title: muse ? '按说明完成首次登录' : '核对结果并按说明使用', copy: muse ? '查看账号邮箱与接码链接，核对登录结果。如遇异常，保留订单记录并申请售后。' : '收到内容后按交付说明使用或兑换。换设备时，可用下单邮箱验证找回订单。' },
  ]
  return <section className={'page-width service-product-detail' + (muse ? ' service-product-muse' : '')}>
    <nav className="product-breadcrumb" aria-label="当前位置"><a href={storefrontHref('store')} onClick={event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onNavigate('store') }}>全部商品</a><ChevronRight size={13} /><span>{plan.product_name}</span></nav>
    <header className="service-page-heading"><h1>{plan.product_name}</h1><p>{muse ? '独立账号，按需开启你的创作。' : plan.description || '选好规格，清楚了解每一步交付。'}</p></header>
    <div className="service-product-layout">
      <div className="service-product-selection">
        <div className="service-product-eyebrow"><span>{muse ? 'MUSE / 成品账号' : `${plan.category ?? '自有商品'} / ${stock ? '库存交付' : '人工服务'}`}</span><span className={available ? 'available' : ''}>{status}</span></div>
        <div className="service-product-identity"><ProductSymbol muse={muse} /><div><h2>{muse ? 'Muse' : plan.product_name}</h2><p>{muse ? '独立账号 · 每份 1 个' : '一次下单 · 每单一份'}</p></div></div>
        <div className="service-product-visual" aria-hidden="true"><span className="service-visual-label">{muse ? 'MUSE ACCOUNT' : 'YOUR NEXT TOOL'}</span><ProductSymbol muse={muse} large /><span className="service-visual-caption">{muse ? museQuota(plan.name) : stock ? '选好规格，交付有迹可查。' : '从下单，到服务完成。'}</span></div>
        <div className="service-spec-heading"><h3>选择商品规格</h3><span>一次购买 · 一份</span></div>
        <div role="radiogroup" aria-label="商品规格" className="service-specs">{plans.map(offer => <label key={offer.id} className={'service-spec' + (offer.id === plan.id ? ' selected' : '')}>
          <div className="service-spec-title"><input type="radio" name="service-plan" value={offer.id} checked={offer.id === plan.id} onChange={() => setSelected(offer.id)} /><strong>{offer.name}</strong></div>
          <span className={'service-spec-status' + (offer.enabled ? ' available' : '')}>{offer.enabled ? '可购买' : offer.delivery_type === 'stock' && !offer.stock_available ? '暂时缺货' : '暂停售卖'}</span>
          <span className="service-spec-price"><span>¥</span><strong>{price(offer.price_cents)}</strong><small>/ 份</small></span>
        </label>)}</div>
        <div className="service-product-features"><span><Check size={15} />每单交付一份</span><span><FileText size={15} />原订单查看内容</span><span><Mail size={15} />下单邮箱通知</span></div>
        <div className="service-product-bottom"><span>{stock ? '库存交付 · 订单可查询' : '人工处理 · 进度可查询'}</span><button type="button" className="text-button" onClick={() => setNoticeOpen(true)}>购买须知 <ArrowRight size={14} /></button></div>
      </div>
      <aside className="service-product-summary" aria-label="商品摘要">
        <div className="service-summary-heading"><h2>商品信息</h2><UserRound size={20} aria-hidden="true" /></div>
        <div className="service-summary-product"><ProductSymbol muse={muse} /><strong>{plan.product_name}</strong></div>
        <dl className="service-summary-details"><div><dt>{muse ? '账号数量' : '购买数量'}</dt><dd>1 {muse ? '个账号' : '份'}</dd></div><div><dt>{muse ? '规格额度' : '当前规格'}</dt><dd>{muse ? museQuota(plan.name) : plan.name}</dd></div><div><dt>交付内容</dt><dd>{muse ? '账号邮箱与接码链接' : stock ? '所选规格的库存内容' : '人工服务结果'}</dd></div><div><dt>销售状态</dt><dd className={available ? 'available' : ''}>{status}</dd></div></dl>
        <div className="service-summary-price"><span>售价</span><strong>¥{price(plan.price_cents)}</strong></div>
        <div className="service-summary-payment"><span>支付方式</span><span>下单时核对可用渠道</span></div>
        <div className="service-purchase-consent"><input id="service-notice-read" type="checkbox" aria-label="我已阅读购买须知与交付说明" checked={accepted} onChange={event => setAcceptedNotice(event.target.checked ? noticeKey : '')} /><label htmlFor="service-notice-read">我已阅读</label><button type="button" onClick={() => setNoticeOpen(true)}>购买须知与交付说明</button></div>
        <Button className="service-summary-buy" disabled={!available || busy || !accepted} onClick={purchase}>{busy ? '处理中…' : available ? '立即购买' : status}<ArrowRight size={17} /></Button>
        <p className="service-summary-footnote"><LockKeyhole size={14} />{stock ? '付款确认后领取；缺货时无法创建新订单。' : '付款后按订单约定处理，请先确认服务范围。'}</p>
        <Button variant="ghost" className="service-summary-support" onClick={onSupport}><LifeBuoy size={15} />购买前咨询</Button>
      </aside>
    </div>
    <section className="service-delivery-section" aria-labelledby="service-delivery-heading"><div className="service-section-heading"><span>从下单，到领取</span><h2 id="service-delivery-heading">交付的每一步，都说清楚。</h2></div><div className="service-delivery-steps">{steps.map(({ icon: Icon, title, copy }, index) => <article key={title}><div><Icon size={23} strokeWidth={1.5} /><span>0{index + 1}</span></div><h3>{title}</h3><p>{copy}</p></article>)}</div></section>
    <section className="service-faq-section" aria-labelledby="service-faq-heading"><div className="service-section-heading"><span>购买之前</span><h2 id="service-faq-heading">先了解，再决定。</h2><Button variant="ghost" onClick={onSupport}>联系支持 <ArrowRight size={14} /></Button></div><Accordion className="service-faq-list">
      <AccordionItem value="delivery"><AccordionTrigger>交付什么，在哪里查看？</AccordionTrigger><AccordionContent>{muse ? '本商品交付一个独立 Muse 账号的邮箱及接码链接。' : '交付内容以当前规格说明为准。'}付款确认后，在原订单领取；如邮件未收到，请先查看垃圾邮件和订单状态。</AccordionContent></AccordionItem>
      <AccordionItem value="before"><AccordionTrigger>付款前需要了解哪些说明？</AccordionTrigger><AccordionContent><div className="service-notice-lines">{paragraphs(plan.purchase_note).map((line, index) => <p key={index}>{line}</p>)}</div></AccordionContent></AccordionItem>
      <AccordionItem value="use"><AccordionTrigger>{muse ? '首次登录与接码如何操作？' : '收到商品后如何使用？'}</AccordionTrigger><AccordionContent><div className="service-notice-lines">{paragraphs(plan.delivery_instructions).map((line, index) => <p key={index}>{line}</p>)}</div></AccordionContent></AccordionItem>
      <AccordionItem value="recovery"><AccordionTrigger>换设备后还能找回订单吗？</AccordionTrigger><AccordionContent>可以。在「我的订单」使用下单邮箱接收验证码，验证后可查询历史订单。请妥善保存原订单号，遇到交付问题可从原订单申请售后。</AccordionContent></AccordionItem>
    </Accordion></section>
    <div className="service-mobile-purchase" aria-label="快捷购买"><div><strong>¥{price(plan.price_cents)}</strong><span>{plan.name}</span></div><Button disabled={!available || busy} onClick={accepted ? purchase : () => setNoticeOpen(true)}>{available ? accepted ? '立即购买' : '阅读购买说明' : status}<ArrowRight size={16} /></Button></div>
    <Dialog open={noticeOpen} onOpenChange={setNoticeOpen}><DialogContent className="service-notice-dialog motion-dialog"><DialogHeader><DialogTitle>购买须知</DialogTitle><DialogDescription>{plan.product_name} · {plan.name}</DialogDescription></DialogHeader><div className="service-notice-scroll"><section><h3>购买前确认</h3><div className="service-notice-lines">{paragraphs(plan.purchase_note).map((line, index) => <p key={index}>{line}</p>)}</div></section><section><h3>{muse ? '收到账号后的操作说明' : '交付与使用说明'}</h3><div className="service-notice-lines">{paragraphs(plan.delivery_instructions).map((line, index) => <p key={index}>{line}</p>)}</div></section><p className="service-notice-help">不确定是否适用？请先咨询支持，再继续下单。</p></div><footer><Button variant="outline" onClick={() => setNoticeOpen(false)}>返回查看</Button><Button onClick={() => { setAcceptedNotice(noticeKey); setNoticeOpen(false) }}>我已了解 <Check size={16} /></Button></footer></DialogContent></Dialog>
  </section>
}

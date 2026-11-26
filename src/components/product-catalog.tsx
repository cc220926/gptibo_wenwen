import { GptAccountScene } from './gpt-account-scene'
import { GeminiContactCard } from './gemini-contact-card'
import { MusePromo } from './muse-promo'
import { CodexCreditsScene } from './codex-credits-scene'
import '@/styles/service-product.css'
import { isGptAccountOffer, isMuseOffer, serviceProductRoute } from '../../shared/service-presentation'
import { useStorefrontI18n } from '@/lib/storefront-i18n'
import { normalizeProductOrder } from '../../shared/product-order'
import { XPremiumScene } from './x-premium'
import { MembershipScene } from './membership-scene'
import { EMAIL_PRODUCTS } from '../../shared/email-products'
import { useState, type MouseEvent, type ReactNode } from 'react'
import { ChevronRight, CircleHelp, LayoutGrid, MessageSquare, Package, Mail, ReceiptText, Search, Sparkles, Terminal } from 'lucide-react'
import { LaunchInterestDialog, type InterestProduct } from './launch-interest-dialog'
import { ProductMark } from './brand'
import { SubscriptionDeck } from './subscription-deck'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { UPCOMING_PRODUCTS } from '@/lib/products'
import { storefrontHref } from '@/lib/storefront-routing'
import { catalogSubscriptionPlans, catalogStartingPrice, formatCatalogPrice } from '@/lib/catalog-display'
import { placeMuseBelowSms } from '@/lib/catalog-layout'
import type { CatalogPlan } from '@/lib/api'
import '@/styles/storefront-home.css'

const categories = [
  { id: 'all', name: '全部商品', icon: LayoutGrid },
  { id: 'ai', name: 'AI 订阅', icon: Sparkles },
  { id: 'learning', name: '语言学习', icon: Sparkles },
  { id: 'mail', name: '邮箱账号', icon: Mail },
  { id: 'tool', name: '工具服务', icon: Terminal },
]

function CatalogSkeleton() {
  return <div className="store-featured store-catalog-skeleton" aria-hidden="true">
    {[0, 1, 2, 3, 4, 5].map(index => <div key={index} className="store-product store-skeleton-card">
      <span className="store-skeleton-title" /><span className="store-skeleton-spec" />
      <div className="store-skeleton-art"><span /></div>
      <div className="store-product-bottom"><span className="store-skeleton-price" /><span className="store-skeleton-action" /></div>
    </div>)}
  </div>
}

export function ProductCatalog({ onHelp, onOrders, onNavigate, onGeminiContact, offers, catalogReady, error, productOrder = [], hiddenProductIds = [] }: { catalogReady: boolean; error?: string; productOrder?: readonly string[]; hiddenProductIds?: readonly string[]; onHelp: () => void; onOrders: () => void; onNavigate: (page: string) => void; onGeminiContact?: () => void; offers: CatalogPlan[] }) {
  const { t } = useStorefrontI18n()
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [interest, setInterest] = useState<InterestProduct>()
  const [interestOpen, setInterestOpen] = useState(false)
  // SMS supply specs surface through the Codex 接码 card instead of a generic product card.
  const serviceOffers = offers.filter(p => (p.delivery_type === 'stock' || p.delivery_type === 'manual') && p.supply_kind !== 'codex-sms')
  const smsOffer = offers.filter(p => p.supply_kind === 'codex-sms').sort((a, b) => Number(Boolean(b.enabled)) - Number(Boolean(a.enabled)) || a.price_cents - b.price_cents)[0]
  const serviceCategory = (name: string) => categories.find(c => c.name === name)?.id ?? 'service:' + name
  const categoryOptions = [...categories, ...[...new Set(serviceOffers.map(p => p.category ?? '其他商品'))].filter(name => !categories.some(c => c.name === name)).map(name => ({ id: serviceCategory(name), name, icon: Package }))]
  const plans = catalogSubscriptionPlans(offers)
  const startingPrice = catalogStartingPrice(offers)
  const matches = (group: string, text: string) => (category === 'all' || category === group) && text.toLowerCase().includes(query.trim().toLowerCase())
  const chatgpt = matches('ai', 'ChatGPT Plus Pro')
  const gmail = matches('mail', 'Gmail 邮箱账号 email accounts 2FA')
  const upcoming = UPCOMING_PRODUCTS.filter(p => matches('ai', p.name))
  const memberships = Object.entries(EMAIL_PRODUCTS).filter(([, p]) => p.productId !== 'gmail' && !(p.productId === 'gemini' && onGeminiContact) && matches(p.productId === 'gemini' ? 'ai' : 'learning', p.name + (p.productId === 'duolingo' ? ' Duolingo' : '')))
  const xgift = matches('tool', 'X Premium 推特 Twitter 会员赠送')
  const xOffers = offers.filter(p => p.product_id === 'x-premium')
  const xAvailable = xOffers.some(p => p.enabled)
  const xOffer = [...xOffers].sort((a, b) => Number(Boolean(b.enabled)) - Number(Boolean(a.enabled)) || a.price_cents - b.price_cents)[0]
  const sms = matches('tool', 'Codex 接码 SMS verification')
  const credits = matches('tool', 'Codex 点数 credits 250 500')
  const creditOffers = offers.filter(p => p.product_id === 'codex-credits')
  const creditPrice = [...creditOffers].sort((a, b) => Number(Boolean(b.enabled)) - Number(Boolean(a.enabled)) || a.price_cents - b.price_cents)[0]
  const navigate = (event: MouseEvent<HTMLAnchorElement>, page: string) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault(); onNavigate(page)
  }
  const cards: { id: string; compact?: boolean; node: ReactNode }[] = [
    { id: 'codex-credits', node: credits && <article className="store-product"><div className="store-product-heading"><h3>Codex 点数</h3><span>{t(creditOffers.some(p => p.enabled) ? '账号直充' : '暂停售卖')}</span></div><p className="store-spec">{(creditOffers.map(p => Number(p.id.match(/^codex-credits-(\d+)$/)?.[1])).filter(Boolean).sort((a, b) => a - b).join(' / ') || '250 / 500') + ' 点 · ' + t('一次性点数包')}</p><CodexCreditsScene /><div className="store-product-bottom"><span className="store-starting-price">{creditPrice ? <>¥{formatCatalogPrice(creditPrice.price_cents / 100)}<small>{t(' 起')}</small></> : <small>{t('暂未开放')}</small>}</span><a className="store-action" href={storefrontHref('product/codex-credits')} onClick={e => navigate(e, 'product/codex-credits')}>{t('选择套餐')}</a></div></article> },
    { id: "chatgpt", node: chatgpt && <article className="store-product"><div className="store-product-heading"><h3>ChatGPT</h3>{offers.length > 0 && !plans.some(p => p.enabled) && <span>{t('暂停售卖')}</span>}</div><p className="store-spec">{t('自有账号充值 · Plus / Pro')}</p><SubscriptionDeck plans={plans} /><div className="store-product-bottom"><span className="store-starting-price">{startingPrice === null ? <small>{t(offers.length ? '价格暂不可用' : '价格加载中')}</small> : <>¥{formatCatalogPrice(startingPrice)}<small>{t(' 起')}</small></>}</span><a className="store-action" href={storefrontHref('product/chatgpt')} onClick={e => navigate(e, 'product/chatgpt')}>{t('选择套餐')}</a></div></article> },
    ...memberships.map(([id, product]) => { const offer = offers.find(p => p.id === id); return { id: product.productId, node: <article key={id} className="store-product membership-product"><div className="store-product-heading"><h3>{product.productId === 'gemini' ? 'Gemini Pro' : t('多邻国')}</h3><span>{t(product.duration + '会员')}</span></div><p className="store-spec">{t(product.label)} · {t('邮件交付')}</p><MembershipScene productId={product.productId as 'gemini' | 'duolingo'} /><div className="store-product-bottom"><span className="store-starting-price">{offer ? <>¥{formatCatalogPrice(offer.price_cents / 100)}<small> / {t(product.duration)}</small></> : <small>{t(offers.length ? '暂未开放' : '价格加载中')}</small>}</span><a className="store-action" href={storefrontHref('product/' + product.productId)} onClick={e => navigate(e, 'product/' + product.productId)}>{t(offer?.enabled ? '查看商品' : '查看详情')}</a></div></article> } }),
    { id: "x-premium", node: xgift && <article className="store-product membership-product x-product"><div className="store-product-heading"><h3>X Premium</h3><span>{t(offers.length > 0 && !xAvailable ? '暂停售卖' : '会员订阅')}</span></div><p className="store-spec">{t('3 / 6 个月 · 你的账号，继续精彩')}</p><XPremiumScene /><div className="store-product-bottom"><span className="store-starting-price">{xOffer ? <>¥{formatCatalogPrice(xOffer.price_cents / 100)}<small>{t(' 起')}</small></> : <small>{t('价格加载中')}</small>}</span><a className="store-action" href={storefrontHref('product/x-premium')} onClick={e => navigate(e, 'product/x-premium')}>{t(xAvailable ? '选择套餐' : '查看详情')}</a></div></article> },
    { id: "gmail", node: gmail && <article className="store-product"><div className="store-product-heading"><h3>{t('Gmail 账号')}</h3><span>{t('美国个人白号')}</span></div><p className="store-spec">{t('带 2FA · 账号资料自动邮件交付')}</p><div className="store-mail-art" aria-hidden="true"><div className="store-envelope" /><span className="store-envelope-label"><Mail size={16} />Gmail</span></div><div className="store-product-bottom"><span className="store-starting-price">{offers.find(p => p.id === 'gmail-account') ? <>¥{formatCatalogPrice(offers.find(p => p.id === 'gmail-account')!.price_cents / 100)}<small>{t(' / 个')}</small></> : <small>{t('价格加载中')}</small>}</span><a className="store-action" href={storefrontHref('product/gmail')} onClick={e => navigate(e, 'product/gmail')}>{t(offers.some(p => p.id === 'gmail-account' && p.enabled) ? '查看商品' : '查看详情')}</a></div></article> },
    ...upcoming.map(product => ({ id: product.id, compact: true, node: <Button key={product.id} variant="ghost" className="store-compact" onClick={() => { setInterest(product); setInterestOpen(true) }}><ProductMark small productId={product.id} /><span><strong>{product.name}</strong><small>{t('待上架')}</small></span><ChevronRight size={16} /></Button> })),
    { id: 'codex-sms', node: sms && <article className="store-product"><div className="store-product-heading"><h3>Codex 接码</h3><span>{t(smsOffer?.enabled ? '自动交付' : '暂停售卖')}</span></div><p className="store-spec">{t('单次接码 · CDK 兑换')}</p><div className="store-sms-art" aria-hidden="true"><div className="store-sms-card"><div className="store-sms-head"><span className="store-sms-icon"><MessageSquare size={13} /></span><strong>SMS</strong><small>now</small></div><p>Codex verification code</p><div className="store-sms-code">{['3', '8', '6', '2', '9', '4'].map((digit, index) => <span key={index} style={{ animationDelay: `${index * 120}ms` }}>{digit}</span>)}</div></div></div><div className="store-product-bottom"><span className="store-starting-price">{smsOffer ? <>¥{formatCatalogPrice(smsOffer.price_cents / 100)}<small>{t(' / 次')}</small></> : <small>{t(offers.length ? '暂未开放' : '价格加载中')}</small>}</span><a className="store-action" href={storefrontHref('product/codex-sms')} onClick={e => navigate(e, 'product/codex-sms')}>{t('查看商品')}</a></div></article> },
  ]
  for (const id of [...new Set(serviceOffers.map(p => p.product_id))]) {
    const variants = serviceOffers.filter(p => p.product_id === id)
    const first = variants[0]
    if (!matches(serviceCategory(first.category ?? '其他商品'), (first.product_name ?? '') + ' ' + (first.description ?? ''))) continue
    const route = serviceProductRoute(first)
    const artwork = isGptAccountOffer(first) ? <GptAccountScene /> : isMuseOffer(first) ? <MusePromo lazy /> : <div className="service-catalog-visual" aria-hidden="true"><Package size={76} strokeWidth={1} /></div>
    const available = variants.filter(p => p.enabled)
    const minimum = Math.min(...(available.length ? available : variants).map(p => p.price_cents))
    cards.push({ id, node: <article className="store-product"><div className="store-product-heading"><h3>{first.product_name}</h3>{!available.length && <span>暂不可购买</span>}</div><p className="store-spec">{first.category} · {variants.some(p => p.delivery_type === 'stock' || p.delivery_provider === 'muse') ? '自动交付' : '联系客服交付'}</p>{artwork}<div className="store-product-bottom"><span className="store-starting-price">¥{(minimum / 100).toFixed(2)}<small> 起</small></span><a className="store-detail-link" href={storefrontHref(route)} onClick={e => navigate(e, route)}>查看商品<ChevronRight size={15} /></a></div></article> })
  }
  const ordered = [...normalizeProductOrder(productOrder), ...new Set(serviceOffers.map(p => p.product_id))].flatMap(id => {
    const card = cards.find(item => item.id === id)
    return card?.node && !hiddenProductIds.includes(id) ? [card] : []
  })
  if (onGeminiContact && matches('ai', 'Gemini Pro 谷歌 Google 人工交付')) ordered.push({ id: 'gemini-contact', node: <GeminiContactCard onContact={onGeminiContact} /> })
  const arranged = placeMuseBelowSms(ordered, serviceOffers.find(isMuseOffer)?.product_id)
  const groups: typeof arranged[] = []
  for (const card of arranged) {
    const last = groups.at(-1)
    if (last && Boolean(last[0].compact) === Boolean(card.compact)) last.push(card)
    else groups.push([card])
  }
  const visibleCards = groups.flat()
  return <section id="catalog-products" className="store-home page-width" tabIndex={-1} aria-label={t('商品目录')}>
    <div className="store-content" aria-busy={!catalogReady && !error}>
      <div className="store-toolbar"><h2>{t(query ? '搜索结果' : category === 'all' ? '为你精选。' : categoryOptions.find(c => c.id === category)?.name ?? '商品')}</h2><label className="store-search"><Search size={15} /><Input aria-label={t('搜索商品')} placeholder={t('搜索商品')} value={query} onChange={e => setQuery(e.target.value)} /></label></div>
      <div className="store-category-bar">
        <div className="store-categories" role="group" aria-label={t('按品类筛选')}>{categoryOptions.map(({ id, name, icon: Icon }) => <Button key={id} variant="ghost" aria-pressed={category === id} onClick={() => setCategory(id)}><Icon size={16} />{t(name)}</Button>)}</div>
        <Button variant="ghost" className="store-help-link" onClick={onHelp}><CircleHelp size={15} />{t('购买帮助')}</Button>
      </div>
      {!catalogReady ? error ? <p className="store-empty" role="status">{t('商品暂时加载失败，请点击上方重试。')}</p> : <>
        <span className="sr-only" role="status">{t('正在加载商品')}</span><CatalogSkeleton />
      </> : <>
        {groups.map(group => <div key={group[0].id} className={(group[0].compact ? 'store-compact-grid' : 'store-featured') + ' store-product-group'}>
          {group.map(card => <div key={card.id} data-muse-column={card.museColumn} className="store-card-enter reveal-in" style={{ animationDelay: `${Math.min(visibleCards.indexOf(card), 6) * 40}ms` }}>
            {card.node}
          </div>)}
        </div>)}
        {!groups.length && <div className="store-empty" role="status"><p>{t('没有找到相关商品，试试其他名称。')}</p><Button variant="outline" onClick={() => { setQuery(''); setCategory('all') }}>{t('全部商品')}</Button></div>}
      </>}
      <p className="store-order-note"><ReceiptText size={15} />{t('付款、交付与售后，都可以在')}<button onClick={onOrders}>{t('「我的订单」')}</button>{t('中继续。')}</p>
    </div>
    {interest && <LaunchInterestDialog key={interest.id} product={interest} open={interestOpen} onOpenChange={setInterestOpen} />}
  </section>
}

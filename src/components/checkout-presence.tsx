import { UsersRound } from 'lucide-react'
import { useStorefrontI18n } from '@/lib/storefront-i18n'
import '@/styles/checkout-presence.css'
import type { MarketingMetric } from '../../shared/marketing-metric'

export function CheckoutPresence({ others, compact = false, metric }: { others: number | null; compact?: boolean; metric?: MarketingMetric | null }) {
  const { locale } = useStorefrontI18n()
  if (metric?.enabled) {
    const [before, after] = metric.displayText.split('{count}')
    return <div className={compact ? 'checkout-presence checkout-presence--compact' : 'checkout-presence'}>
      <UsersRound size={14} aria-hidden="true" />
      <span>{before}<strong>{metric.displayCount}</strong>{after}<small>{locale === 'en' ? 'Merchant-set display · Not a live sales count' : '商家设置的展示信息 · 非实时成交统计'}</small></span>
    </div>
  }
  if (others === null || !Number.isSafeInteger(others) || others < 0) return null
  const english = locale === 'en'
  const explanation = english
    ? 'Other browsers active in the ChatGPT checkout during the past 10 minutes. Deduplicated by browser; this is not a paid-order count.'
    : '统计近 10 分钟仍在 ChatGPT 下单窗口活动的其他访客，按浏览器去重，不代表已付款。'
  return <div className={compact ? 'checkout-presence checkout-presence--compact' : 'checkout-presence'} title={explanation}>
    <UsersRound size={14} aria-hidden="true" />
    <span>{english ? `${others} other ${others === 1 ? 'visitor was' : 'visitors were'} checking out in the past 10 minutes` : <>近 10 分钟有 <strong>{others}</strong> 位其他访客在下单</>}<small>{english ? 'Unique browsers · Not completed purchases' : '按浏览器去重 · 非成交人数'}</small></span>
  </div>
}

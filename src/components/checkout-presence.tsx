import { UsersRound } from 'lucide-react'
import { useStorefrontI18n } from '@/lib/storefront-i18n'
import '@/styles/checkout-presence.css'

export function CheckoutPresence({ others }: { others: number | null }) {
  const { locale } = useStorefrontI18n()
  if (others === null || !Number.isSafeInteger(others) || others < 0) return null
  const english = locale === 'en'
  const explanation = english
    ? 'Other browsers active in the ChatGPT checkout during the past minute. Deduplicated by browser; this is not a paid-order count.'
    : '统计近 1 分钟在 ChatGPT 下单窗口操作的其他访客，按浏览器去重，不代表已付款。'
  return <div className="checkout-presence" title={explanation}>
    <UsersRound size={14} aria-hidden="true" />
    <span>{english ? `${others} other ${others === 1 ? 'visitor was' : 'visitors were'} checking out in the past minute` : <>近 1 分钟有 <strong>{others}</strong> 位其他访客在下单</>}<small>{english ? 'Unique browsers · Not completed purchases' : '按浏览器去重 · 非成交人数'}</small></span>
  </div>
}

import { GeminiMark } from './membership-scene'
import { useStorefrontI18n } from '@/lib/storefront-i18n'

export function GeminiContactCard({ onContact }: { onContact: () => void }) {
  const { t } = useStorefrontI18n()
  return <article className="store-product gemini-contact-card">
    <div className="store-product-heading"><h3>Gemini Pro</h3><span>{t('人工交付')}</span></div>
    <p className="store-spec">{t('月付与年付均由客服处理')}</p>
    <div className="gemini-contact-art scene-gemini" aria-hidden="true"><GeminiMark /></div>
    <div className="store-product-bottom">
      <div className="gemini-contact-prices"><span>¥170 <small>{t('/ 月')}</small></span><span>¥1,700 <small>{t('/ 年')}</small></span></div>
      <button type="button" className="gemini-contact-trigger" aria-haspopup="dialog" aria-label={t('联系支持咨询 Gemini Pro')} onClick={onContact}><span className="store-action">{t('联系支持')}</span></button>
    </div>
  </article>
}

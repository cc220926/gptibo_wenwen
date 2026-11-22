import { ArrowLeft, ArrowRight, Gift } from 'lucide-react'
import { useStorefrontI18n } from '@/lib/storefront-i18n'
import { CopyButton } from './copy-button'
import { LiveRechargeSuccess } from './live-recharge-content'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog'
import '@/styles/referral-preview.css'

export function ReferralPreviewEntry() {
  const { locale } = useStorefrontI18n()
  const english = locale === 'en'
  return <Dialog>
    <div className="referral-preview-entry">
      <DialogTrigger type="button" className="referral-preview-pill">
        <span className="referral-preview-gift"><Gift size={15} aria-hidden="true" /></span>
        <span>{english ? 'Successful referral earns ' : '推荐成功返 '}<strong>¥5</strong></span>
        <ArrowRight size={14} aria-hidden="true" />
      </DialogTrigger>
    </div>
    <DialogContent className="home-guide-dialog" showCloseButton>
      <DialogHeader>
        <DialogTitle>{english ? 'Successful referral earns ¥5' : '推荐成功返 ¥5'}</DialogTitle>
        <DialogDescription>{english ? 'Share your link with a friend after your order is complete. Earn ¥5 when they order through your link and successfully activate their subscription.' : '开通成功后，把专属链接发给好友。好友通过你的链接下单并成功开通，你可获 ¥5 返利。'}</DialogDescription>
      </DialogHeader>
      <a className="referral-preview-text-link" href="/__preview/referral/order">{english ? 'Preview a completed order' : '看订单完成页示例'} <ArrowRight size={15} aria-hidden="true" /></a>
    </DialogContent>
  </Dialog>
}

export function ReferralOrderPreview() {
  const inviteLink = new URL('/?invite=DEMO-FRIEND', location.origin).href

  return <main className="referral-preview-order page-width">
    <a className="referral-preview-text-link" href="/#feedback"><ArrowLeft size={15} aria-hidden="true" /> 返回首页预览</a>
    <section className="referral-preview-order-card" aria-label="订单完成页演示">
      <header><span>ChatGPT Plus</span><span>订单完成页演示</span></header>
      <LiveRechargeSuccess accountEmailMasked="d***@example.test" onOrders={() => location.assign('/orders')}>
        <div className="referral-preview-order-action">
          <span>推荐成功返 ¥5</span>
          <CopyButton type="button" variant="outline" value={inviteLink} label="复制邀请链接" />
          <small>示例链接，仅供预览</small>
        </div>
      </LiveRechargeSuccess>
    </section>
  </main>
}

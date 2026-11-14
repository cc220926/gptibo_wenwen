import { Clock, ExternalLink, LoaderCircle } from 'lucide-react'
import { mapayPaymentEntry } from '../../shared/mapay-payment-entry'
import { PaymentLogo } from './payment-logo'
import { Button } from './ui/button'

type Props = { value: string; image: string; amountCents: number; remaining: number; awaitingConfirmation: boolean; busy: boolean; onPaid: () => void; onResume?: () => void }

export function MapayPaymentCard({ value, image, amountCents, remaining, awaitingConfirmation, busy, onPaid, onResume }: Props) {
  const entry = mapayPaymentEntry(value)
  return <section className="live-pay-card mapay-payment-card" aria-label="支付宝付款">
    <div className="live-pay-header"><div className="live-pay-brand"><PaymentLogo method="alipay" /><strong>支付宝支付</strong></div><span className="live-pay-timer" title="本次付款入口有效期"><Clock size={12} />{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span></div>
    <div className={`live-pay-body ${awaitingConfirmation || entry?.kind !== 'qr' ? 'mapay-pay-without-qr' : ''}`}>
      {!awaitingConfirmation && entry?.kind === 'qr' && <div className="live-qr-frame" aria-busy={!image}>{image ? <img src={image} width={156} height={156} alt="支付宝实际付款码" /> : <LoaderCircle className="processing-spinner" size={26} aria-label="正在显示付款码" />}</div>}
      <div className="live-pay-details">
        <div className="live-pay-amount"><span className="live-pay-amount-label">应付金额</span><strong className="live-pay-amount-value"><small>¥</small>{(amountCents / 100).toFixed(2)}</strong></div>
        {awaitingConfirmation ? <><div role="status"><strong>正在核对付款结果</strong><p className="live-pay-tip">暂未收到支付确认。如支付宝已扣款，请勿重复付款；可刷新进度或联系客服核对原订单。</p></div>{onResume && <Button variant="ghost" disabled={busy} onClick={onResume}>尚未付款，返回付款入口</Button>}</> : !entry ? <p role="alert" className="live-pay-tip">付款入口暂不可用，请刷新进度或联系客服。</p> : <>
          <p className="live-pay-tip">{entry.kind === 'qr' ? '使用支付宝扫描此码，只需付款一次。' : '点击下方按钮，在收银台完成一次付款。'}</p>
          <Button nativeButton={false} variant={entry.kind === 'qr' ? 'outline' : 'default'} onClick={onPaid} render={<a href={entry.url} target="_blank" rel="noopener noreferrer" />}>{entry.kind === 'qr' ? '打开支付宝付款' : '前往支付'} <ExternalLink size={13} /></Button>
          <Button variant="outline" disabled={busy} onClick={onPaid}>已付款，核对结果</Button>
        </>}
      </div>
    </div>
    <div className="live-pay-footer"><span className="live-watch">付款后自动核对 · 已扣款请勿重复支付</span></div>
  </section>
}

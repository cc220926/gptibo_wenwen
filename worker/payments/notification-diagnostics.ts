export type NotificationStage = 'provider' | 'verification' | 'lookup' | 'apply' | 'receipt'
type Outcome = 'received' | 'rejected' | 'applied'

// Match only our adapters' fixed errors. Never serialize arbitrary exceptions,
// callback fields, request URLs, signatures, merchant/order IDs or gateway bodies.
const verificationReasons = new Map([
  ['Invalid Mapay signature', 'invalid_signature'],
  ['Invalid Mapay notification method', 'invalid_format'],
  ['Ambiguous Mapay notification', 'invalid_format'],
  ['Mapay notification too large', 'invalid_format'],
  ['Duplicate ZPAY parameter', 'invalid_format'],
  ['Invalid Mapay trade', 'invalid_trade'],
  ['Invalid Mapay amount', 'invalid_trade'],
  ['Mapay order query unavailable', 'gateway_unavailable'],
  ['Mapay order query malformed', 'gateway_malformed'],
  ['Mapay order query mismatch', 'gateway_mismatch'],
  ['Mapay paid trade missing', 'gateway_mismatch'],
  // This error also covers a differing trade number: it does not prove unpaid.
  ['Mapay notification/order mismatch', 'gateway_not_confirmed'],
])

export function logPaymentNotification(providerId: string, outcome: Outcome, stage: NotificationStage, error?: unknown) {
  try {
    const provider = ['alipay', 'zpay', 'mapay'].includes(providerId) ? providerId : 'unknown'
    const reason = outcome !== 'rejected' ? undefined
      : stage === 'provider' ? 'provider_unavailable'
      : stage === 'lookup' && error instanceof Error && error.message === 'Unknown payment' ? 'payment_not_matched'
      : stage === 'verification' && error instanceof Error ? verificationReasons.get(error.message) ?? 'internal'
      : 'internal'
    const record = JSON.stringify({ event: 'payment-notification', provider, outcome, stage, ...(reason ? { reason } : {}) })
    if (outcome === 'rejected') console.warn(record)
    else console.info(record)
  } catch { /* Observability must never change payment handling or its acknowledgement. */ }
}

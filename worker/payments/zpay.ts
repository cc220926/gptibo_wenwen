import type { PaymentProvider } from './types.ts'
import { parseZpayNotification, queryZpayOrder, zpayCheckoutUrl } from './zpay-protocol.ts'

type Credentials = { pid: string; key: string }

export function zpay(credentials: Credentials): PaymentProvider {
  return {
    id: 'zpay',
    account: credentials.pid,
    async create(order, notifyUrl) { return { qr: zpayCheckoutUrl(order, notifyUrl, credentials) } },
    query(order) { return queryZpayOrder(order, credentials) },
    async close() { return false }, // The published API does not document trade closure.
    async refund() { throw new Error('ZPAY refund requires manual confirmation') },
    async queryRefund() { throw new Error('ZPAY refund requires manual confirmation') },
    async notification(request) {
      const candidate = parseZpayNotification(request, credentials)
      const confirmed = await queryZpayOrder({ id: candidate.orderId, amountCents: candidate.amountCents, subject: '', expiresAt: 0 }, credentials)
      if (confirmed.status !== 'paid' || confirmed.tradeNo !== candidate.tradeNo) throw new Error('ZPAY notification/order mismatch')
      return confirmed
    },
    acknowledge(accepted) { return new Response(accepted ? 'success' : 'failure', { status: accepted ? 200 : 400, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } }) },
  }
}

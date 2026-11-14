import { timingSafeEqual } from 'node:crypto'
import { boundedResponseText } from '../bounded-response.ts'
import { amountCents, amountText, type PaymentOrder, type PaymentProvider, type PaymentResult } from './types.ts'
import { signZpayParams, zpayMerchantOrderNo } from './zpay-protocol.ts'
import { mapayPaymentEntry } from '../../shared/mapay-payment-entry.ts'

type Credentials = { pid: string; key: string }
const origin = 'https://mzf.mapay.cn'
const prefix = '/xpay/epay'
const responseLimit = 16000

function checkCredentials({ pid, key }: Credentials) {
  if (!/^\d{1,20}$/.test(pid) || key.length < 16 || key.length > 256) throw new Error('Mapay credentials unavailable')
}
function subject(value: string) {
  if (!value.trim()) throw new Error('Invalid Mapay subject')
  let result = '', bytes = 0
  for (const char of value) {
    bytes += new TextEncoder().encode(char).byteLength
    if (bytes > 127) break
    result += char
  }
  return result
}
function checkoutParams(order: PaymentOrder, notify: string, credentials: Credentials) {
  checkCredentials(credentials)
  const url = new URL(notify)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/api/payments/notify/mapay') throw new Error('Invalid Mapay callback URL')
  const params = new URLSearchParams({ pid: credentials.pid, type: 'alipay', device: 'pc', out_trade_no: zpayMerchantOrderNo(order.id),
    name: subject(order.subject), money: amountText(order.amountCents), notify_url: url.href, return_url: url.origin + '/orders' })
  params.set('sign', signZpayParams(params, credentials.key)); params.set('sign_type', 'MD5')
  return params
}
async function create(order: PaymentOrder, notify: string, credentials: Credentials) {
  const params = checkoutParams(order, notify, credentials)
  // The configured channel currently offers a five-minute cashier. Use a
  // conservative local deadline from request start; never extend a reservation.
  const expiresAt = Math.min(order.expiresAt, Date.now() + 5 * 60000)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error('Mapay payment expired')
  let response: Response
  try { response = await fetch(origin + prefix + '/mapi.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(), redirect: 'manual', signal: AbortSignal.timeout(10000) }) }
  catch { throw new Error('Mapay payment creation unavailable') }
  if (!response.ok || Number(response.headers.get('content-length')) > responseLimit) { await response.body?.cancel(); throw new Error('Mapay payment creation unavailable') }
  let data: Record<string, unknown>
  try { data = JSON.parse(await boundedResponseText(response, responseLimit)) }
  catch { throw new Error('Mapay payment creation malformed') }
  if (!data || data.code !== 1 || typeof data.trade_no !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(data.trade_no)
    || data.money !== undefined && amountCents(data.money) !== order.amountCents
    || [data.qrcode, data.payurl].filter(Boolean).length !== 1) throw new Error('Mapay payment creation mismatch')
  const entry = mapayPaymentEntry(data.qrcode || data.payurl)
  if (!entry) throw new Error('Mapay payment entry unsupported')
  // The creation response does not echo merchant/order identity. Independently
  // query this original order before exposing any payment destination.
  const verified = await query(order, credentials)
  if (verified.tradeNo !== data.trade_no) throw new Error('Mapay payment creation mismatch')
  return { qr: entry.url, expiresAt }
}
async function candidate(request: Request, credentials: Credentials) {
  checkCredentials(credentials)
  const url = new URL(request.url)
  let params: URLSearchParams
  if (request.method === 'GET') {
    if (new TextEncoder().encode(url.search).byteLength > responseLimit) throw new Error('Mapay notification too large')
    params = url.searchParams
  } else if (request.method === 'POST' && request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded') {
    // Do not merge form and URL fields: a signature must cover exactly one source.
    if (url.search) throw new Error('Ambiguous Mapay notification')
    params = new URLSearchParams(await boundedResponseText(new Response(request.body), responseLimit))
  } else throw new Error('Invalid Mapay notification method')
  const signature = params.get('sign')
  if (params.get('sign_type') !== 'MD5' || !signature || !/^[a-f0-9]{32}$/.test(signature)) throw new Error('Invalid Mapay signature')
  const expected = signZpayParams(params, credentials.key) // Same documented V1 raw-value MD5 algorithm.
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) throw new Error('Invalid Mapay signature')
  const number = params.get('out_trade_no') ?? '', trade = params.get('trade_no') ?? ''
  if (params.get('pid') !== credentials.pid || params.get('type') !== 'alipay' || !/^[A-F0-9]{32}$/.test(number)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(trade) || params.get('trade_status') !== 'TRADE_SUCCESS') throw new Error('Invalid Mapay trade')
  const amount = amountCents(params.get('money')); if (amount < 1 || amount > 10000000) throw new Error('Invalid Mapay amount')
  return { orderId: 'YMX-' + number, amountCents: amount, tradeNo: trade }
}
async function query(order: PaymentOrder, credentials: Credentials): Promise<PaymentResult> {
  checkCredentials(credentials)
  const url = new URL(prefix + '/api.php', origin)
  url.search = new URLSearchParams({ act: 'order', pid: credentials.pid, key: credentials.key, out_trade_no: zpayMerchantOrderNo(order.id) }).toString()
  let response: Response
  try { response = await fetch(url.href, { redirect: 'manual', signal: AbortSignal.timeout(4500) }) }
  catch { throw new Error('Mapay order query unavailable') }
  if (!response.ok || Number(response.headers.get('content-length')) > responseLimit) { await response.body?.cancel(); throw new Error('Mapay order query unavailable') }
  let record: Record<string, unknown>
  try { record = JSON.parse(await boundedResponseText(response, responseLimit)) }
  catch { throw new Error('Mapay order query malformed') }
  if (!record || record.code !== 1 || String(record.pid) !== credentials.pid || record.out_trade_no !== zpayMerchantOrderNo(order.id)
    || record.type !== 'alipay' || amountCents(record.money) !== order.amountCents || ![0, 1].includes(record.status as number)) throw new Error('Mapay order query mismatch')
  if (record.status === 1 && (typeof record.trade_no !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(record.trade_no))) throw new Error('Mapay paid trade missing')
  return { orderId: order.id, amountCents: order.amountCents, status: record.status === 1 ? 'paid' : 'pending', tradeNo: typeof record.trade_no === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(record.trade_no) ? record.trade_no : undefined }
}

export function mapay(credentials: Credentials): PaymentProvider {
  checkCredentials(credentials)
  return {
    id: 'mapay', account: credentials.pid,
    create(order, notify) { return create(order, notify, credentials) },
    query(order) { return query(order, credentials) },
    async close() { return false },
    async refund() { throw new Error('Mapay refund requires manual confirmation') },
    async queryRefund() { throw new Error('Mapay refund requires manual confirmation') },
    async notification(request) {
      const value = await candidate(request, credentials)
      const verified = await query({ id: value.orderId, amountCents: value.amountCents, subject: '', expiresAt: 0 }, credentials)
      if (verified.status !== 'paid' || verified.tradeNo !== value.tradeNo) throw new Error('Mapay notification/order mismatch')
      return verified
    },
    acknowledge(accepted) { return new Response(accepted ? 'success' : 'failure', { status: accepted ? 200 : 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }) },
  }
}

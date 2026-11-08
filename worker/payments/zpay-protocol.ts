import { createHash, timingSafeEqual } from 'node:crypto'
import { amountCents, amountText, type PaymentOrder } from './types.ts'

type Credentials = { pid: string; key: string }

const merchantOrder = /^[A-F0-9]{32}$/
const providerOrigin = 'https://zpayz.cn'

function validCredentials({ pid, key }: Credentials) {
  if (!/^[A-Za-z0-9]{4,64}$/.test(pid) || key.length < 16 || key.length > 256) throw new Error('ZPAY credentials unavailable')
}

// ZPAY signs the raw values sorted by ASCII parameter name; URL encoding happens later.
export function signZpayParams(params: URLSearchParams, key: string) {
  if (!key) throw new Error('ZPAY credentials unavailable')
  const seen = new Set<string>()
  const parts: [string, string][] = []
  for (const [name, value] of params) {
    if (seen.has(name)) throw new Error('Duplicate ZPAY parameter')
    seen.add(name)
    if (name !== 'sign' && name !== 'sign_type' && value !== '') parts.push([name, value])
  }
  parts.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return createHash('md5').update(parts.map(([name, value]) => `${name}=${value}`).join('&') + key, 'utf8').digest('hex')
}

export function zpayMerchantOrderNo(orderId: string) {
  if (!/^YMX-[A-F0-9]{32}$/.test(orderId)) throw new Error('Unsupported ZPAY order ID')
  return orderId.slice(4)
}

export function zpayCheckoutUrl(order: PaymentOrder, notifyUrl: string, credentials: Credentials) {
  validCredentials(credentials)
  const callback = new URL(notifyUrl)
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash || callback.pathname !== '/api/payments/notify/zpay') throw new Error('Invalid ZPAY callback URL')
  if (!order.subject || order.subject.length > 100) throw new Error('Invalid ZPAY subject')
  const params = new URLSearchParams({
    pid: credentials.pid,
    type: 'alipay',
    out_trade_no: zpayMerchantOrderNo(order.id),
    notify_url: callback.href,
    return_url: `${callback.origin}/orders`,
    name: order.subject,
    money: amountText(order.amountCents),
  })
  params.set('sign', signZpayParams(params, credentials.key))
  params.set('sign_type', 'MD5')
  return `${providerOrigin}/submit.php?${params.toString()}`
}

// A signed notification is only a candidate. Before booking payment or
// fulfillment, the caller must verify this trade with ZPAY's order-query API.
export function parseZpayNotification(request: Request, credentials: Credentials) {
  validCredentials(credentials)
  if (request.method !== 'GET') throw new Error('Invalid ZPAY notification method')
  const url = new URL(request.url)
  const params = url.searchParams
  const sign = params.get('sign')
  if (params.get('sign_type') !== 'MD5' || !sign || !/^[a-f0-9]{32}$/.test(sign)) throw new Error('Invalid ZPAY signature')
  const expected = signZpayParams(params, credentials.key)
  if (!timingSafeEqual(Buffer.from(sign, 'hex'), Buffer.from(expected, 'hex'))) throw new Error('Invalid ZPAY signature')
  if (params.get('pid') !== credentials.pid || params.get('type') !== 'alipay') throw new Error('Invalid ZPAY merchant or method')
  const number = params.get('out_trade_no') ?? ''
  const tradeNo = params.get('trade_no') ?? ''
  const status = params.get('trade_status')
  if (!merchantOrder.test(number) || !/^[A-Za-z0-9_-]{1,64}$/.test(tradeNo) || status !== 'TRADE_SUCCESS') throw new Error('Invalid ZPAY trade')
  return { orderId: `YMX-${number}`, amountCents: amountCents(params.get('money')), tradeNo }
}

export async function queryZpayOrder(order: PaymentOrder, credentials: Credentials, fetcher: typeof fetch = fetch) {
  validCredentials(credentials)
  const url = new URL('/api.php', providerOrigin)
  url.search = new URLSearchParams({ act: 'order', pid: credentials.pid, key: credentials.key, out_trade_no: zpayMerchantOrderNo(order.id) }).toString()
  let response: Response
  try { response = await fetcher(url.href, { redirect: 'manual', signal: AbortSignal.timeout(4500) }) }
  catch { throw new Error('ZPAY order query unavailable') }
  if (!response.ok || response.status >= 300 || Number(response.headers.get('content-length')) > 16000) throw new Error('ZPAY order query unavailable')
  let record: Record<string, unknown>
  try {
    const raw = await response.text()
    if (raw.length > 16000) throw new Error('large')
    record = JSON.parse(raw) as Record<string, unknown>
  } catch { throw new Error('ZPAY order query malformed') }
  if (record.code !== 1 || String(record.pid) !== credentials.pid || record.out_trade_no !== zpayMerchantOrderNo(order.id) || record.type !== 'alipay' || amountCents(record.money) !== order.amountCents) throw new Error('ZPAY order query mismatch')
  if (record.status !== 0 && record.status !== 1) throw new Error('ZPAY order status unknown')
  if (record.status === 1 && (typeof record.trade_no !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(record.trade_no))) throw new Error('ZPAY paid trade missing')
  return { orderId: order.id, amountCents: order.amountCents, status: record.status === 1 ? 'paid' as const : 'pending' as const, tradeNo: record.status === 1 ? record.trade_no as string : undefined }
}

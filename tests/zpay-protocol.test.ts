import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { parseZpayNotification, queryZpayOrder, signZpayParams, zpayCheckoutUrl } from '../worker/payments/zpay-protocol.ts'
import { zpay } from '../worker/payments/zpay.ts'
import { servicePaymentProviderId, servicePaymentConfigured } from '../worker/payments/providers.ts'
import type { Env } from '../worker/platform.ts'

const credentials = { pid: '202611080001', key: 'local-test-key-keep-private' }
const orderId = `YMX-${'A'.repeat(32)}`

test('ZPAY signing sorts raw values before URL encoding and rejects duplicate fields', () => {
  const params = new URLSearchParams([['type', 'alipay'], ['name', 'ChatGPT Plus 兑换码'], ['money', '1.00'], ['sign_type', 'MD5'], ['empty', '']])
  const canonical = 'money=1.00&name=ChatGPT Plus 兑换码&type=alipay'
  assert.equal(signZpayParams(params, credentials.key), createHash('md5').update(canonical + credentials.key).digest('hex'))
  params.append('money', '999.00')
  assert.throws(() => signZpayParams(params, credentials.key), /Duplicate/)
})

test('checkout link uses a 32 character merchant number and an encoded official HTTPS cashier URL', () => {
  const url = new URL(zpayCheckoutUrl({ id: orderId, amountCents: 13800, subject: '自有库存兑换码', expiresAt: Date.now() + 900000 }, 'https://shop.example.invalid/api/payments/notify/zpay', credentials))
  assert.equal(url.origin, 'https://zpayz.cn')
  assert.equal(url.pathname, '/submit.php')
  assert.equal(url.searchParams.get('out_trade_no'), 'A'.repeat(32))
  assert.equal(url.searchParams.get('name'), '自有库存兑换码')
  assert.equal(url.searchParams.get('money'), '138.00')
  assert.equal(url.searchParams.get('return_url'), 'https://shop.example.invalid/orders')
  assert.equal(url.searchParams.get('sign'), signZpayParams(url.searchParams, credentials.key))
  assert.ok(!url.href.includes(credentials.key))
  assert.throws(() => zpayCheckoutUrl({ id: 'YMX-TOO-LONG', amountCents: 100, subject: '商品', expiresAt: 0 }, 'https://shop.example.invalid/api/payments/notify/zpay', credentials))
  assert.throws(() => zpayCheckoutUrl({ id: orderId, amountCents: 100, subject: '商品', expiresAt: 0 }, 'http://shop.example.invalid/api/payments/notify/zpay', credentials))
})

test('notification verification rejects forged amounts and duplicate fields before any payment transition', () => {
  const url = new URL('https://shop.example.invalid/api/payments/notify/zpay')
  const params = url.searchParams
  Object.entries({ pid: credentials.pid, type: 'alipay', out_trade_no: 'A'.repeat(32), trade_no: '2026110800001', trade_status: 'TRADE_SUCCESS', money: '138.00', name: '自有库存兑换码' }).forEach(([name, value]) => params.set(name, value))
  params.set('sign_type', 'MD5')
  params.set('sign', signZpayParams(params, credentials.key))
  const request = () => new Request(url.href)
  assert.deepEqual(parseZpayNotification(request(), credentials), { orderId, amountCents: 13800, tradeNo: '2026110800001' })
  params.set('money', '1.00')
  assert.throws(() => parseZpayNotification(request(), credentials), /signature/)
  params.set('money', '138.00')
  params.set('sign', signZpayParams(params, credentials.key))
  params.append('money', '1.00')
  assert.throws(() => parseZpayNotification(request(), credentials), /Duplicate/)
  params.delete('money'); params.set('money', '138.00')
  params.set('trade_status', 'WAIT_BUYER_PAY')
  params.set('sign', signZpayParams(params, credentials.key))
  assert.throws(() => parseZpayNotification(request(), credentials), /trade/)
})

test('gateway order query cross-checks merchant, order, method and amount', async () => {
  const order = { id: orderId, amountCents: 13800, subject: '自有库存兑换码', expiresAt: 0 }
  const record = { code: 1, pid: credentials.pid, out_trade_no: 'A'.repeat(32), type: 'alipay', money: '138.00', status: 1, trade_no: '2026110800001' }
  const mocked = (patch: Record<string, unknown> = {}) => (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://zpayz.cn')
    assert.equal(url.searchParams.get('key'), credentials.key)
    assert.equal(url.searchParams.get('out_trade_no'), 'A'.repeat(32))
    assert.equal(init?.redirect, 'manual')
    return Response.json({ ...record, ...patch })
  }) as typeof fetch
  assert.deepEqual(await queryZpayOrder(order, credentials, mocked()), { orderId, amountCents: 13800, status: 'paid', tradeNo: record.trade_no })
  assert.deepEqual(await queryZpayOrder(order, credentials, mocked({ status: 0 })), { orderId, amountCents: 13800, status: 'pending', tradeNo: undefined })
  await assert.rejects(queryZpayOrder(order, credentials, mocked({ money: '1.00' })), /mismatch/)
  await assert.rejects(queryZpayOrder(order, credentials, mocked({ pid: 'someone-else' })), /mismatch/)
  await assert.rejects(queryZpayOrder(order, credentials, mocked({ status: 1, trade_no: '' })), /missing/)
  await assert.rejects(queryZpayOrder(order, credentials, (async () => new Response('', { status: 302, headers: { location: 'https://evil.invalid/' } })) as typeof fetch), /unavailable/)
})

test('service payment selection only chooses ZPAY with its own credentials', () => {
  const env = { SERVICE_PAYMENT_PROVIDER: 'zpay', ZPAY_PID: credentials.pid, ZPAY_KEY: credentials.key } as Env
  assert.equal(servicePaymentProviderId(env), 'zpay')
  assert.equal(servicePaymentConfigured(env), true)
  assert.equal(servicePaymentConfigured({ ...env, ZPAY_KEY: undefined }), false)
  assert.equal(servicePaymentProviderId({} as Env), 'alipay')
})

test('ZPAY callback requires a matching paid order query before acknowledgement', async t => {
  const params = new URLSearchParams({ pid: credentials.pid, type: 'alipay', out_trade_no: 'A'.repeat(32), trade_no: '2026110800001', trade_status: 'TRADE_SUCCESS', money: '138.00', sign_type: 'MD5' })
  params.set('sign', signZpayParams(params, credentials.key))
  const request = new Request(`https://shop.example.invalid/api/payments/notify/zpay?${params}`)
  let remoteStatus = 0
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 1, pid: credentials.pid, out_trade_no: 'A'.repeat(32), type: 'alipay', money: '138.00', status: remoteStatus, trade_no: '2026110800001' }))
  const provider = zpay(credentials)
  await assert.rejects(provider.notification(request), /mismatch/)
  assert.equal(await provider.acknowledge(false).text(), 'failure')
  remoteStatus = 1
  assert.deepEqual(await provider.notification(request), { orderId, amountCents: 13800, status: 'paid', tradeNo: '2026110800001' })
  assert.equal(await provider.acknowledge(true).text(), 'success')
})

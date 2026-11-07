import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import worker from '../worker/index.ts'
import { customerFixture } from './customer-fixture.ts'
import { canonical } from '../worker/payments/alipay.ts'

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config = {
  ALIPAY_APP_ID: '2026000000000000', ALIPAY_SELLER_ID: '2088000000000000',
  ALIPAY_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  ALIPAY_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  PAYMENT_NOTIFY_ORIGIN: 'https://shop.example.invalid',
}
const signature = (raw: string) => sign('RSA-SHA256', Buffer.from(raw), keys.privateKey).toString('base64')
type Context = Parameters<Parameters<typeof test>[1]>[0]
async function setup(t: Context) {
  const s = await customerFixture(); t.after(() => s.db.close())
  Object.assign(s.env, config)
  const agent = await s.agent('开票代理'); const other = await s.agent('另一位代理')
  const draft = { key: crypto.randomUUID(), title: '测试企业有限公司', taxNumber: '记录原样税号', invoiceType: 'ordinary', email: 'invoice@example.test', baseCents: 14000, includeFee: true }
  const create = (data: unknown = draft, cookie = agent.cookie) => s.request('/api/partner/invoices', data, cookie)
  const pay = (id = draft.key, action = 'create', cookie = agent.cookie) => s.request(`/api/partner/invoices/${id}/payment`, { action }, cookie)
  const payment = () => s.db.prepare('SELECT * FROM invoice_payments WHERE invoice_id=? ORDER BY created_at DESC').get(draft.key)!
  const invoice = () => s.db.prepare('SELECT * FROM partner_invoices WHERE id=?').get(draft.key)!
  async function notify(patch: Record<string, string> = {}) {
    const p = payment()
    const values = { app_id: config.ALIPAY_APP_ID, seller_id: config.ALIPAY_SELLER_ID, sign_type: 'RSA2', out_trade_no: String(p.id), total_amount: '7.00', trade_status: 'TRADE_SUCCESS', trade_no: '202610010000000001', ...patch }
    const form = new URLSearchParams({ ...values, sign: signature(canonical(values, ['sign', 'sign_type'])) })
    return worker.fetch(new Request('https://shop.example.invalid/api/invoices/notify/alipay', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form }), s.env)
  }
  return { ...s, agent, other, draft, create, pay, payment, invoice, notify }
}
function gateway(t: Context, handler: (method: string, biz: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>) {
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://openapi.alipay.com/gateway.do')
    const params = Object.fromEntries(new URLSearchParams(String(options.body)))
    assert.ok(verify('RSA-SHA256', Buffer.from(canonical(params)), keys.publicKey, Buffer.from(params.sign, 'base64')))
    if (params.method === 'alipay.trade.precreate') assert.equal(params.notify_url, 'https://shop.example.invalid/api/invoices/notify/alipay')
    const raw = JSON.stringify(await handler(params.method, JSON.parse(params.biz_content)))
    return new Response(`{"${params.method.replaceAll('.', '_')}_response":${raw},"sign":"${signature(raw)}"}`)
  })
}
const precreate = (_method: string, biz: Record<string, unknown>) => ({ code: '10000', out_trade_no: biz.out_trade_no, qr_code: 'https://qr.alipay.com/invoice-fixture' })

test('invoice options exposes the configured payment method without creating a charge',async t=>{
  const s=await setup(t);await s.create();let calls=0
  gateway(t,(method,biz)=>{calls++;return precreate(method,biz)})
  const response=await s.pay(s.draft.key,'options');assert.equal(response.status,200,await response.clone().text())
  const data=await response.json();assert.deepEqual(data.methods,[{method:'alipay',name:'支付宝',feeBps:0}]);assert.equal(data.payment,null);assert.equal(calls,0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM invoice_payments').get()!.n,0)
  const paid=await s.request(`/api/partner/invoices/${s.draft.key}/payment`,{action:'create',method:'alipay'},s.agent.cookie)
  assert.equal(paid.status,200);assert.equal((await paid.json()).payment.provider,'alipay');assert.equal(calls,1)
  assert.equal((await s.pay(s.draft.key,'options',s.other.cookie)).status,404)
})
test('invoice methods fail closed when configuration is missing and reject unsupported choices',async t=>{
  const s=await setup(t);await s.create();t.mock.method(globalThis,'fetch',async()=>{throw new Error('Must not contact a payment channel')})
  delete s.env.ALIPAY_APP_PRIVATE_KEY
  const unavailable=await s.pay(s.draft.key,'options');assert.equal(unavailable.status,200)
  assert.deepEqual((await unavailable.json()).methods,[])
  Object.assign(s.env,config)
  assert.equal((await s.request(`/api/partner/invoices/${s.draft.key}/payment`,{action:'create',method:'wxpay'},s.agent.cookie)).status,400)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM invoice_payments').get()!.n,0)
})

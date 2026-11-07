import test from 'node:test'
import assert from 'node:assert/strict'
import worker from '../worker/index.ts'
import { customerFixture } from './customer-fixture.ts'
import { queryPlatformOrder } from '../worker/recharge/service.ts'
import { getOrder } from '../worker/order-state.ts'
import { reconcileRechargeRefunds } from '../worker/refunds.ts'

type Context = Parameters<Parameters<typeof test>[1]>[0]
async function setup(t: Context) {
  let now = Date.now(); t.mock.method(Date, 'now', () => now)
  const s = await customerFixture(); t.after(() => s.db.close())
  const buyer = (await s.request('/api/orders/client', {})).headers.get('Set-Cookie')!.split(';')[0]
  const created = await s.request('/api/orders', { plan: 'plus', email: 'buyer@example.test', expectedPrice: 13900, key: crypto.randomUUID() }, buyer)
  assert.equal(created.status, 201)
  const id = (await created.json()).order.id as string
  Object.assign(s.env, { RECHARGE_PARTNER_ID: 'fixture-partner', RECHARGE_KEY_ID: 'fixture-key', RECHARGE_CLIENT_SECRET: 'fixture-secret' })
  s.db.prepare("UPDATE orders SET mode='live',payment_status='paid',status='session' WHERE id=?").run(id)
  s.db.prepare("INSERT INTO recharge_orders(order_id,account,product_code,collection_mode,create_body,remote_id,payment_status,expires_at,updated_at,supply_cents,merchant_margin_cents,financial_hold) VALUES (?,?,?,'platform_collect',?,'remote_original','paid',?,?,11000,2900,0)").run(id,'https://recharge.example.invalid:fixture-partner','fixture_plus',JSON.stringify({payment_channel:'alipay'}),Date.now()+900000,Date.now())
  const remote = { order_id:'remote_original',merchant_order_no:id,product_code:'fixture_plus',quantity:1,currency:'CNY',collection_mode:'platform_collect',payment_scope:'retail',delivery_mode:'auto_recharge',sale_amount:'139.00',supply_amount:'110.00',merchant_margin:'29.00',payment_status:'paid',expires_at:new Date(Date.now()+900000).toISOString(),refunded_amount:'0.00' }
  const calls: {path:string;method:string}[] = []
  let refund: {refund_id:string;order_id:string;merchant_refund_no:string;amount:string;status:string} | undefined
  let failRead = false
  let pollAfter = 0
  let refundPollAfter = 0
  let onRead: (() => void) | undefined
  t.mock.method(globalThis,'fetch',async (input:string,options:RequestInit) => {
    const url = new URL(input); assert.equal(url.origin,'https://recharge.example.invalid'); calls.push({path:url.pathname,method:options.method!})
    if (url.pathname === '/v1/orders/remote_original' && options.method === 'GET') {
      onRead?.()
      if (failRead) return Response.json({error:{code:'temporarily_unavailable',retryable:true}},{status:503})
      return Response.json({data:remote},{headers:pollAfter?{'X-Poll-After':String(pollAfter)}:{}})
    }
    if (url.pathname === '/v1/orders/remote_original/refunds' && options.method === 'POST') {
      const data=JSON.parse(String(options.body));refund={refund_id:'refund_original',order_id:remote.order_id,merchant_refund_no:data.merchant_refund_no,amount:data.amount,status:'requested'}
      return Response.json({data:refund},{status:202})
    }
    if (url.pathname === '/v1/refunds/refund_original' && options.method === 'GET') return Response.json({data:refund},{headers:refundPollAfter?{'X-Poll-After':String(refundPollAfter)}:{}})
    throw new Error('Unexpected external request')
  })
  const advance = () => { now += 301000 }
  const sync = async () => { advance(); return queryPlatformOrder(s.env,await getOrder(s.env,id)) }
  const apply = async () => {
    const o=await getOrder(s.env,id);const r=await s.request(`/api/orders/${id}/refunds`,{reason:'原订单售后',key:crypto.randomUUID(),version:o.version},buyer);assert.equal(r.status,201,await r.clone().text())
    return s.db.prepare('SELECT * FROM refund_cases WHERE order_id=?').get(id)!
  }
  const external = () => { advance(); return s.request('/api/admin/refunds/reconcile-external',{},s.admin) }
  const setExternal = (amount='139.00',margin='-110.00') => Object.assign(remote,{refunded_amount:amount,merchant_margin:margin,payment_status:amount==='139.00'?'refunded':'partially_refunded'})
  return {...s,id,buyer,remote,calls,sync,apply,external,advance,setExternal,setPollAfter:(seconds:number)=>{pollAfter=seconds},setRefundPollAfter:(seconds:number)=>{refundPollAfter=seconds},setFailRead:(value:boolean)=>{failRead=value},onRead:(callback:()=>void)=>{onRead=callback},succeedRefund:()=>{refund!.status='succeeded';setExternal()}}
}

test('UI approval submits the original platform refund once and preserves pending until confirmed',async t=>{
  const s=await setup(t), row=await s.apply()
  const request={action:'approve-submit-platform',version:0,amountCents:13900,note:'审核通过，提交平台'}
  const response=await s.request('/api/admin/refunds/'+row.id,request,s.admin)
  assert.equal(response.status,202,await response.clone().text())
  assert.equal(s.db.prepare('SELECT status FROM refund_cases').get()!.status,'approved')
  assert.equal(s.calls.filter(c=>c.method==='POST').length,1)
  assert.equal((await s.request('/api/admin/refunds/'+row.id,request,s.admin)).status,409)
  assert.equal(s.calls.filter(c=>c.method==='POST').length,1)
  const detail=await (await s.request('/api/admin/refunds/'+row.id,undefined,s.admin)).json()
  assert.equal(detail.upstreamRefund.status,'requested')
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,0)
  s.succeedRefund();assert.equal((await reconcileRechargeRefunds(s.env)).completed,1)
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,13900)
  assert.equal((await reconcileRechargeRefunds(s.env)).checked,0)
  assert.equal(s.calls.filter(c=>c.method==='POST').length,1)
})

test('external refunds with no local case are freshly verified and reconciled once without money writes',async t=>{
  const s=await setup(t);s.setExternal();await s.sync()
  const responses=await Promise.all([s.external(),s.external()])
  for(const r of responses)assert.equal(r.status,200,await r.clone().text())
  const o=await getOrder(s.env,s.id);assert.equal(o.refunded_cents,13900);assert.equal(o.refund_hold,0)
  assert.equal(s.db.prepare('SELECT financial_hold FROM recharge_orders').get()!.financial_hold,0)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM refund_cases WHERE status='refunded'").get()!.n,1)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM refund_events').get()!.n,1)
  assert.equal(s.calls.filter(c=>c.method!=='GET').length,0)
  await s.external();assert.equal(s.db.prepare('SELECT COUNT(*) n FROM refund_cases').get()!.n,1)
})

test('external refund verification failure or changed identity cannot clear the financial hold',async t=>{
  const s=await setup(t);s.setExternal();await s.sync();s.setFailRead(true)
  assert.equal((await s.external()).status,200)
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM refund_cases').get()!.n,0)
  s.setFailRead(false);s.remote.merchant_order_no='wrong-order'
  await s.external();assert.equal((await getOrder(s.env,s.id)).refunded_cents,0)
  assert.equal(s.db.prepare('SELECT financial_hold FROM recharge_orders').get()!.financial_hold,1)
})

test('external reconciliation preserves an existing customer case and rejects unauthenticated triggers',async t=>{
  const s=await setup(t);const row=await s.apply();s.setExternal();await s.sync()
  assert.equal((await s.request('/api/admin/refunds/reconcile-external',{},s.buyer)).status,401)
  assert.equal((await s.request('/api/admin/refunds/reconcile-external',{},s.admin,'https://other.invalid')).status,403)
  assert.equal((await s.external()).status,200)
  assert.equal(s.db.prepare('SELECT status FROM refund_cases WHERE id=?').get(row.id)!.status,'pending')
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,0)
  assert.equal(s.calls.filter(c=>c.method!=='GET').length,0)
})

test('external cumulative refunds deduct paid commission only once and defer pending transfers',async t=>{
  const s=await setup(t);const agent=await s.agent('已提现代理');const now=Date.now()
  s.db.prepare("INSERT INTO partner_payouts(id,partner_id,amount_cents,gross_cents,status,recipient,created_at,request_key) VALUES ('paid-case',?,2900,2900,'pending','fixture',?,'fixture')").run(agent.id,now)
  s.db.prepare("UPDATE orders SET status='success',partner_id=?,cost_cents=11000,payout_id='paid-case' WHERE id=?").run(agent.id,s.id)
  s.db.prepare("INSERT INTO partner_payout_items(payout_id,order_id,profit_cents) VALUES ('paid-case',?,2900)").run(s.id)
  s.setExternal('10.00','19.00');await s.sync();await s.external()
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,0)
  s.db.prepare("UPDATE partner_payouts SET status='paid' WHERE id='paid-case'").run()
  await s.external();assert.equal((await getOrder(s.env,s.id)).refunded_cents,1000)
  assert.equal(s.db.prepare('SELECT SUM(amount_cents) n FROM partner_debits').get()!.n,1000)
  await s.external();assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_debits').get()!.n,1)
  s.setExternal();await s.sync();await s.external()
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,13900)
  assert.equal(s.db.prepare('SELECT SUM(amount_cents) n FROM partner_debits').get()!.n,2900)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_debits').get()!.n,2)
})

test('external reconciliation rolls back all accounting when its audit insert fails',async t=>{
  const s=await setup(t);s.setExternal();await s.sync()
  s.db.exec("CREATE TRIGGER fail_external BEFORE INSERT ON refund_events BEGIN SELECT RAISE(ABORT,'fixture'); END")
  await s.external();assert.equal((await getOrder(s.env,s.id)).refunded_cents,0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM refund_cases').get()!.n,0)
  assert.equal(s.db.prepare('SELECT financial_hold FROM recharge_orders').get()!.financial_hold,1)
  s.db.exec('DROP TRIGGER fail_external');await s.external()
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,13900)
})


test('an existing approved case retains its manual reconciliation path without a second refund',async t=>{
  const s=await setup(t);const row=await s.apply()
  assert.equal((await s.request('/api/admin/refunds/'+row.id,{action:'approve',version:0,amountCents:13900,note:'同意原订单退款'},s.admin)).status,200)
  s.setExternal();await s.sync();await s.external()
  assert.equal(s.db.prepare('SELECT status FROM refund_cases WHERE id=?').get(row.id)!.status,'approved')
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,0)
  const response=await s.request('/api/admin/refunds/'+row.id,{action:'reconcile-platform-refund',version:1,note:'核对平台已退款'},s.admin)
  assert.equal(response.status,200,await response.clone().text())
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,13900)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM refund_cases').get()!.n,1)
  assert.equal(s.calls.filter(c=>c.method!=='GET').length,0)
})

test('a regressing upstream refund snapshot cannot authorize previously cached money',async t=>{
  const s=await setup(t);s.setExternal('10.00','19.00');await s.sync()
  s.setExternal('5.00','24.00');await s.external()
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM refund_cases').get()!.n,0)
  assert.equal(s.db.prepare('SELECT financial_hold FROM recharge_orders').get()!.financial_hold,1)
})

test('concurrent order changes invalidate the external accounting transaction',async t=>{
  const s=await setup(t);s.setExternal();await s.sync()
  const original=s.env.INTEREST_DB.batch.bind(s.env.INTEREST_DB);let batches=0
  const mock=t.mock.method(s.env.INTEREST_DB,'batch',async statements=>{
    if (++batches===2) s.db.prepare('UPDATE orders SET version=version+1 WHERE id=?').run(s.id)
    return original(statements)
  })
  await s.external()
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM refund_cases').get()!.n,0)
  assert.equal(s.db.prepare('SELECT financial_hold FROM recharge_orders').get()!.financial_hold,1)
  mock.mock.restore();await s.external()
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,13900)
})

test('external reconciliation honors supplier cooldown and the next scheduled run can finish it',async t=>{
  const s=await setup(t);s.setPollAfter(300);s.setExternal();await s.sync()
  const before=s.calls.length
  const deferred=await s.request('/api/admin/refunds/reconcile-external',{},s.admin)
  assert.equal(deferred.status,200)
  assert.deepEqual(await deferred.json(),{checked:1,completed:0,pending:1})
  assert.equal(s.calls.length,before)
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,0)
  s.advance();await worker.scheduled({scheduledTime:0},s.env)
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,13900)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM refund_cases').get()!.n,1)
  assert.equal(s.calls.filter(c=>c.method!=='GET').length,0)
})

test('scheduled refund reconciliation cannot be starved by ordinary order polling',async t=>{
  const s=await setup(t), row=await s.apply()
  assert.equal((await s.request('/api/admin/refunds/'+row.id,{action:'approve-submit-platform',version:0,amountCents:13900,note:'审核原订单退款'},s.admin)).status,202)
  s.succeedRefund();s.setPollAfter(300);s.setRefundPollAfter(300)
  for(let run=0;run<3;run++){s.advance();await worker.scheduled({scheduledTime:0},s.env)}
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,13900)
  assert.equal(s.db.prepare('SELECT status FROM refund_cases WHERE id=?').get(row.id)!.status,'refunded')
  assert.equal(s.db.prepare('SELECT financial_hold FROM recharge_orders').get()!.financial_hold,0)
  assert.equal(s.calls.filter(c=>c.method==='POST').length,1)
})

test('scheduled refund reconciliation recovers when order and refund polling windows differ',async t=>{
  const s=await setup(t), row=await s.apply()
  assert.equal((await s.request('/api/admin/refunds/'+row.id,{action:'approve-submit-platform',version:0,amountCents:13900,note:'审核原订单退款'},s.admin)).status,202)
  s.succeedRefund();s.setPollAfter(300);s.setRefundPollAfter(600)
  // A customer order refresh consumes the order window before the first refund
  // confirmation. The successful refund read then starts its own longer window.
  await s.sync()
  assert.equal((await reconcileRechargeRefunds(s.env)).pending,1)
  assert.equal(s.db.prepare('SELECT status FROM recharge_refunds').get()!.status,'succeeded')
  s.advance();await worker.scheduled({scheduledTime:0},s.env)
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,0)
  for(let run=0;run<3;run++){s.advance();await worker.scheduled({scheduledTime:0},s.env)}
  assert.equal((await getOrder(s.env,s.id)).refunded_cents,13900)
  assert.equal(s.db.prepare('SELECT status FROM refund_cases WHERE id=?').get(row.id)!.status,'refunded')
  assert.equal(s.calls.filter(c=>c.method==='POST').length,1)
})

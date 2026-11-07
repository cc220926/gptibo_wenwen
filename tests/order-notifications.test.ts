import test from 'node:test'
import assert from 'node:assert/strict'
import { customerFixture } from './customer-fixture.ts'
import { sendDueOrderNotifications } from '../worker/order-notifications.ts'

const NOW = 1_800_000_000_000
const SINCE = NOW - 3_600_000
async function setup(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const s = await customerFixture(); t.after(() => s.db.close())
  t.mock.method(Date, 'now', () => NOW)
  Object.assign(s.env, { RESEND_API_KEY:'test', RESEND_FROM:'Store <orders@mail-store.example.test>', MAIL_PUBLIC_ORIGIN:'https://mail-store.example.test', MAIL_BRAND_NAME:'测试商城', ORDER_EMAIL_NOTIFICATIONS_ENABLED:'true', ORDER_EMAIL_NOTIFICATIONS_SINCE:new Date(SINCE).toISOString() })
  function order(id: string, status = 'session', action = 'payment-confirmed', when = NOW - 1000) {
    s.db.prepare(`INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,payment_status,status,customer_email,created_at,updated_at,last_event_id,version)
      VALUES (?,?,?,'plus','ChatGPT <Plus>',13900,'live','paid',?,'buyer@example.test',?,?,?,1)`).run(id,'owner',id,status,when-1000,when,'event-'+id)
    s.db.prepare(`INSERT INTO recharge_orders(order_id,account,product_code,collection_mode,create_body,remote_id,payment_status,updated_at,verified_at,financial_hold)
      VALUES (?,'account','plus','platform_collect','{}',?,'paid',?,?,0)`).run(id,'remote-'+id,when,when)
    s.db.prepare(`INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at)
      VALUES (?,?,'system',?,'processing',?,'NEVER SEND PRIVATE EVENT NOTE',1,?)`).run('event-'+id,id,action,status,when)
    return id
  }
  function attempt(id: string, status: string, number = 1, when = NOW - 2000) {
    s.db.prepare(`INSERT INTO recharge_redemptions(id,order_id,attempt_no,request_hash,credential_mode,remote_id,status,created_at)
      VALUES (?,?,?,'hash','session',?,?,?)`).run('attempt-'+id+'-'+number,id,number,'redemption-'+id+'-'+number,status,when)
  }
  function refund(id: string, amount = 3900, status = 'refunded') {
    const eventId = 'refund-event-'+id
    s.db.prepare(`INSERT INTO refund_cases(id,order_id,request_key,reason,status,requested_cents,approved_cents,reference,created_at,updated_at,last_event_id)
      VALUES (?,?,?,'private reason',?,?,?,'private-reference',?,?,?)`).run('case-'+id,id,id,status,amount,amount,NOW-1000,NOW,eventId)
    s.db.prepare("INSERT INTO refund_events(id,case_id,status,note,actor,created_at) VALUES (?,?,?,'private refund note','system',?)").run(eventId,'case-'+id,status,NOW)
    if (status === 'refunded') {
      s.db.prepare('UPDATE orders SET refunded_cents=? WHERE id=?').run(amount,id)
      s.db.prepare("UPDATE recharge_orders SET refunded_cents=?,payment_status=? WHERE order_id=?").run(amount,amount===13900?'refunded':'partially_refunded',id)
    }
  }
  const mails: { body:Record<string,unknown>; raw:string; key:string|null }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url,'https://api.resend.com/emails')
    mails.push({body:JSON.parse(String(init.body)),raw:String(init.body),key:new Headers(init.headers).get('Idempotency-Key')})
    return Response.json({id:'test-message-'+mails.length})
  })
  return {...s,order,attempt,refund,mails}
}

test('verified payment creates one durable email with safe order recovery link and escaped text', async t => {
  const s = await setup(t); s.order('paid')
  assert.equal((await sendDueOrderNotifications(s.env)).sent,1)
  await sendDueOrderNotifications(s.env)
  assert.equal(s.mails.length,1)
  assert.deepEqual(s.mails[0].body.to,['buyer@example.test'])
  assert.match(String(s.mails[0].body.subject),/付款已确认/)
  assert.match(String(s.mails[0].body.text),/139\.00/)
  assert.match(String(s.mails[0].body.text),/https:\/\/mail-store\.example\.test\/orders/)
  assert.match(String(s.mails[0].body.text),/下单邮箱.*验证码/)
  assert.match(String(s.mails[0].body.html),/ChatGPT &lt;Plus&gt;/)
  assert.doesNotMatch(s.mails[0].raw,/PRIVATE|private-reference|\/orders\?|\/api\/orders|remote-paid|Session|request_hash/)
  assert.equal(s.db.prepare('SELECT status FROM order_email_notifications').get()!.status,'sent')
})

test('disabled or missing/invalid cutoff sends nothing; historical orders and demo/test are excluded', async t => {
  const s = await setup(t); s.order('current'); s.order('history','session','payment-confirmed',SINCE-1000)
  s.order('old-order-new-event'); s.db.prepare("UPDATE orders SET created_at=? WHERE id='old-order-new-event'").run(SINCE-1)
  s.order('test'); s.order('demo')
  s.db.prepare("UPDATE orders SET is_test=1 WHERE id='test'").run()
  s.db.prepare("UPDATE orders SET mode='demo',payment_status='simulated' WHERE id='demo'").run()
  for(const since of ['', 'yesterday', '2026-11-07']) { s.env.ORDER_EMAIL_NOTIFICATIONS_SINCE=since; await sendDueOrderNotifications(s.env) }
  s.env.ORDER_EMAIL_NOTIFICATIONS_SINCE=new Date(SINCE).toISOString(); s.env.ORDER_EMAIL_NOTIFICATIONS_ENABLED='false'
  await sendDueOrderNotifications(s.env); assert.equal(s.mails.length,0)
  s.env.ORDER_EMAIL_NOTIFICATIONS_ENABLED='true'; await sendDueOrderNotifications(s.env)
  assert.equal(s.mails.length,1)
  assert.match(String(s.mails[0].body.text),/current/)
})

test('success and definite current task failure notify; unknown/rejected task and stale attempt do not', async t => {
  const s = await setup(t)
  s.order('success','success','recharge-status'); s.attempt('success','succeeded')
  s.order('failure','failed','recharge-status'); s.attempt('failure','failed')
  s.order('manual','success','platform-fulfillment-completed'); s.attempt('manual','failed')
  for (const id of ['unknown','rejected','old']) { s.order(id,'failed','recharge-status'); s.attempt(id,id==='old'?'failed':id) }
  s.attempt('old','failed',2,NOW)
  s.db.prepare("INSERT INTO order_events VALUES ('new-submit','old','customer','recharge-submit','failed','processing','',2,?)").run(NOW)
  assert.equal((await sendDueOrderNotifications(s.env)).sent,3)
  assert.equal(s.mails.filter(m=>String(m.body.subject).includes('充值已完成')).length,2)
  assert.equal(s.mails.filter(m=>String(m.body.subject).includes('充值未完成')).length,1)
})

test('a completed result suppresses queued payment mail; pending refund never claims a refund', async t => {
  const s = await setup(t)
  s.order('complete'); s.attempt('complete','succeeded')
  s.db.prepare("UPDATE orders SET status='success',version=2 WHERE id='complete'").run()
  s.db.prepare("INSERT INTO order_events VALUES ('complete-event','complete','system','recharge-status','processing','success','',2,?)").run(NOW)
  s.order('refund-pending'); s.refund('refund-pending',3900,'approved')
  s.db.prepare("UPDATE orders SET refund_hold=1 WHERE id='refund-pending'").run()
  await sendDueOrderNotifications(s.env)
  assert.equal(s.mails.length,1); assert.match(String(s.mails[0].body.subject),/充值已完成/)
})

test('confirmed partial refund shows this case amount, excludes private notes and suppresses old payment', async t => {
  const s=await setup(t); s.order('refunded'); s.refund('refunded')
  await sendDueOrderNotifications(s.env); await sendDueOrderNotifications(s.env)
  assert.equal(s.mails.length,1); assert.match(String(s.mails[0].body.subject),/退款已确认/)
  assert.match(String(s.mails[0].body.text),/39\.00/)
  assert.doesNotMatch(s.mails[0].raw,/private reason|private-reference|private refund note/)
})

test('multiple confirmed refund cases each notify their own amount once', async t => {
  const s=await setup(t); s.order('partial'); s.refund('partial',3900)
  await sendDueOrderNotifications(s.env)
  s.db.prepare("INSERT INTO refund_cases(id,order_id,request_key,reason,status,requested_cents,approved_cents,reference,created_at,updated_at,last_event_id) VALUES ('second-case','partial','second-request','reason','refunded',1000,1000,'confirmed-second-reference',?,?,'second-event')").run(NOW,NOW)
  s.db.prepare("INSERT INTO refund_events VALUES ('second-event','second-case','refunded','','system',?)").run(NOW)
  s.db.prepare("UPDATE orders SET refunded_cents=4900 WHERE id='partial'").run()
  s.db.prepare("UPDATE recharge_orders SET refunded_cents=4900 WHERE order_id='partial'").run()
  await sendDueOrderNotifications(s.env); await sendDueOrderNotifications(s.env)
  assert.equal(s.mails.length,2)
  assert.match(String(s.mails[0].body.text),/39\.00/); assert.match(String(s.mails[1].body.text),/10\.00/)
  assert.doesNotMatch(String(s.mails[1].body.text),/49\.00/)
  assert.notEqual(s.mails[0].key,s.mails[1].key)
})

test('financial holds and unverified payment wait without sending and resume after local verification', async t => {
  const s=await setup(t); s.order('held'); s.order('unverified')
  s.db.prepare("UPDATE recharge_orders SET financial_hold=1 WHERE order_id='held'").run()
  s.db.prepare("UPDATE recharge_orders SET verified_at=NULL WHERE order_id='unverified'").run()
  await sendDueOrderNotifications(s.env); assert.equal(s.mails.length,0)
  s.db.prepare('UPDATE recharge_orders SET financial_hold=0,verified_at=?').run(NOW)
  t.mock.method(Date,'now',()=>NOW+60_000)
  assert.equal((await sendDueOrderNotifications(s.env)).sent,2)
})

test('network retries reuse byte-identical from, recipient, body and idempotency key despite configuration changes', async t => {
  const s=await setup(t); s.order('retry'); const attempts:{body:string;key:string|null}[]=[]
  t.mock.method(globalThis,'fetch',async (_url:string,init:RequestInit)=>{
    attempts.push({body:String(init.body),key:new Headers(init.headers).get('Idempotency-Key')})
    if(attempts.length===1) throw new Error('ambiguous timeout')
    return Response.json({id:'sent-on-retry'})
  })
  assert.equal((await sendDueOrderNotifications(s.env)).failed,1)
  await sendDueOrderNotifications(s.env); assert.equal(attempts.length,1)
  s.env.RESEND_FROM='Rotated <other@example.test>'; s.env.MAIL_PUBLIC_ORIGIN='https://rotated.example.test'
  s.db.prepare("UPDATE orders SET customer_email='different@example.test',plan_name='changed' WHERE id='retry'").run()
  t.mock.method(Date,'now',()=>NOW+60_000)
  assert.equal((await sendDueOrderNotifications(s.env)).sent,1)
  assert.deepEqual(attempts[0],attempts[1])
})

test('overlapping schedulers claim once and uncertain delivery is quarantined after 23 hours', async t => {
  const s=await setup(t); s.order('concurrent')
  await Promise.all([sendDueOrderNotifications(s.env),sendDueOrderNotifications(s.env)])
  assert.equal(s.mails.length,1)
  s.order('ambiguous')
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('timeout')})
  await sendDueOrderNotifications(s.env)
  t.mock.method(Date,'now',()=>NOW+23*3_600_000)
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('must not resend after idempotency safety window')})
  await sendDueOrderNotifications(s.env)
  assert.equal(s.db.prepare("SELECT status FROM order_email_notifications WHERE order_id='ambiguous'").get()!.status,'manual_review')
})

test('a failed-attempt notification is cancelled if customer starts a retry before the email retry', async t => {
  const s=await setup(t); s.order('superseded','failed','recharge-status'); s.attempt('superseded','failed')
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('timeout')})
  await sendDueOrderNotifications(s.env)
  s.attempt('superseded','running',2,NOW+1)
  s.db.prepare("UPDATE orders SET status='processing' WHERE id='superseded'").run()
  t.mock.method(Date,'now',()=>NOW+60_000)
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('must not send stale failure')})
  await sendDueOrderNotifications(s.env)
  assert.equal(s.db.prepare('SELECT status FROM order_email_notifications').get()!.status,'cancelled')
})

test('HTTP 200 without a provider receipt stays pending and does not claim delivery', async t => {
  const s=await setup(t); s.order('unconfirmed')
  t.mock.method(globalThis,'fetch',async()=>Response.json({}))
  assert.equal((await sendDueOrderNotifications(s.env)).failed,1)
  const row=s.db.prepare('SELECT status,provider_message_id,delivered_at FROM order_email_notifications').get()!
  assert.equal(row.status,'pending'); assert.equal(row.provider_message_id,null); assert.equal(row.delivered_at,null)
})

test('provider acceptance followed by a local write failure retries the same idempotent request', async t => {
  const s=await setup(t); s.order('write-failure')
  const original=s.env.INTEREST_DB.prepare.bind(s.env.INTEREST_DB); let failOnce=true
  t.mock.method(s.env.INTEREST_DB,'prepare',(sql:string)=>{
    const statement=original(sql)
    if(sql.includes("SET status='sent'") && failOnce) {
      statement.run=async()=>{failOnce=false; throw new Error('local commit failed')}
    }
    return statement
  })
  assert.equal((await sendDueOrderNotifications(s.env)).failed,1)
  assert.equal(s.db.prepare('SELECT status FROM order_email_notifications').get()!.status,'pending')
  t.mock.method(Date,'now',()=>NOW+60_000)
  assert.equal((await sendDueOrderNotifications(s.env)).sent,1)
  assert.equal(s.mails.length,2); assert.equal(s.mails[0].raw,s.mails[1].raw); assert.equal(s.mails[0].key,s.mails[1].key)
})

test('a refund discovered while preparing payment email prevents the obsolete network call', async t => {
  const s=await setup(t); s.order('race')
  const original=s.env.INTEREST_DB.prepare.bind(s.env.INTEREST_DB)
  t.mock.method(s.env.INTEREST_DB,'prepare',(sql:string)=>{
    const statement=original(sql)
    if(sql.includes('payload_json=COALESCE')) {
      const run=statement.run.bind(statement)
      statement.run=async()=>{const result=await run(); s.refund('race'); return result}
    }
    return statement
  })
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('payment email became obsolete during preparation')})
  assert.equal((await sendDueOrderNotifications(s.env)).sent,0)
  assert.equal(s.db.prepare('SELECT status FROM order_email_notifications').get()!.status,'cancelled')
  assert.equal(s.db.prepare('SELECT first_attempt_at FROM order_email_notifications').get()!.first_attempt_at,null)
})

test('an expired lease during preparation does not send from a stale worker', async t => {
  const s=await setup(t); s.order('lost-lease')
  const original=s.env.INTEREST_DB.prepare.bind(s.env.INTEREST_DB)
  t.mock.method(s.env.INTEREST_DB,'prepare',(sql:string)=>{
    const statement=original(sql)
    if(sql.includes('payload_json=COALESCE')) {
      const run=statement.run.bind(statement)
      statement.run=async()=>{const result=await run(); s.db.prepare("UPDATE order_email_notifications SET lock_token='other-worker',locked_until=?").run(NOW+120_000); return result}
    }
    return statement
  })
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('worker without lease must not send')})
  await sendDueOrderNotifications(s.env)
  assert.equal(s.db.prepare('SELECT status FROM order_email_notifications').get()!.status,'pending')
})

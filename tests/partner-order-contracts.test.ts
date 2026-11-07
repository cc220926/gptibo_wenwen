import test from 'node:test'
import assert from 'node:assert/strict'
import { customerFixture } from './customer-fixture.ts'

async function setup() {
  const s = await customerFixture(), a = await s.agent('订单代理'), b = await s.agent('其他代理')
  function order(patch: { partner?: string; status?: string; email?: string | null; plan?: string; name?: string; time?: number } = {}) {
    const id = crypto.randomUUID(), now = patch.time ?? Date.now()
    s.db.prepare(`INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,cost_cents,mode,payment_status,status,created_at,updated_at,last_event_id,partner_id,customer_email)
      VALUES (?,?,?,?,?,13900,11300,'live','paid',?,?,?,?,?,?)`).run(id, 'private-owner-hash', 'private-key-' + id, patch.plan ?? 'plus', patch.name ?? 'Plus 套餐', patch.status ?? 'success', now, now, id, patch.partner ?? a.id, patch.email === undefined ? 'buyer@example.invalid' : patch.email)
    return id
  }
  return { ...s, a, b, order }
}

test('partner order search and status filters match the UI and keep counts and pagination scoped', async t => {
  const s = await setup(); t.after(() => s.db.close())
  for (let i = 0; i < 23; i++) s.order({ email: 'match@example.invalid', status: 'failed', time: 1000 + i })
  s.order({ email: 'match@example.invalid', status: 'success' })
  s.order({ email: 'other@example.invalid', status: 'failed' })
  s.order({ partner: s.b.id, email: 'match@example.invalid', status: 'failed' })
  const url = '/api/partner/orders?q=MATCH%40EXAMPLE.INVALID&status=failed&page='
  const first = await s.request(url + '1', undefined, s.a.cookie).then(r => r.json())
  const second = await s.request(url + '2', undefined, s.a.cookie).then(r => r.json())
  assert.equal(first.total, 23); assert.equal(second.total, 23)
  assert.equal(first.rows.length, 20); assert.equal(second.rows.length, 3)
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 23)
  assert.ok(first.rows.every(row => row.status === 'failed' && row.customer_email === 'match@example.invalid'))
  const preview = await s.request(`/api/admin/partners/${s.a.id}/orders?q=match&status=failed&page=2`, undefined, s.admin).then(r => r.json())
  assert.deepEqual(preview, second)
})

test('partner search treats literals safely, supports order and product fields, and validates filters', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const id = s.order({ email: null, plan: 'pro-5x', name: 'Pro 特别套餐' })
  s.order()
  for (const q of [id.toUpperCase(), 'PRO-5X', '特别套餐']) {
    const result = await s.request('/api/partner/orders?q=' + encodeURIComponent(q), undefined, s.a.cookie).then(r => r.json())
    assert.equal(result.total, 1); assert.equal(result.rows[0].id, id)
  }
  for (const q of ["' OR 1=1 --", '%', '_']) assert.equal((await s.request('/api/partner/orders?q=' + encodeURIComponent(q), undefined, s.a.cookie).then(r => r.json())).total, 0)
  for (const suffix of ['?status=arbitrary', '?q=' + 'x'.repeat(321), '?page=0']) assert.equal((await s.request('/api/partner/orders' + suffix, undefined, s.a.cookie)).status, 400)
})

test('partner detail returns only owned public fields and redacted order and refund history', async t => {
  const s = await setup(); t.after(() => s.db.close())
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('No supplier reads allowed') })
  const id = s.order({ status: 'processing' }), other = s.order({ partner: s.b.id })
  s.db.prepare("INSERT INTO recharge_orders(order_id,account,product_code,collection_mode,create_body,remote_id,payment_status,updated_at,merchant_margin_cents) VALUES (?,'private-account','plus','platform_collect','private-create-body','remote-order','paid',?,2600)").run(id, Date.now())
  const key = crypto.randomUUID()
  s.db.prepare("INSERT INTO recharge_redemptions(id,order_id,attempt_no,request_hash,credential_mode,status,created_at) VALUES (?,?,1,'private-request-hash','session','unknown',?)").run(key, id, Date.now())
  s.db.prepare("INSERT INTO email_deliveries(order_id,kind,value,mail_body,request_key,status,created_at,updated_at) VALUES (?,'cdk','private-delivery-code','private-mail-body',?,'sent',1,1)").run(id, crypto.randomUUID())
  for (const [version, action, actor] of [[1, 'create', 'customer'], [2, 'note', 'admin:private-email'], [3, 'recharge-submit', 'system'], [4, 'redemption-block', 'admin:private-email']] as const) s.db.prepare("INSERT INTO order_events(id,order_id,actor,action,to_status,note,order_version,created_at) VALUES (?,?,?,?,'processing','private-note-with-token',?,?)").run(crypto.randomUUID(), id, actor, action, version, 1000 + version)
  const refund = crypto.randomUUID()
  s.db.prepare("INSERT INTO refund_cases(id,order_id,request_key,reason,requested_cents,status,created_at,updated_at,last_event_id) VALUES (?,?,?,'private-refund-reason',100,'approved',1,1,?)").run(refund, id, refund, refund)
  s.db.prepare("INSERT INTO refund_events(id,case_id,status,note,actor,created_at) VALUES (?,?,'approved','private-refund-note','admin:private-email',2000)").run(crypto.randomUUID(), refund)
  const before = s.db.prepare('SELECT * FROM orders WHERE id=?').get(id)
  const response = await s.request('/api/partner/orders/' + id, undefined, s.a.cookie)
  assert.equal(response.status, 200)
  const detail = await response.json(), serialized = JSON.stringify(detail)
  assert.equal(detail.order.id, id); assert.equal(detail.order.fulfillment.rechargeStatus, 'unknown')
  assert.equal(detail.order.rechargeReference.order_id, 'remote-order')
  assert.deepEqual(detail.order.delivery, { status: 'sent', sentAt: null })
  assert.equal(detail.order.customer_email, 'buyer@example.invalid')
  assert.equal(detail.events.length, 4)
  assert.ok(detail.events.every(event => ['customer', 'system', 'admin'].includes(event.actor)))
  assert.ok(detail.events.some(event => event.action === 'refund-approved' && event.note === '售后申请已审核通过，等待退款结果'))
  for (const hidden of ['private-', 'owner_hash', 'idempotency_key', 'request_hash', 'retryKey', 'paymentQr', 'create_body', key]) assert.equal(serialized.includes(hidden), false, hidden)
  assert.deepEqual(s.db.prepare('SELECT * FROM orders WHERE id=?').get(id), before); assert.equal(calls, 0)
  assert.equal((await s.request('/api/partner/orders/' + other, undefined, s.a.cookie)).status, 404)
  assert.equal((await s.request('/api/partner/orders/' + crypto.randomUUID(), undefined, s.a.cookie)).status, 404)
  assert.equal((await s.request('/api/partner/orders/' + id)).status, 401)
  assert.equal((await s.request(`/api/admin/partners/${s.a.id}/orders/${id}`, undefined, s.a.cookie)).status, 401)
  const preview = await s.request(`/api/admin/partners/${s.a.id}/orders/${id}`, undefined, s.admin)
  assert.equal(preview.status, 200); assert.deepEqual(await preview.json(), detail)
  assert.equal((await s.request(`/api/admin/partners/${s.b.id}/orders/${id}`, undefined, s.admin)).status, 404)
  s.db.prepare('UPDATE recharge_orders SET financial_hold=1,refunded_cents=100 WHERE order_id=?').run(id)
  const held = await s.request('/api/partner/orders/' + id, undefined, s.a.cookie).then(r => r.json())
  assert.equal(held.order.refund_hold, 1); assert.equal(held.order.platform_refunded_cents, 100); assert.equal(held.order.fulfillment.canSubmit, false)
  assert.equal(calls, 0)
})

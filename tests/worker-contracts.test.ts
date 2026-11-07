import test from 'node:test'
import assert from 'node:assert/strict'
import { customerFixture } from './customer-fixture.ts'

test('public verification configuration works before buyer initialization and does not authenticate anyone', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  for (const path of ['/api/orders/verification', '/api/orders/verification?purpose=auth']) {
    const response = await s.request(path)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { enabled: false, purpose: path.includes('?') ? 'auth' : 'order_create' })
    assert.equal(response.headers.get('Set-Cookie'), null)
  }
  assert.equal((await s.request('/api/admin/orders')).status, 401)
  assert.equal((await s.request('/api/partner/dashboard')).status, 401)
  assert.equal((await s.request('/api/orders')).status, 401)
})

test('Workers advertises its single-store workspace and only implemented partner features', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const a = await s.agent('contract agent')
  for (const [path, cookie] of [['/api/partner/dashboard', a.cookie], [`/api/admin/partners/${a.id}/preview`, s.admin]]) {
    const response = await s.request(path, undefined, cookie)
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.deepEqual(data.capabilities, { multiStore: false, tickets: false, notifications: false })
    assert.deepEqual(data.payoutAccount, { phone: '', name: '', version: 0 })
  }
})

test('payout account binding is scoped, versioned and does not expose private data in audit or catalog', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const a = await s.agent('a'), b = await s.agent('b')
  const input = { phone: '13800000001', name: '测试甲', version: 0 }
  assert.equal((await s.request('/api/partner/payout-account', input)).status, 401)
  assert.equal((await s.request('/api/partner/payout-account', input, a.cookie, 'https://foreign.invalid')).status, 403)
  const saved = await s.request('/api/partner/payout-account', input, a.cookie)
  assert.equal(saved.status, 200, await saved.clone().text())
  assert.equal((await s.request('/api/partner/payout-account', input, a.cookie)).status, 409)
  assert.equal((await s.request('/api/partner/payout-account', { ...input, phone: 'bad', version: 1 }, a.cookie)).status, 400)
  const own = await (await s.request('/api/partner/dashboard', undefined, a.cookie)).json()
  const other = await (await s.request('/api/partner/dashboard', undefined, b.cookie)).json()
  assert.deepEqual(own.payoutAccount, { phone: input.phone, name: input.name, version: 1 })
  assert.deepEqual(other.payoutAccount, { phone: '', name: '', version: 0 })
  const audit = s.db.prepare("SELECT note FROM admin_audit WHERE action='partner-payout-account'").all()
  assert.equal(audit.length, 1)
  assert.doesNotMatch(JSON.stringify(audit), /13800000001|测试甲/)
  const catalog = await (await s.request('/api/catalog?partner=' + own.partner.slug)).text()
  assert.doesNotMatch(catalog, /13800000001|测试甲|payoutAccount/)
})

test('frontend payout request snapshots the bound account, rejects stale versions and safely replays after editing', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const a = await s.agent('payout fixture')
  const saved = await s.request('/api/partner/payout-account', { phone: '13800000001', name: '测试甲', version: 0 }, a.cookie)
  assert.equal(saved.status, 200)
  const now = Date.now()
  s.db.prepare("INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,cost_cents,partner_id,mode,payment_status,status,created_at,updated_at,last_event_id) VALUES('YMX-CONTRACT','fixture','fixture','plus','Plus',13900,11000,?,'live','paid','success',?,?,'fixture')").run(a.id, now, now)
  assert.equal((await s.request('/api/partner/payouts', { accountVersion: 0, key: crypto.randomUUID() }, a.cookie)).status, 409)
  assert.equal((await s.request('/api/partner/payouts', { recipient: 'override', key: crypto.randomUUID() }, a.cookie)).status, 409)
  const payload = { accountVersion: 1, key: crypto.randomUUID(), recipient: 'untrusted override' }
  const responses = await Promise.all([s.request('/api/partner/payouts', payload, a.cookie), s.request('/api/partner/payouts', payload, a.cookie)])
  assert.ok(responses.every(r => [200, 201].includes(r.status)))
  const payouts = s.db.prepare('SELECT recipient,amount_cents FROM partner_payouts').all()
  assert.equal(payouts.length, 1)
  assert.equal(payouts[0].recipient, '13800000001 / 测试甲')
  assert.equal(payouts[0].amount_cents, 2900)
  assert.equal((await s.request('/api/partner/payout-account', { phone: '13900000002', name: '测试乙', version: 1 }, a.cookie)).status, 200)
  assert.equal((await s.request('/api/partner/payouts', payload, a.cookie)).status, 200)
  assert.equal(s.db.prepare('SELECT recipient FROM partner_payouts').get()!.recipient, '13800000001 / 测试甲')
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_payout_items').get()!.n, 1)
})

test('payout account concurrent saves have one winner and audit failure rolls back the account', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const a = await s.agent('concurrent account')
  const input = { phone: '13800000001', name: '测试甲', version: 0 }
  const responses = await Promise.all([
    s.request('/api/partner/payout-account', input, a.cookie),
    s.request('/api/partner/payout-account', { ...input, name: '测试乙' }, a.cookie),
  ])
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409])
  const before = s.db.prepare('SELECT * FROM partner_payout_accounts').get()
  s.db.exec("CREATE TRIGGER fail_account_audit BEFORE INSERT ON admin_audit WHEN NEW.action='partner-payout-account' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END")
  assert.equal((await s.request('/api/partner/payout-account', { ...input, phone: '13900000002', version: 1 }, a.cookie)).status, 503)
  assert.deepEqual(s.db.prepare('SELECT * FROM partner_payout_accounts').get(), before)
  assert.equal(s.db.prepare("SELECT count(*) n FROM admin_audit WHERE action='partner-payout-account'").get()!.n, 1)
})

test('account changes during payout verification cannot reserve money against a stale recipient', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const a = await s.agent('payout account race')
  await s.request('/api/partner/payout-account', { phone: '13800000001', name: '测试甲', version: 0 }, a.cookie)
  const now = Date.now()
  s.db.prepare("INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,cost_cents,partner_id,mode,payment_status,status,created_at,updated_at,last_event_id) VALUES('YMX-RACE','fixture','fixture','plus','Plus',13900,11000,?,'live','paid','success',?,?,'fixture')").run(a.id, now, now)
  const batch = s.env.INTEREST_DB.batch.bind(s.env.INTEREST_DB)
  let raced = false
  s.env.INTEREST_DB.batch = async statements => {
    if (!raced) {
      raced = true
      s.db.prepare('UPDATE partner_payout_accounts SET phone=?,version=version+1 WHERE partner_id=?').run('13900000002', a.id)
    }
    return batch(statements)
  }
  const response = await s.request('/api/partner/payouts', { accountVersion: 1, key: crypto.randomUUID() }, a.cookie)
  assert.equal(response.status, 409)
  assert.equal(s.db.prepare('SELECT count(*) n FROM partner_payouts').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT payout_id FROM orders WHERE id=?').get('YMX-RACE')!.payout_id, null)
  assert.equal(s.db.prepare('SELECT count(*) n FROM partner_payout_items').get()!.n, 0)
})

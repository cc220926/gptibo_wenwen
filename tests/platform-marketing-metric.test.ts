import assert from 'node:assert/strict'
import test from 'node:test'
import { customerFixture } from './customer-fixture.ts'

const endpoint = '/api/admin/marketing-metric'

test('custom storefront metric is admin-only, validated, versioned and audited', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const initial = { enabled: false, displayText: '活动展示数：{count}', displayCount: 0, baseCount: 0,
    newCompletedCount: 0, automatic: false, autoCountSince: null, version: 0 }
  assert.deepEqual(await (await s.request(endpoint, undefined, s.admin)).json(), initial)
  assert.equal((await s.request(endpoint)).status, 401)
  const update = { enabled: true, displayText: '活动展示数：{count}', displayCount: 12, version: 0 }
  assert.equal((await s.request(endpoint, update)).status, 401)
  assert.equal((await s.request(endpoint, update, s.admin, 'https://other.example.invalid')).status, 403)
  for (const invalid of [
    { ...update, enabled: 1 }, { ...update, displayText: '活动展示数' },
    { ...update, displayText: '{count} {count}' }, { ...update, displayText: '<b>{count}</b>' },
    { ...update, displayText: 'x'.repeat(121) + '{count}' },
    { ...update, displayCount: -1 }, { ...update, displayCount: 1.5 },
    { ...update, displayCount: 1000000 }, { ...update, displayCount: '12' },
    { ...update, automatic: 'yes' },
    { ...update, version: -1 },
  ]) assert.equal((await s.request(endpoint, invalid, s.admin)).status, 400)
  assert.deepEqual(await (await s.request(endpoint, undefined, s.admin)).json(), initial)
  const saved = await s.request(endpoint, update, s.admin)
  assert.equal(saved.status, 200, await saved.clone().text())
  assert.deepEqual(await saved.json(), { ...update, baseCount: 12, newCompletedCount: 0, automatic: false, autoCountSince: null, version: 1 })
  assert.equal((await s.request(endpoint, update, s.admin)).status, 409)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='platform-marketing-metric'").get()!.n, 1)
})

test('automatic total starts at the configured base and counts only new eligible successful ChatGPT orders', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const template = { enabled: true, displayText: '历史记录及新增完成订单 {count} 单', displayCount: 476 }
  const enabled = await (await s.request(endpoint, { ...template, automatic: true, version: 0 }, s.admin)).json()
  assert.equal(enabled.baseCount, 476)
  assert.equal(enabled.displayCount, 476)
  assert.equal(enabled.newCompletedCount, 0)
  assert.equal(enabled.automatic, true)
  assert.ok(enabled.autoCountSince > 0)
  const since = enabled.autoCountSince as number
  const insert = (name: string, options: { createdAt?: number; plan?: string; status?: string; payment?: string; refund?: number; hold?: number; test?: number; partnerId?: string } = {}) => {
    const id = crypto.randomUUID()
    s.db.prepare(`INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,payment_status,status,created_at,updated_at,last_event_id,refunded_cents,refund_hold,is_test,partner_id)
      VALUES (?,?,?,?,?,13900,'live',?,?,?,?,?,?,?,?,?)`).run(id, name, id, options.plan ?? 'plus', 'Plus', options.payment ?? 'paid', options.status ?? 'success', options.createdAt ?? since + 1, since + 1, id, options.refund ?? 0, options.hold ?? 0, options.test ?? 0, options.partnerId ?? null)
    return id
  }
  insert('old-success', { createdAt: since - 1 })
  const pending = insert('new-pending', { status: 'pending', payment: 'unpaid' })
  insert('new-failed', { status: 'failed' })
  insert('new-other-product', { plan: 'codex-sms-once' })
  insert('new-refunded', { refund: 13900 })
  insert('new-hold', { hold: 1 })
  insert('new-test', { test: 1 })
  const partner = await s.agent('independent-shop')
  insert('partner-success', { partnerId: partner.id })
  assert.equal((await (await s.request('/api/catalog')).json()).marketingMetric.displayCount, 476)
  s.db.prepare("UPDATE orders SET status='success',payment_status='paid' WHERE id=?").run(pending)
  assert.equal((await (await s.request('/api/catalog')).json()).marketingMetric.displayCount, 477)
  const current = await (await s.request(endpoint, undefined, s.admin)).json()
  assert.equal(current.baseCount, 476)
  assert.equal(current.newCompletedCount, 1)
  assert.equal(current.displayCount, 477)
  const edited = await (await s.request(endpoint, { ...template, displayText: '累计完成 {count} 单', version: 1 }, s.admin)).json()
  assert.equal(edited.automatic, true)
  assert.equal(edited.autoCountSince, since)
  assert.equal(edited.displayCount, 477)
  const stopped = await (await s.request(endpoint, { ...template, automatic: false, displayCount: 477, version: 2 }, s.admin)).json()
  assert.equal(stopped.displayCount, 477)
  assert.equal(stopped.autoCountSince, null)
  insert('after-stop')
  assert.equal((await (await s.request('/api/catalog')).json()).marketingMetric.displayCount, 477)
})

test('custom metric is public only in platform catalog and disabled by default', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  assert.deepEqual((await (await s.request('/api/catalog')).json()).marketingMetric, { enabled: false, displayText: '活动展示数：{count}', displayCount: 0 })
  const partner = await s.agent('independent-shop')
  const slug = String(s.db.prepare('SELECT slug FROM partners WHERE id=?').get(partner.id)!.slug)
  assert.equal((await (await s.request('/api/catalog?partner=' + slug)).json()).marketingMetric, null)
  const update = { enabled: true, displayText: '活动展示数：{count}', displayCount: 12, version: 0 }
  assert.equal((await s.request(endpoint, update, s.admin)).status, 200)
  assert.deepEqual((await (await s.request('/api/catalog')).json()).marketingMetric, { enabled: true, displayText: '活动展示数：{count}', displayCount: 12 })
  assert.equal((await (await s.request('/api/catalog?partner=' + slug)).json()).marketingMetric, null)
})

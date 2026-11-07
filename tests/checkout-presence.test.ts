import test from 'node:test'
import assert from 'node:assert/strict'
import { customerFixture } from './customer-fixture.ts'
import worker from '../worker/index.ts'
import { expireCheckoutPresence } from '../worker/checkout-presence.ts'

const path = '/api/checkout-presence'
const readPath = path + '?product=chatgpt'
const pulse = (tabId: string, active = true, partner?: string) => ({ product: 'chatgpt', tabId, active, ...(partner ? { partner } : {}) })
async function setup() {
  const s = await customerFixture()
  const buyer = async () => (await s.request('/api/orders/client', {})).headers.get('Set-Cookie')!.split(';')[0]
  const count = async (cookie: string, partner?: string) => {
    const r = await s.request(readPath + (partner ? '&partner=' + partner : ''), undefined, cookie)
    assert.equal(r.status, 200, await r.clone().text())
    assert.equal(r.headers.get('Cache-Control'), 'no-store')
    const result = await r.json()
    assert.deepEqual(Object.keys(result).sort(), ['others', 'windowSeconds'])
    assert.equal(result.windowSeconds, 600)
    return result.others as number
  }
  return { ...s, buyer, count }
}

test('presence GET does not add visitors and distinct buyers see each other, excluding themselves', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const a = await s.buyer(), b = await s.buyer(), c = await s.buyer(), d = await s.buyer()
  assert.equal(await s.count(a), 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM checkout_presence').get()!.n, 0)
  const first = await s.request(path, pulse(crypto.randomUUID()), a)
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { others: 0, windowSeconds: 600 })
  assert.equal(await s.count(b), 1)
  assert.equal((await s.request(path, pulse(crypto.randomUUID()), b)).status, 200)
  assert.equal(await s.count(a), 1)
  assert.equal(await s.count(b), 1)
  for (const buyer of [c, d]) assert.equal((await s.request(path, pulse(crypto.randomUUID()), buyer)).status, 200)
  assert.equal(await s.count(a), 3)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
})

test('same-browser tabs count once and leaving one tab preserves the other', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const a = await s.buyer(), viewer = await s.buyer()
  const tab1 = crypto.randomUUID(), tab2 = crypto.randomUUID()
  for (const tab of [tab1, tab2, tab1]) assert.equal((await s.request(path, pulse(tab), a)).status, 200)
  assert.equal(await s.count(viewer), 1)
  assert.equal(await s.count(a), 0)
  await s.request(path, pulse(tab1, false), a)
  assert.equal(await s.count(viewer), 1)
  await s.request(path, pulse(tab2, false), a)
  assert.equal(await s.count(viewer), 0)
})

test('closed activity IDs cannot be resurrected by delayed heartbeats or another buyer', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const a = await s.buyer(), viewer = await s.buyer(), tab = crypto.randomUUID()
  // The leave can arrive before the first active request.
  await s.request(path, pulse(tab, false), a)
  await s.request(path, pulse(tab), a)
  assert.equal(await s.count(viewer), 0)
  const next = crypto.randomUUID()
  await s.request(path, pulse(next), a)
  await s.request(path, pulse(next, false), viewer)
  assert.equal(await s.count(viewer), 1)
  await s.request(path, pulse(next, false), a)
  await s.request(path, pulse(next), a)
  assert.equal(await s.count(viewer), 0)
  await s.request(path, pulse(crypto.randomUUID()), a)
  assert.equal(await s.count(viewer), 1)
})

test('presence expires at the server ten-minute boundary and ignores supplied timestamps or counts', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const a = await s.buyer(), viewer = await s.buyer(), tab = crypto.randomUUID()
  const now = Date.now(); t.mock.method(Date, 'now', () => now)
  await s.request(path, { ...pulse(tab), seenAt: now + 1e9, others: 9999 }, a)
  assert.equal(await s.count(viewer), 1)
  s.db.prepare('UPDATE checkout_presence SET last_seen_at=?').run(now - 599_999)
  assert.equal(await s.count(viewer), 1)
  s.db.prepare('UPDATE checkout_presence SET last_seen_at=?').run(now - 600_000)
  assert.equal(await s.count(viewer), 0)
  await s.request(path, pulse(tab), a)
  assert.equal(await s.count(viewer), 1)
})

test('presence is scoped to active stores and only supports ChatGPT', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const a = await s.buyer(), viewer = await s.buyer()
  const shopA = await s.agent('shop-a'), shopB = await s.agent('shop-b')
  const slugA = shopA.id.slice(0, 6), slugB = shopB.id.slice(0, 6)
  await s.request(path, pulse(crypto.randomUUID(), true, slugA), a)
  assert.equal(await s.count(viewer), 0)
  assert.equal(await s.count(viewer, slugA), 1)
  assert.equal(await s.count(viewer, slugB), 0)
  assert.equal((await s.request(readPath + '&partner=missing', undefined, viewer)).status, 404)
  s.db.prepare('UPDATE partners SET active=0 WHERE id=?').run(shopA.id)
  assert.equal((await s.request(readPath + '&partner=' + slugA, undefined, viewer)).status, 404)
  assert.equal((await s.request(path, pulse(crypto.randomUUID(), true, slugA), a)).status, 404)
  for (const product of ['codex-sms', 'missing', '']) {
    assert.equal((await s.request(path + '?product=' + product, undefined, a)).status, 400)
    assert.equal((await s.request(path, { ...pulse(crypto.randomUUID()), product }, a)).status, 400)
  }
})

test('presence rejects missing credentials, cross-origin updates, invalid fields and oversized bodies', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const a = await s.buyer()
  assert.equal((await s.request(readPath)).status, 401)
  assert.equal((await s.request(path, pulse(crypto.randomUUID()))).status, 401)
  assert.equal((await s.request(path, pulse(crypto.randomUUID()), a, 'https://elsewhere.example')).status, 403)
  for (const data of [{ product: 'chatgpt', active: true }, { ...pulse('invalid') }, { ...pulse(crypto.randomUUID()), active: 1 }, { ...pulse(crypto.randomUUID()), active: 'false' }]) {
    assert.equal((await s.request(path, data, a)).status, 400)
  }
  assert.equal((await s.request(path, { ...pulse(crypto.randomUUID()), extra: 'x'.repeat(1024) }, a)).status, 413)
  const response = await worker.fetch(new Request('https://shop.example.invalid' + path, { method: 'PUT', headers: { Cookie: a } }), s.env)
  assert.equal(response.status, 405)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM checkout_presence').get()!.n, 0)
})

test('presence rate limits and database failures do not return invented counts', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const a = await s.buyer()
  t.mock.method(s.env.INTEREST_LIMITER, 'limit', async () => ({ success: false }))
  const denied = await s.request(path, pulse(crypto.randomUUID()), a)
  assert.equal(denied.status, 429)
  assert.equal(denied.headers.get('Retry-After'), '60')
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM checkout_presence').get()!.n, 0)
  t.mock.method(s.env.INTEREST_DB, 'prepare', () => { throw new Error('D1 unavailable') })
  const failed = await s.request(readPath, undefined, a)
  assert.equal(failed.status, 503)
  assert.deepEqual(Object.keys(await failed.json()), ['error'])
})

test('cleanup removes expired activity but preserves recent closed IDs against late heartbeats', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const a = await s.buyer(), viewer = await s.buyer()
  const now = Date.now(); t.mock.method(Date, 'now', () => now)
  const stale = crypto.randomUUID(), current = crypto.randomUUID(), closed = crypto.randomUUID(), oldClosed = crypto.randomUUID()
  for (const id of [stale, current]) await s.request(path, pulse(id), a)
  for (const id of [closed, oldClosed]) await s.request(path, pulse(id, false), a)
  s.db.prepare('UPDATE checkout_presence SET last_seen_at=? WHERE tab_id=?').run(now - 600_000, stale)
  s.db.prepare('UPDATE checkout_presence SET last_seen_at=? WHERE tab_id=?').run(now - 599_999, current)
  s.db.prepare('UPDATE checkout_presence SET closed_at=? WHERE tab_id=?').run(now - 299_999, closed)
  s.db.prepare('UPDATE checkout_presence SET closed_at=? WHERE tab_id=?').run(now - 300_000, oldClosed)
  await expireCheckoutPresence(s.env)
  const retained = s.db.prepare('SELECT tab_id FROM checkout_presence').all().map(row => row.tab_id)
  assert.deepEqual(new Set(retained), new Set([current, closed]))
  await s.request(path, pulse(current, false), a)
  await s.request(path, pulse(closed), a)
  assert.equal(await s.count(viewer), 0)
})

test('the global edge guard rejects presence before it can write activity or query D1', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const a = await s.buyer()
  t.mock.method(s.env.API_LIMITER, 'limit', async () => ({ success: false }))
  t.mock.method(s.env.INTEREST_DB, 'prepare', () => { throw new Error('unexpected D1 access') })
  assert.equal((await s.request(path, pulse(crypto.randomUUID()), a)).status, 429)
  assert.equal((await s.request(readPath, undefined, a)).status, 429)
})

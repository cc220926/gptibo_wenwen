import assert from 'node:assert/strict'
import test from 'node:test'
import worker from '../worker/index.ts'
import { customerFixture } from './customer-fixture.ts'

const path = '/api/customer-history?product=chatgpt'

test('history exposes masked display entries in bounded stable pages without order mutations or counts', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  assert.deepEqual(await (await s.request(path)).json(), { emails: [], nextCursor: null })
  const insert = s.db.prepare('INSERT INTO customer_history(shop_id,masked_email) VALUES (?,?)')
  for (let i = 0; i < 61; i++) insert.run('platform', `c${i}***@example.invalid`)
  const first = await s.request(path + '&limit=10000')
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('Cache-Control'), 'no-store')
  const page = await first.json()
  assert.deepEqual(Object.keys(page).sort(), ['emails', 'nextCursor'])
  assert.equal(page.emails.length, 60)
  assert.equal(page.nextCursor, 60)
  const last = await (await s.request(path + '&cursor=' + page.nextCursor)).json()
  assert.deepEqual(last, { emails: ['c60***@example.invalid'], nextCursor: null })
  assert.deepEqual(await (await s.request(path + '&cursor=999999')).json(), { emails: [], nextCursor: null })
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM checkout_presence').get()!.n, 0)
})

test('history masks belong only to the resolved active shop and never fall back to platform data', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const a = await s.agent('history-a'), b = await s.agent('history-b')
  const insert = s.db.prepare('INSERT INTO customer_history(shop_id,masked_email) VALUES (?,?)')
  insert.run('platform', 'platform***@example.invalid')
  insert.run(a.id, 'partner***@example.invalid')
  const read = async (slug?: string) => (await s.request(path + (slug ? '&partner=' + slug : ''))).json()
  assert.deepEqual((await read()).emails, ['platform***@example.invalid'])
  assert.deepEqual((await read(a.id.slice(0, 6))).emails, ['partner***@example.invalid'])
  assert.deepEqual(await read(b.id.slice(0, 6)), { emails: [], nextCursor: null })
  assert.equal((await s.request(path + '&partner=missing')).status, 404)
  s.db.prepare('UPDATE partners SET active=0 WHERE id=?').run(a.id)
  assert.equal((await s.request(path + '&partner=' + a.id.slice(0, 6))).status, 404)
})

test('history rejects public mutations, unsupported products and malformed cursors', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  for (const cursor of ['', '-1', '1.5', 'NaN', '1e3', '9007199254740992', '01', '1%20OR%201=1']) {
    assert.equal((await s.request(path + '&cursor=' + cursor)).status, 400, cursor)
  }
  for (const product of ['', 'claude', 'gemini']) assert.equal((await s.request('/api/customer-history?product=' + product)).status, 400)
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await worker.fetch(new Request('https://shop.example.invalid' + path, { method }), s.env)
    assert.equal(r.status, 405)
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM customer_history').get()!.n, 0)
})

test('a live partner storefront can explicitly read the same public platform history', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const partner = await s.agent('shared-history')
  const insert = s.db.prepare('INSERT INTO customer_history(shop_id,masked_email) VALUES (?,?)')
  for (let i = 0; i < 61; i++) insert.run('platform', `main${i}***@example.invalid`)
  insert.run(partner.id, 'partner***@example.invalid')
  const partnerPath = path + '&scope=platform&partner=' + partner.id.slice(0, 6)
  for (const cursor of [0, 60]) {
    const main = await (await s.request(path + '&cursor=' + cursor)).json()
    const response = await s.request(partnerPath + '&cursor=' + cursor)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), main)
  }
  s.db.prepare('UPDATE partners SET active=0 WHERE id=?').run(partner.id)
  assert.equal((await s.request(partnerPath)).status, 404)
  assert.equal((await s.request(path + '&scope=arbitrary')).status, 400)
})

test('history fails closed for damaged masks, unavailable storage and rate limiting', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  // This passes the deliberately minimal SQL guard but is not a local-part mask.
  s.db.prepare('INSERT INTO customer_history(shop_id,masked_email) VALUES (?,?)').run('platform', 'unmasked@example.invalid***')
  const invalid = await s.request(path)
  assert.equal(invalid.status, 503)
  assert.deepEqual(Object.keys(await invalid.json()), ['error'])
  t.mock.method(s.env.INTEREST_DB, 'prepare', () => { throw new Error('D1 unavailable') })
  assert.equal((await s.request(path)).status, 503)
  t.mock.method(s.env.API_LIMITER!, 'limit', async () => ({ success: false }))
  assert.equal((await s.request(path)).status, 429)
})

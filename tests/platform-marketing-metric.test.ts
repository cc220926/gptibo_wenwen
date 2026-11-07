import assert from 'node:assert/strict'
import test from 'node:test'
import { customerFixture } from './customer-fixture.ts'

const endpoint = '/api/admin/marketing-metric'

test('custom storefront metric is admin-only, validated, versioned and audited', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const initial = { enabled: false, displayText: '活动展示数：{count}', displayCount: 0, version: 0 }
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
    { ...update, version: -1 },
  ]) assert.equal((await s.request(endpoint, invalid, s.admin)).status, 400)
  assert.deepEqual(await (await s.request(endpoint, undefined, s.admin)).json(), initial)
  const saved = await s.request(endpoint, update, s.admin)
  assert.equal(saved.status, 200, await saved.clone().text())
  assert.deepEqual(await saved.json(), { ...update, version: 1 })
  assert.equal((await s.request(endpoint, update, s.admin)).status, 409)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='platform-marketing-metric'").get()!.n, 1)
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

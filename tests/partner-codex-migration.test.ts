import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { customerFixture } from './customer-fixture.ts'

const migration = readFileSync(new URL('../migrations/0064_partner_codex_credits.sql', import.meta.url), 'utf8')
test('Codex resale backfill uses unified costs, includes inactive partners and preserves retail and order snapshots', async t => {
  const s = await customerFixture(); t.after(() => s.db.close()); const a = await s.agent('existing'), b = await s.agent('inactive')
  s.db.prepare('UPDATE partners SET active=0 WHERE id=?').run(b.id)
  s.db.exec("UPDATE catalog_plans SET partner_enabled=0 WHERE product_id='codex-credits'; UPDATE partner_default_prices SET cost_cents=8200 WHERE plan='codex-credits-250'; UPDATE partner_default_prices SET cost_cents=16000 WHERE plan='codex-credits-500'")
  s.db.prepare("INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents,version) VALUES (?,'codex-credits-250',8200,10900,7)").run(a.id)
  s.db.prepare("INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents) VALUES (?,'plus',11500,14900)").run(a.id)
  const slug = s.db.prepare('SELECT slug FROM partners WHERE id=?').get(a.id)!.slug
  const buyer = (await s.request('/api/orders/client', {})).headers.get('set-cookie')!.split(';')[0]
  const response = await s.request('/api/orders', { partner: slug, plan: 'plus', expectedPrice: 14900, email: 'buyer@example.test', key: crypto.randomUUID() }, buyer)
  assert.equal(response.status, 201)
  const beforeOrders = s.db.prepare('SELECT * FROM orders ORDER BY id').all(), existing = s.db.prepare('SELECT * FROM partner_prices WHERE partner_id=? ORDER BY plan').all(a.id)
  const defaults = s.db.prepare('SELECT * FROM partner_default_prices ORDER BY plan').all()
  s.db.exec(migration)
  assert.deepEqual(s.db.prepare('SELECT * FROM orders ORDER BY id').all(), beforeOrders)
  assert.deepEqual(s.db.prepare('SELECT * FROM partner_default_prices ORDER BY plan').all(), defaults)
  for (const row of existing) assert.deepEqual(s.db.prepare('SELECT * FROM partner_prices WHERE partner_id=? AND plan=?').get(row.partner_id,row.plan),row)
  for (const id of [a.id,b.id]) {
    const rows=s.db.prepare("SELECT plan,cost_cents,price_cents FROM partner_prices WHERE partner_id=? AND plan LIKE 'codex-credits-%' ORDER BY plan").all(id)
    assert.deepEqual(rows.map(r=>({...r})),[{plan:'codex-credits-250',cost_cents:8200,price_cents:id===a.id?10900:9900},{plan:'codex-credits-500',cost_cents:16000,price_cents:19900}])
  }
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM catalog_plans WHERE product_id='codex-credits' AND partner_enabled=1").get()!.n,2)
  const after = s.db.prepare('SELECT * FROM partner_prices ORDER BY partner_id,plan').all()
  s.db.exec(migration)
  assert.deepEqual(s.db.prepare('SELECT * FROM partner_prices ORDER BY partner_id,plan').all(),after)
})

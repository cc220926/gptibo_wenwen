import assert from 'node:assert/strict'
import test from 'node:test'
import { customerFixture } from './customer-fixture.ts'
import { provisionPartner } from '../worker/partner-provision.ts'
import type { DefaultSupplySettings } from '../shared/partner-default-prices.ts'

const defaults = '/api/admin/partners/default-prices'
const visibility = '/api/admin/product-visibility'
const check = async (r: Response, status = 200) => { assert.equal(r.status,status,await r.clone().text()); return r.json() }
async function saveCosts(s: Awaited<ReturnType<typeof customerFixture>>, cost = 8200) {
  const settings: DefaultSupplySettings = await check(await s.request(defaults,undefined,s.admin))
  return s.request(defaults,{version:settings.version,prices:settings.plans.map(p=>({plan:p.id,catalogVersion:p.catalog_version,costCents:p.id==='codex-credits-250'?cost:p.cost_cents}))},s.admin)
}

for (const action of ['supply-save','plan-reopen'] as const) {
  test(`partner sync: ${action} fills missing offers for old and inactive agents without replacing retail or order snapshots`, async t => {
    const s=await customerFixture();t.after(()=>s.db.close());const a=await s.agent('old'),b=await s.agent('inactive')
    s.db.prepare('UPDATE partners SET active=0 WHERE id=?').run(b.id)
    s.db.exec("UPDATE partner_default_prices SET cost_cents=8200 WHERE plan='codex-credits-250'")
    s.db.prepare("INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents,version) VALUES (?,'plus',13900,15900,8)").run(a.id)
    const buyer=(await s.request('/api/orders/client',{})).headers.get('set-cookie')!.split(';')[0]
    const slug=s.db.prepare('SELECT slug FROM partners WHERE id=?').get(a.id)!.slug
    const order=(await check(await s.request('/api/orders',{partner:slug,plan:'plus',expectedPrice:15900,key:crypto.randomUUID(),email:'buyer@example.test'},buyer),201)).order
    const before=s.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id), retail=s.db.prepare("SELECT * FROM partner_prices WHERE partner_id=? AND plan='plus'").get(a.id)
    const run=async()=>{
      if(action==='supply-save')return saveCosts(s)
      const plan=s.db.prepare("SELECT * FROM catalog_plans WHERE id='codex-credits-250'").get()!
      return s.request('/api/admin/plans/codex-credits-250',{priceCents:9900,enabled:true,partnerEnabled:true,version:plan.version,note:'开放代理销售'},s.admin)
    }
    await check(await run())
    for(const p of [a,b]) assert.deepEqual({...s.db.prepare("SELECT cost_cents,price_cents FROM partner_prices WHERE partner_id=? AND plan='codex-credits-250'").get(p.id)},{cost_cents:8200,price_cents:9900})
    assert.deepEqual(s.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id),before)
    assert.deepEqual(s.db.prepare("SELECT * FROM partner_prices WHERE partner_id=? AND plan='plus'").get(a.id),retail)
    s.db.prepare("UPDATE partner_prices SET price_cents=10900,version=version+1 WHERE partner_id=? AND plan='codex-credits-250'").run(a.id)
    const offers=s.db.prepare('SELECT * FROM partner_prices ORDER BY partner_id,plan').all()
    await check(await run())
    assert.deepEqual(s.db.prepare('SELECT * FROM partner_prices ORDER BY partner_id,plan').all(),offers)
  })
}

test('partner sync: newly provisioned agents inherit latest prices and master hides, relisting preserves local hides', async t=>{
  const s=await customerFixture();t.after(()=>s.db.close())
  Object.assign(s.env,{RESEND_API_KEY:'test',RESEND_FROM:'login@example.test',MAIL_PUBLIC_ORIGIN:'https://mail-store.example.test'})
  const old=await provisionPartner(s.env,'old@example.test','test')
  await check(await saveCosts(s))
  await check(await s.request(visibility,{hiddenProductIds:['claude','grok','chatgpt'],version:0,note:'总站停售'},s.admin))
  const newer=await provisionPartner(s.env,'new@example.test','test')
  const buyer=(await s.request('/api/orders/client',{})).headers.get('set-cookie')!.split(';')[0]
  for(const p of [old,newer]){
    const catalog=await check(await s.request('/api/catalog?partner='+p.slug))
    assert.ok(['claude','grok','chatgpt'].every(id=>catalog.hiddenProductIds.includes(id)))
    assert.ok(!catalog.plans.some((x:{product_id:string})=>x.product_id==='chatgpt'))
    assert.equal(s.db.prepare("SELECT cost_cents FROM partner_prices WHERE partner_id=? AND plan='codex-credits-250'").get(p.id)!.cost_cents,8200)
    assert.equal((await s.request('/api/orders',{partner:p.slug,plan:'plus',expectedPrice:13900,key:crypto.randomUUID(),email:'buyer@example.test'},buyer)).status,409)
  }
  s.db.prepare("INSERT INTO partner_product_order(partner_id,product_ids,hidden_product_ids,change_id,updated_at) VALUES (?,'[]','[\"chatgpt\"]','fixture',0)").run(old.id)
  await check(await s.request(visibility,{hiddenProductIds:['claude','grok'],version:1,note:'重新上架'},s.admin))
  assert.ok((await check(await s.request('/api/catalog?partner='+old.slug))).hiddenProductIds.includes('chatgpt'))
  assert.ok(!(await check(await s.request('/api/catalog?partner='+newer.slug))).hiddenProductIds.includes('chatgpt'))
  await check(await s.request('/api/orders',{partner:newer.slug,plan:'plus',expectedPrice:13900,key:crypto.randomUUID(),email:'buyer@example.test'},buyer),201)
})

for (const action of ['supply-save','plan-reopen'] as const) {
  test(`partner sync: ${action} rollback on missing-price insertion failure leaves all settings untouched`, async t=>{
    const s=await customerFixture();t.after(()=>s.db.close());await s.agent('existing')
    s.db.exec("CREATE TRIGGER fail_price_insert BEFORE INSERT ON partner_prices WHEN NEW.plan='codex-credits-250' BEGIN SELECT RAISE(ABORT,'simulated insert failure'); END")
    const snapshot=()=>Object.fromEntries(['partner_prices','partner_default_prices','partner_default_price_settings','catalog_plans','admin_audit','orders'].map(table=>[table,s.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]))
    const before=snapshot()
    if(action==='supply-save') assert.equal((await saveCosts(s)).status,503)
    else {
      const plan=s.db.prepare("SELECT * FROM catalog_plans WHERE id='codex-credits-250'").get()!
      assert.equal((await s.request('/api/admin/plans/codex-credits-250',{priceCents:10900,enabled:true,partnerEnabled:true,version:plan.version,note:'失败回滚测试'},s.admin)).status,503)
    }
    assert.deepEqual(snapshot(),before)
  })
}

test('partner sync: no backfill for unopened agent products, and stale settings cannot insert missing rows',async t=>{
  const s=await customerFixture();t.after(()=>s.db.close());const p=await s.agent('old')
  s.db.exec("UPDATE catalog_plans SET partner_enabled=0 WHERE id='codex-credits-250'")
  await check(await saveCosts(s))
  assert.equal(s.db.prepare("SELECT * FROM partner_prices WHERE partner_id=? AND plan='codex-credits-250'").get(p.id),undefined)
  const plan=s.db.prepare("SELECT * FROM catalog_plans WHERE id='codex-credits-250'").get()!
  const batch=s.env.INTEREST_DB.batch
  s.env.INTEREST_DB.batch=async statements=>{s.db.exec("UPDATE catalog_plans SET version=version+1 WHERE id='codex-credits-250'");return batch(statements)}
  assert.equal((await s.request('/api/admin/plans/codex-credits-250',{priceCents:9900,enabled:true,partnerEnabled:true,version:plan.version,note:'过期更新'},s.admin)).status,409)
  assert.equal(s.db.prepare("SELECT * FROM partner_prices WHERE partner_id=? AND plan='codex-credits-250'").get(p.id),undefined)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { customerFixture } from './customer-fixture.ts'
import { provisionPartner } from '../worker/partner-provision.ts'
import { DEFAULT_PRODUCT_ORDER } from '../shared/product-order.ts'

const scope = 'chatgpt,codex-credits'
const excluded = DEFAULT_PRODUCT_ORDER.filter(id => !scope.split(',').includes(id))
const check = async (r: Response, status = 200) => { assert.equal(r.status,status,await r.clone().text());return r.json() }

test('partner scope hides all other products from old/new shops and management without changing main shop', async t=>{
  const s=await customerFixture();t.after(()=>s.db.close());const old=await s.agent('old')
  s.db.prepare('INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents) SELECT ?,id,price_cents,price_cents FROM catalog_plans').run(old.id)
  const before=await check(await s.request('/api/catalog'))
  Object.assign(s.env,{PARTNER_PRODUCT_IDS:scope,RESEND_API_KEY:'test',RESEND_FROM:'login@example.test',MAIL_PUBLIC_ORIGIN:'https://mail-store.example.test'})
  const newPartner=await provisionPartner(s.env,'scope-new@example.test','test')
  const slug=s.db.prepare('SELECT slug FROM partners WHERE id=?').get(old.id)!.slug
  for(const code of [slug,newPartner.slug]) {
    const catalog=await check(await s.request('/api/catalog?partner='+code))
    assert.deepEqual(new Set(catalog.hiddenProductIds),new Set(excluded))
    assert.ok(catalog.plans.length>=6)
    assert.ok(catalog.plans.every((p:{product_id:string})=>scope.split(',').includes(p.product_id)))
  }
  const dashboard=await check(await s.request('/api/partner/dashboard',undefined,old.cookie))
  assert.ok(dashboard.plans.every((p:{product_id:string})=>scope.split(',').includes(p.product_id)))
  const settings=await check(await s.request('/api/partner/product-order',undefined,old.cookie))
  assert.deepEqual(new Set(settings.platformHiddenProductIds),new Set(excluded))
  await check(await s.request('/api/partner/product-order',{productIds:settings.productIds,hiddenProductIds:[],version:settings.version},old.cookie))
  assert.deepEqual(new Set((await check(await s.request('/api/catalog?partner='+slug))).hiddenProductIds),new Set(excluded))
  const after=await check(await s.request('/api/catalog'))
  assert.deepEqual(after.plans,before.plans);assert.deepEqual(after.hiddenProductIds,before.hiddenProductIds)
})

test('partner scope rejects old SMS links and forged new orders but preserves existing order access and prices', async t=>{
  const s=await customerFixture();t.after(()=>s.db.close());const p=await s.agent('old')
  s.db.prepare("INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents) VALUES (?,'codex-sms-once',400,1000)").run(p.id)
  const slug=s.db.prepare('SELECT slug FROM partners WHERE id=?').get(p.id)!.slug
  const buyer=(await s.request('/api/orders/client',{})).headers.get('set-cookie')!.split(';')[0]
  const payload={partner:slug,plan:'codex-sms-once',expectedPrice:1000,email:'buyer@example.test',key:crypto.randomUUID()}
  const old=(await check(await s.request('/api/orders',payload,buyer),201)).order
  const snapshot=s.db.prepare('SELECT * FROM orders WHERE id=?').get(old.id)
  const prices=s.db.prepare('SELECT * FROM partner_prices').all()
  Object.assign(s.env,{PARTNER_PRODUCT_IDS:scope})
  assert.equal((await s.request('/api/orders',{...payload,key:crypto.randomUUID()},buyer)).status,409)
  assert.equal((await check(await s.request('/api/orders',payload,buyer))).order.id,old.id)
  await check(await s.request('/api/orders/'+old.id,undefined,buyer))
  assert.deepEqual(s.db.prepare('SELECT * FROM orders WHERE id=?').get(old.id),snapshot)
  assert.deepEqual(s.db.prepare('SELECT * FROM partner_prices').all(),prices)
  await check(await s.request('/api/orders',{...payload,partner:undefined,key:crypto.randomUUID()},buyer),201)
})

test('production template explicitly limits partner products to ChatGPT and Codex credits',()=>{
  const config=readFileSync(new URL('../wrangler.production.example.jsonc',import.meta.url),'utf8')
  assert.match(config,/"PARTNER_PRODUCT_IDS"\s*:\s*"chatgpt,codex-credits"/)
})

test('partner scope fails closed for invalid settings and an empty list hides every product',async t=>{
  const s=await customerFixture();t.after(()=>s.db.close());const p=await s.agent('scope')
  const slug=s.db.prepare('SELECT slug FROM partners WHERE id=?').get(p.id)!.slug
  Object.assign(s.env,{PARTNER_PRODUCT_IDS:'unknown-product'})
  assert.equal((await s.request('/api/catalog?partner='+slug)).status,503)
  assert.equal((await s.request('/api/partner/dashboard',undefined,p.cookie)).status,503)
  assert.equal((await s.request('/api/catalog')).status,200)
  Object.assign(s.env,{PARTNER_PRODUCT_IDS:''})
  const catalog=await check(await s.request('/api/catalog?partner='+slug))
  assert.deepEqual(catalog.plans,[]);assert.deepEqual(new Set(catalog.hiddenProductIds),new Set(DEFAULT_PRODUCT_ORDER))
})

test('partner scope is rechecked atomically if a plan changes product after preflight',async t=>{
  const s=await customerFixture();t.after(()=>s.db.close());const p=await s.agent('scope')
  s.db.prepare("INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents) VALUES (?,'plus',11500,13900)").run(p.id)
  Object.assign(s.env,{PARTNER_PRODUCT_IDS:scope})
  const slug=s.db.prepare('SELECT slug FROM partners WHERE id=?').get(p.id)!.slug
  const buyer=(await s.request('/api/orders/client',{})).headers.get('set-cookie')!.split(';')[0]
  const batch=s.env.INTEREST_DB.batch
  s.env.INTEREST_DB.batch=async statements=>{s.db.exec("UPDATE catalog_plans SET product_id='grok' WHERE id='plus'");return batch(statements)}
  assert.equal((await s.request('/api/orders',{plan:'plus',partner:slug,expectedPrice:13900,email:'buyer@example.test',key:crypto.randomUUID()},buyer)).status,409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n,0)
})

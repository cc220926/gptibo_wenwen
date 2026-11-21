import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import worker from '../worker/storefront-entry.ts'
import { customerFixture } from './customer-fixture.ts'
const origin='https://shop.example.invalid'
const shell=readFileSync(new URL('../index.html',import.meta.url),'utf8')
async function setup(allowed=true){
 const s=await customerFixture();let reads=0,limits=0
 const prepare=s.env.INTEREST_DB.prepare.bind(s.env.INTEREST_DB)
 const env={...s.env,STOREFRONT_SEO_ORIGIN:origin,SEO_CATALOG_LIMITER:{limit:async()=>{limits++;return {success:allowed}}},ASSETS:{fetch:async()=>new Response(shell,{headers:{'Content-Type':'text/html','X-Robots-Tag':'noindex, nofollow'}})},INTEREST_DB:{...s.env.INTEREST_DB,prepare(sql:string){reads++;return prepare(sql)}}}
 return {...s,env,get:(path:string)=>worker.fetch(new Request(origin+path),env),stats:()=>({reads,limits})}
}
test('denied dedicated SEO budget performs no D1 reads and preserves the app',async t=>{
 const s=await setup(false);t.after(()=>s.db.close())
 const r=await s.get('/');assert.equal(r.status,200);assert.equal(await r.text(),shell);assert.deepEqual(s.stats(),{reads:0,limits:1})
})
test('concurrent and repeated public pages coalesce one bounded catalog read',async t=>{
 const s=await setup();t.after(()=>s.db.close())
 let apiLimits=0;s.env.API_LIMITER={limit:async()=>{apiLimits++;return{success:false}}}
 const results=await Promise.all(Array.from({length:25},(_,i)=>s.get(i%2?'/product/chatgpt?source='+i:'/')))
 assert.ok(results.every(r=>r.status===200));assert.equal(s.stats().limits,1);assert.equal(s.stats().reads,7)
 for(let i=0;i<10;i++)await s.get('/product/does-not-exist-'+i)
 assert.equal(s.stats().reads,7);assert.equal(apiLimits,0)
})
test('all guides remain standalone without a catalog, limiter or database',async t=>{
 const s=await setup();t.after(()=>s.db.close())
 s.env.INTEREST_DB={prepare(){throw new Error('D1 unavailable')},batch:async()=>{throw new Error('write')}}
 s.env.SEO_CATALOG_LIMITER.limit=async()=>{throw new Error('limit unavailable')}
 for(const path of ['/help/','/help/order-recovery','/help/after-payment','/help/after-sales']){
  const r=await s.get(path);const html=await r.text();assert.equal(r.status,200);assert.match(html,/<h1/);assert.doesNotMatch(html,/<script[^>]+src=/)
  if(path.endsWith('order-recovery'))assert.match(html,/关闭页面后如何找回订单/)
 }
})

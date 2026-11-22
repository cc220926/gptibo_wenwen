import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import worker from '../worker/storefront-entry.ts'
import { publicArticles } from '../shared/public-help.ts'
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
 for(const path of ['/help/', ...publicArticles.map(article=>'/help/'+article.slug)]){
  const r=await s.get(path);const html=await r.text();assert.equal(r.status,200);assert.match(html,/<h1/)
  const scripts=Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g),match=>match[1])
  assert.deepEqual(scripts,path==='/help/'?['/help-search.js']:[])
  if(path.endsWith('order-recovery'))assert.match(html,/关闭页面后如何找回订单/)
 }
})

test('missing SEO binding and denied refreshes never borrow buyer API quota or start D1 work',async t=>{
 const s=await setup();t.after(()=>s.db.close());Reflect.deleteProperty(s.env,'SEO_CATALOG_LIMITER')
 let api=0;s.env.API_LIMITER={limit:async()=>{api++;return{success:true}}}
 for(let i=0;i<5;i++)assert.equal((await s.get('/?source='+i)).status,200)
 assert.equal(s.stats().reads,0);assert.equal(api,0)
 const client=await worker.fetch(new Request(origin+'/api/orders/client',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'}),s.env)
 assert.equal(client.status,200);assert.equal(api,1)
})

test('expired cache obeys denied refresh budget with backoff instead of repeating reads',async t=>{
 const s=await setup();t.after(()=>s.db.close());await s.get('/')
 const before=s.stats().reads;let clock=Date.now(),denied=0;t.mock.method(Date,'now',()=>clock)
 clock+=15001;s.env.SEO_CATALOG_LIMITER.limit=async()=>{denied++;return{success:false}}
 for(let i=0;i<10;i++)assert.equal((await s.get('/product/chatgpt?source='+i)).status,200)
 assert.equal(s.stats().reads,before);assert.equal(denied,1)
})

test('timed-out catalog reads remain coalesced until the actual database work settles', {timeout:6000},async t=>{
 const s=await setup();t.after(()=>s.db.close());let release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),db=s.env.INTEREST_DB
 s.env.INTEREST_DB={...db,prepare(sql){const q=db.prepare(sql);const wrap=(x:typeof q):typeof q=>({bind(...v){return wrap(x.bind(...v))},async first<T>(){await gate;return x.first<T>()},async all<T>(){await gate;return x.all<T>()},run:()=>x.run()});return wrap(q)}}
 await s.get('/');const first=s.stats()
 await Promise.all(Array.from({length:8},()=>s.get('/product/chatgpt')))
 assert.deepEqual(s.stats(),first,'Response deadlines must not release the underlying in-flight read')
 release();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve))
 assert.equal((await s.get('/')).status,200)
})

test('successful price edits invalidate only the SEO cache and preserve current purchase pricing',async t=>{
 const s=await setup();t.after(()=>s.db.close());await s.get('/')
 const plus=s.db.prepare("SELECT version FROM catalog_plans WHERE id='plus'").get()!
 const r=await worker.fetch(new Request(origin+'/api/admin/plans/plus',{method:'POST',headers:{Origin:origin,Cookie:s.admin,'Content-Type':'application/json'},body:JSON.stringify({priceCents:14100,enabled:true,version:plus.version,note:'本地价格变动回归'})}),s.env)
 assert.equal(r.status,200,await r.clone().text())
 const html=await (await s.get('/product/chatgpt')).text()
 const bootstrap=html.match(/<script id="storefront-public-catalog" type="application\/json">([^]*?)<\/script>/)
 assert.ok(bootstrap,'A successful price edit must invalidate the warmed SEO cache and supply a fresh purchase catalog')
 const updated=JSON.parse(bootstrap[1])
 assert.equal(updated.origin,origin)
 assert.equal(updated.catalog.plans.find((p:{id:string})=>p.id==='plus').price_cents,14100)
 assert.equal(s.stats().limits,2,'The updated page must refresh the invalidated SEO catalog')
 const current=await (await worker.fetch(new Request(origin+'/api/catalog'),s.env)).json()
 assert.equal(current.plans.find((p:{id:string})=>p.id==='plus').price_cents,14100)
})

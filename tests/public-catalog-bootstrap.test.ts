import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import worker from '../worker/storefront-entry.ts'
import { customerFixture } from './customer-fixture.ts'

test('only a freshly read main catalog is emitted as one-time client bootstrap',async t=>{
 const s=await customerFixture();t.after(()=>s.db.close())
 const origin='https://shop.example.invalid'
 const env={...s.env,STOREFRONT_SEO_ORIGIN:origin,SEO_CATALOG_LIMITER:{limit:async()=>({success:true})},ASSETS:{fetch:async()=>new Response(readFileSync(new URL('../index.html',import.meta.url),'utf8'),{headers:{'Content-Type':'text/html'}})}}
 const first=await (await worker.fetch(new Request(origin+'/product/chatgpt'),env)).text()
 const match=first.match(/<script id="storefront-public-catalog" type="application\/json">([^]*?)<\/script>/)
 assert.ok(match,'The existing fresh read must be available to the client, without another catalog request')
 const data=JSON.parse(match[1]);assert.equal(data.origin,origin);assert.equal(data.catalog.checkoutEnabled,true);assert.equal(data.catalog.testingEnabled,true)
 assert.ok(data.catalog.plans.some((p:{id:string})=>p.id==='plus'));assert.deepEqual(data.catalog.supportContacts,{wechat:'',qq:'',email:''})
 const cached=await (await worker.fetch(new Request(origin+'/product/chatgpt'),env)).text()
 assert.doesNotMatch(cached,/id="storefront-public-catalog"/,'Cached SEO prices must never initialize purchase state')
})

import { publicBootstrapCatalog, serializePublicBootstrap, parsePublicBootstrap } from '../shared/public-bootstrap.ts'
import { consumePublicCatalogBootstrap, readPublicCatalog } from '../src/lib/public-catalog-bootstrap.ts'
import { readStoreResources } from '../src/lib/store-reads.ts'
const sample = () => ({plans:[{id:'plus',product_id:'chatgpt',name:'Plus',price_cents:13800,enabled:1,renewal_only:0,version:2,supports_warranty:false,has_coupons:true,purchase_note:'购买须知',delivery_instructions:'公开指引'}],checkoutEnabled:true,testingEnabled:false,platformBranding:{name:'商店',logo:'',pageTitle:'标题',headline:'介绍',description:'说明',version:1},supportContacts:{wechat:'客服',qq:'',email:''},paymentMethods:[{method:'alipay',name:'支付宝',feeBps:30}],announcement:{enabled:true,placement:'home',title:'公告',content:'内容',version:1},marketingMetric:{enabled:true,displayText:'示例',displayCount:3},hiddenProductIds:[],productOrder:['chatgpt']})

test('bootstrap retains public checkout settings and escapes active markup without copying secrets',()=>{
 const data=sample();data.plans[0].purchase_note='</script><script>alert(1)</script>&'
 const raw={...data,orders:['private-order'],session:'private-session',cost_cents:123,plans:[{...data.plans[0],encrypted_value:'PRIVATE_CDK',cost_cents:999}]}
 const text=serializePublicBootstrap(raw,'https://shop.example.invalid',1000)
 assert.doesNotMatch(text,/<script|<\/script|PRIVATE_CDK|private-order|private-session|cost_cents/)
 const parsed=parsePublicBootstrap<ReturnType<typeof sample>>(text,'https://shop.example.invalid',1001)!
 assert.deepEqual(parsed,publicBootstrapCatalog(data));assert.equal(parsed.plans[0].supports_warranty,false);assert.equal(parsed.paymentMethods[0].feeBps,30)
})

test('expired, foreign, partner and malformed bootstrap never replaces a fresh API read',()=>{
 const origin='https://shop.example.invalid',text=serializePublicBootstrap(sample(),origin,1000)
 for(const [input,host,now] of [[text,origin,7000],[text,'https://other.invalid',1001],['{broken',origin,1001],[JSON.stringify({version:1,origin,fetchedAt:1000,catalog:{...sample(),partner:{slug:'x'}}}),origin,1001]] as const)assert.equal(parsePublicBootstrap(input,host,now),null)
 let removed=0;const source={textContent:text,remove(){removed++}}
 assert.equal(consumePublicCatalogBootstrap(source,origin,'ABCDEF',1001),null);assert.equal(removed,0)
 assert.ok(consumePublicCatalogBootstrap(source,origin,undefined,1001));assert.equal(removed,1)
})

test('fresh bootstrap is used once; subsequent refreshes and shop selection keep the API loader',async t=>{
 const savedDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),savedLocation=Object.getOwnPropertyDescriptor(globalThis,'location')
 t.after(()=>{if(savedDocument)Object.defineProperty(globalThis,'document',savedDocument);else Reflect.deleteProperty(globalThis,'document');if(savedLocation)Object.defineProperty(globalThis,'location',savedLocation);else Reflect.deleteProperty(globalThis,'location')})
 const origin='https://shop.example.invalid';let removed=false,calls=0
 const source={textContent:serializePublicBootstrap(sample(),origin,Date.now()),remove(){removed=true}}
 Object.defineProperty(globalThis,'document',{configurable:true,value:{documentElement:{dataset:{publicSeo:'true',publicOrigin:origin}},getElementById:()=>removed?null:source}})
 Object.defineProperty(globalThis,'location',{configurable:true,value:{origin}})
 const loader=async()=>{calls++;return sample()}
 const first=await readPublicCatalog(loader);assert.equal(first.plans[0].price_cents,13800);assert.equal(calls,0)
 await readPublicCatalog(loader);await readPublicCatalog(loader,'ABCDEF');assert.equal(calls,2)
})

test('reused catalog never skips buyer initialization or enables ordering when initialization fails',async()=>{
 const events:string[]=[]
 const result=await readStoreResources({initialize:async()=>{events.push('initialize');throw new Error('cookie unavailable')},orders:async()=>{events.push('orders');return []},catalog:async()=>sample(),onCatalog:()=>events.push('catalog'),onOrders:()=>events.push('orders-ready'),onReady:()=>events.push('ready')})
 assert.deepEqual(result.map(r=>r.status),['rejected','fulfilled','rejected']);assert.ok(events.includes('catalog'));assert.ok(events.includes('initialize'));assert.ok(!events.includes('orders'));assert.ok(!events.includes('ready'))
})

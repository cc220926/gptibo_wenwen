import test from 'node:test'
import assert from 'node:assert/strict'
import { paymentProvider, servicePaymentProviderId, servicePaymentConfigured } from '../worker/payments/providers.ts'
import type { Env } from '../worker/platform.ts'
const env={SERVICE_PAYMENT_PROVIDER:'mapay',MAPAY_PID:'10101',MAPAY_KEY:'private-mapay-fixture-key'} as Env

test('Mapay is a separate selected payment provider and never borrows ZPAY credentials',()=>{
  assert.equal(servicePaymentProviderId(env),'mapay')
  assert.equal(servicePaymentConfigured(env),true)
  assert.equal(paymentProvider(env,'mapay').account,'10101')
  assert.equal(servicePaymentConfigured({...env,MAPAY_KEY:undefined,ZPAY_PID:'2026110000',ZPAY_KEY:'private-zpay-fixture-key'}),false)
})

import { signZpayParams } from '../worker/payments/zpay-protocol.ts'
const order={id:'YMX-'+ 'A'.repeat(32),amountCents:6900,subject:'Muse 310亿成品号',expiresAt:Date.now()+900000}
const credentials={pid:env.MAPAY_PID!,key:env.MAPAY_KEY!}
const provider=()=>paymentProvider(env,'mapay')
function notice(method='GET',patch:Record<string,string>={}) {
  const params=new URLSearchParams({pid:credentials.pid,type:'alipay',out_trade_no:'A'.repeat(32),trade_no:'trade_mapay_1',money:'69.00',trade_status:'TRADE_SUCCESS',sign_type:'MD5',...patch})
  params.set('sign',signZpayParams(params,credentials.key))
  const base='https://shop.example.invalid/api/payments/notify/mapay'
  return method==='GET'?new Request(base+'?'+params):new Request(base,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body:params.toString()})
}
const record=(patch:Record<string,unknown>={})=>({code:1,pid:Number(credentials.pid),type:'alipay',out_trade_no:'A'.repeat(32),money:'69.00',status:1,trade_no:'trade_mapay_1',...patch})

test('Mapay API prepares a direct payment QR with signed original-order fields and a bounded deadline',async t=>{
  const sent: URLSearchParams[]=[]
  t.mock.method(globalThis,'fetch',async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://mzf.mapay.cn');assert.equal(init?.redirect,'manual')
    if(url.pathname==='/xpay/epay/api.php')return Response.json(record({status:0}))
    assert.equal(url.pathname,'/xpay/epay/mapi.php');assert.equal(init?.method,'POST')
    const params=new URLSearchParams(String(init.body));sent.push(params)
    assert.equal(params.get('pid'),credentials.pid);assert.equal(params.get('money'),'69.00');assert.equal(params.get('device'),'pc')
    assert.equal(params.get('sign'),signZpayParams(params,credentials.key));assert.equal(params.get('out_trade_no'),'A'.repeat(32))
    assert.equal(params.get('return_url'),'https://shop.example.invalid/orders');assert.equal(params.has('key'),false)
    return Response.json({code:1,trade_no:'trade_mapay_1',money:'69.00',qrcode:'https://qr.alipay.com/mapayfixturepayment',urlscheme:'alipays://platformapi/startapp?untrusted=ignored'})
  })
  const before=Date.now(),result=await provider().create(order,'https://shop.example.invalid/api/payments/notify/mapay')
  assert.equal(result.qr,'https://qr.alipay.com/mapayfixturepayment');assert.ok(result.expiresAt!<=Date.now()+300000);assert.ok(result.expiresAt!>=before)
  await assert.rejects(provider().create(order,'https://shop.example.invalid/api/payments/notify/zpay'))
  await assert.rejects(provider().create(order,'http://shop.example.invalid/api/payments/notify/mapay'))
  await provider().create({...order,subject:'汉字'.repeat(100)},'https://shop.example.invalid/api/payments/notify/mapay')
  assert.ok(new TextEncoder().encode(sent.at(-1)!.get('name')!).byteLength<=127)
  const shorter=Date.now()+60000
  assert.equal((await provider().create({...order,expiresAt:shorter},'https://shop.example.invalid/api/payments/notify/mapay')).expiresAt,shorter)
})

test('Mapay API accepts a same-origin cashier only as navigation and rejects ambiguous or unsafe destinations',async t=>{
  let patch:Record<string,unknown>={payurl:'https://mzf.mapay.cn/pay/trade_mapay_1'}
  t.mock.method(globalThis,'fetch',async input=>new URL(String(input)).pathname.endsWith('/api.php')?Response.json(record({status:0})):Response.json({code:1,trade_no:'trade_mapay_1',money:'69.00',...patch}))
  assert.equal((await provider().create(order,'https://shop.example.invalid/api/payments/notify/mapay')).qr,patch.payurl)
  for(const value of [
    {qrcode:'https://qr.alipay.com.evil.test/mapayfixturepayment'},
    {qrcode:'https://qr.alipay.com/mapayfixturepayment?redirect=private'},
    {payurl:'http://mzf.mapay.cn/pay/trade_mapay_1'},
    {payurl:'https://mzf.mapay.cn.evil.test/pay/trade_mapay_1'},
    {payurl:'https://evil.test/pay/trade_mapay_1'},
    {qrcode:'https://qr.alipay.com/mapayfixturepayment',payurl:'https://mzf.mapay.cn/pay/trade_mapay_1'},
    {urlscheme:'alipays://unsafe'}, {code:0,payurl:'https://mzf.mapay.cn/pay/trade_mapay_1'},
    {money:'1.00',payurl:'https://mzf.mapay.cn/pay/trade_mapay_1'},
    {trade_no:'other_trade',payurl:'https://mzf.mapay.cn/pay/other_trade'},
  ]) {patch=value;await assert.rejects(provider().create(order,'https://shop.example.invalid/api/payments/notify/mapay'))}
})

test('Mapay creation rejects redirects and oversized payloads without exposing gateway contents',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('PRIVATE-BODY',{status:302,headers:{location:'https://evil.test'}}))
  await assert.rejects(provider().create(order,'https://shop.example.invalid/api/payments/notify/mapay'),e=>e instanceof Error&&!e.message.includes('PRIVATE'))
  t.mock.restoreAll();let canceled=false
  t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(17000))},cancel(){canceled=true}})))
  await assert.rejects(provider().create(order,'https://shop.example.invalid/api/payments/notify/mapay'),/malformed/);assert.equal(canceled,true)
})

test('GET and form POST callbacks require an independently matching paid gateway query',async t=>{
  let status=0,calls=0
  t.mock.method(globalThis,'fetch',async(input,init)=>{
    calls++;const url=new URL(String(input));assert.equal(url.origin,'https://mzf.mapay.cn');assert.equal(url.pathname,'/xpay/epay/api.php')
    assert.equal(url.searchParams.get('act'),'order');assert.equal(url.searchParams.get('key'),credentials.key);assert.equal(init?.redirect,'manual')
    return Response.json(record({status}))
  })
  await assert.rejects(provider().notification(notice()),/mismatch/)
  status=1
  for(const method of ['GET','POST']) assert.deepEqual(await provider().notification(notice(method)),{orderId:order.id,amountCents:6900,status:'paid',tradeNo:'trade_mapay_1'})
  assert.equal(calls,3)
})

test('forged, duplicated, mixed-source and oversized Mapay callbacks cannot reach gateway queries',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json(record())})
  const good=notice(),bad=new URL(good.url);bad.searchParams.set('money','1.00')
  await assert.rejects(provider().notification(new Request(bad)))
  const duplicate=new URL(good.url);duplicate.searchParams.append('money','69.00')
  await assert.rejects(provider().notification(new Request(duplicate)))
  const form=await notice('POST').text()
  await assert.rejects(provider().notification(new Request(good.url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form})))
  await assert.rejects(provider().notification(new Request('https://shop.example.invalid/api/payments/notify/mapay',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})))
  await assert.rejects(provider().notification(new Request('https://shop.example.invalid/api/payments/notify/mapay',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'x='+ 'a'.repeat(17000)})))
  for(const patch of [{pid:'9999'},{type:'wxpay'},{trade_status:'WAIT_BUYER_PAY'}]) await assert.rejects(provider().notification(notice('GET',patch)))
  assert.equal(calls,0)
})

test('query rejects amount, merchant, method, order, trade and status mismatches without leaking response contents',async t=>{
  for(const patch of [{money:'1.00'},{pid:9999},{type:'wxpay'},{out_trade_no:'B'.repeat(32)},{status:'1'},{status:2},{trade_no:''}]) {
    t.mock.method(globalThis,'fetch',async()=>Response.json(record(patch)))
    await assert.rejects(provider().query(order))
    t.mock.restoreAll()
  }
  t.mock.method(globalThis,'fetch',async()=>Response.json(record({trade_no:'other_trade'})))
  await assert.rejects(provider().notification(notice()),/mismatch/)
  t.mock.restoreAll()
  t.mock.method(globalThis,'fetch',async()=>new Response('PRIVATE-PROVIDER-BODY',{status:302,headers:{location:'https://evil.test'}}))
  await assert.rejects(provider().query(order),e=>e instanceof Error&&!e.message.includes('PRIVATE'))
})

test('chunked query replies are byte bounded, canceled on overflow, and never interpreted as paid',async t=>{
  let canceled=false
  t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(17000))},cancel(){canceled=true}})))
  await assert.rejects(provider().query(order),/malformed/);assert.equal(canceled,true)
})

test('switching new-service checkout to Mapay preserves original ZPAY payment adapters',()=>{
  const current={...env,ZPAY_PID:'202611001',ZPAY_KEY:'private-zpay-fixture-key'}
  assert.equal(paymentProvider(current,'zpay').account,'202611001')
  assert.equal(paymentProvider(current,'mapay').account,credentials.pid)
  assert.equal(provider().acknowledge(true).status,200);assert.equal(provider().acknowledge(false).status,400)
})


test('Muse may choose Mapay without changing non-Muse checkout or borrowing its credentials',()=>{
  const split={...env,SERVICE_PAYMENT_PROVIDER:'zpay',MUSE_PAYMENT_PROVIDER:'mapay',ZPAY_PID:'202611001',ZPAY_KEY:'private-zpay-fixture-key'}
  assert.equal(servicePaymentProviderId(split),'zpay')
  assert.equal(servicePaymentProviderId(split,true),'mapay')
  assert.equal(servicePaymentConfigured(split,true),true)
  assert.equal(servicePaymentConfigured({...split,MAPAY_KEY:undefined},true),false)
  assert.equal(servicePaymentConfigured({...split,MAPAY_KEY:undefined}),true)
})

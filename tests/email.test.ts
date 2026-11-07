import test from 'node:test'
import assert from 'node:assert/strict'
import { brandEmailMessage, emailPayload, mailBrand, membershipDeliveryMessage, partnerInvitationMessage, rechargeReminderMessage, sendFrozenEmail, sendPartnerInvitationEmail, verificationMessage, sendVerificationEmail } from '../worker/email.ts'
import type { Env } from '../worker/platform.ts'
import { authRoute } from '../worker/admin-auth.ts'
import { mailConfigured } from '../worker/partner-auth.ts'

test('verification mail preserves leading zeroes, purpose and fallback without exposing a code in the inbox preview', () => {
  for (const kind of ['partner-login', 'order-recovery', 'admin-login'] as const) {
    const mail = verificationMessage(kind, '001234')
    assert.match(mail.html, /001234/)
    const preview = mail.html.match(/data-skip-in-text="true">([^<]*)/)?.[1]
    assert.ok(preview)
    assert.doesNotMatch(preview, /001234/)
    assert.match(mail.text, /001234/)
    assert.doesNotMatch(mail.html + mail.text, /__RECHARGE_VERIFICATION_CODE__/)
    assert.match(mail.html, /lang="zh-CN"/)
    assert.match(mail.html, /prefers-color-scheme: dark/)
    assert.match(mail.html, /https:\/\/shop.example.invalid\/email-logo.png/)
    assert.doesNotMatch(mail.html, /<script|<svg|<iframe|onclick=/i)
    assert.ok(mail.html.length < 100000, 'Stay below Gmail clipping threshold')
    assert.ok(mail.text.includes(kind === 'order-recovery' ? '订单' : kind === 'admin-login' ? '管理后台' : '代理工作台'))
    if (kind === 'partner-login') assert.match(mail.text, /https:\/\/shop.example.invalid\/join/)
    assert.match(mail.text, /10 分钟/)
  }
  assert.throws(() => verificationMessage('partner-login', '<img>'))
  assert.throws(() => verificationMessage('partner-login', '12345'))
})

test('partner invitation contains a durable login link and instructions without an OTP or expiry', async t => {
  const mail = partnerInvitationMessage({MAIL_PUBLIC_ORIGIN:'https://mail-store.example.test'})
  assert.match(mail.text, /账号已开通/)
  assert.match(mail.text, /https:\/\/mail-store.example.test\/join/)
  assert.match(mail.text, /获取验证码/)
  assert.match(mail.html, /进入代理工作台/)
  assert.doesNotMatch(mail.html + mail.text, /__RECHARGE_VERIFICATION_CODE__|10 分钟|身份验证/)
  assert.doesNotMatch(mail.text, /\b\d{6}\b/)
  assert.match(mail.html, /prefers-color-scheme: dark/)
  assert.doesNotMatch(mail.html, /<script|<svg|<iframe|onclick=/i)
  const env = { MAIL_PUBLIC_ORIGIN:'https://mail-store.example.test', RESEND_FROM: 'GPTibo <noreply@shop.example.invalid>', RESEND_API_KEY: 'test' } as Env
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal(new Headers(options.headers).get('Idempotency-Key'), 'partner-welcome/invitation')
    const payload = JSON.parse(String(options.body))
    assert.deepEqual(payload.to, ['partner@example.test'])
    assert.equal(payload.html, mail.html)
    assert.equal(payload.text, mail.text)
    return Response.json({ id: 'invitation-mail' })
  })
  await sendPartnerInvitationEmail(env, 'partner@example.test', 'invitation')
})

test('Resend receives HTML and text together with stable idempotency and delivery errors propagate', async t => {
  const env = { MAIL_PUBLIC_ORIGIN:'https://mail-store.example.test', RESEND_FROM: 'GPTibo <noreply@shop.example.invalid>', RESEND_API_KEY: 'test' } as Env
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails')
    assert.equal(new Headers(options.headers).get('Idempotency-Key'), 'order-recovery/challenge')
    const mail = JSON.parse(String(options.body))
    assert.deepEqual(mail.to, ['buyer@example.test'])
    assert.match(mail.html, /001234/)
    assert.match(mail.text, /001234/)
    assert.match(mail.subject, /订单找回/)
    return Response.json({id:'verified-mail'})
  })
  await sendVerificationEmail(env, 'order-recovery', 'buyer@example.test', '001234', 'challenge')
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }))
  await assert.rejects(sendVerificationEmail(env, 'partner-login', 'buyer@example.test', '001234', 'challenge'))
})


test('real outgoing verification mail uses the trusted runtime brand origin', async t => {
  const env = { MAIL_PUBLIC_ORIGIN: 'https://mail-store.example.test', MAIL_BRAND_NAME: '示例商店', RESEND_FROM: 'Store <mail@example.test>', RESEND_API_KEY: 'test' } as Env
  let payload: {html:string;text:string;subject:string} | undefined
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    payload = JSON.parse(String(options.body))
    return Response.json({id:'runtime-mail'})
  })
  await sendVerificationEmail(env, 'order-recovery', 'buyer@example.test', '001234', 'runtime-brand')
  assert.ok(payload)
  assert.match(payload.html, /https:\/\/mail-store.example.test\/email-logo.png/)
  assert.match(payload.text, /https:\/\/mail-store.example.test\/orders/)
  assert.match(payload.html, /示例商店/)
  assert.doesNotMatch(payload.html + payload.text, /shop.example.invalid|__RECHARGE_BRAND_/)
})

test('HTTP success without a provider mail id remains unconfirmed', async t => {
  const env = { MAIL_PUBLIC_ORIGIN:'https://mail-store.example.test', RESEND_FROM:'mail@example.test', RESEND_API_KEY:'test' } as Env
  t.mock.method(globalThis, 'fetch', async () => Response.json({}))
  await assert.rejects(sendVerificationEmail(env, 'order-recovery', 'buyer@example.test', '001234', 'unconfirmed'))
})


test('every mail family resolves runtime branding before inserting user-controlled values', () => {
  const env = { MAIL_PUBLIC_ORIGIN:'https://mail-store.example.test/', MAIL_BRAND_NAME:'商店 <A> & B' }
  const messages = [
    ...(['admin-login', 'partner-login', 'order-recovery'] as const).map(kind => verificationMessage(kind, '001234', env)),
    partnerInvitationMessage(env),
    rechargeReminderMessage({orderId:'sample',planName:'计划',contacts:'__RECHARGE_BRAND_NAME__'}, env),
    membershipDeliveryMessage('link', 'sample', 'https://claims.example.test/item', '__RECHARGE_BRAND_NAME__', 'gemini-pro-18m', env),
    membershipDeliveryMessage('cdk', 'sample', 'DEMO-CDK', '__RECHARGE_BRAND_NAME__', 'duolingo-12m', env),
    membershipDeliveryMessage('cdk', 'sample', 'https://www.duolingo.com/claim/super?code=DEMO', '说明', 'duolingo-12m', env),
    membershipDeliveryMessage('cdk', 'sample', 'demo@example.test----DEMO', '说明', 'gmail-account', env),
  ]
  for (const message of messages) {
    assert.match(message.html, /商店 &lt;A&gt; &amp; B/)
    assert.match(message.text, /商店 <A> & B/)
    assert.match(message.html, /https:\/\/mail-store.example.test\/email-logo.png/)
    assert.doesNotMatch(message.html + message.text, /shop.example.invalid|__RECHARGE_BRAND_(?:LOGO|ORDERS_URL|WORKSPACE_URL|ADMIN_URL)__/)
    assert.doesNotMatch(message.html, /商店 <A>/)
  }
  for (const index of [4, 5, 6]) assert.match(messages[index].html + messages[index].text, /__RECHARGE_BRAND_NAME__/)
  assert.deepEqual(mailBrand(env), {name:'商店 <A> & B',origin:'https://mail-store.example.test'})
  const custom = brandEmailMessage(env, {subject:'__RECHARGE_BRAND_NAME__', html:'<a href="__RECHARGE_BRAND_ORDERS_URL__">__RECHARGE_BRAND_NAME__</a>',text:'__RECHARGE_BRAND_ORDERS_URL__'})
  assert.equal(custom.subject, '商店 <A> & B')
  assert.equal(custom.text, 'https://mail-store.example.test/orders')
})

test('missing or unsafe origin fails before any provider request', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {calls++; return Response.json({id:'unexpected'})})
  for (const origin of [undefined, '', 'http://shop.example.test', 'https://u:p@shop.example.test', 'https://shop.example.test/nested', 'https://shop.example.test?x=1', 'https://shop.example.test/#fragment', 'https://shop.example.invalid']) {
    const env = {MAIL_PUBLIC_ORIGIN:origin,RESEND_FROM:'mail@example.test',RESEND_API_KEY:'test'} as Env
    await assert.rejects(sendVerificationEmail(env, 'order-recovery', 'buyer@example.test', '001234', 'invalid-config'))
  }
  assert.equal(calls,0)
})

test('frozen provider bytes and key survive sender, brand and origin rotation', async t => {
  const env = {MAIL_PUBLIC_ORIGIN:'https://mail-store.example.test',RESEND_FROM:'original@example.test',RESEND_API_KEY:'test'} as Env
  const body = emailPayload(env,'buyer@example.test',verificationMessage('order-recovery','001234',env))
  const requests: {body:string;key:string|null}[] = []
  t.mock.method(globalThis,'fetch',async (_url:string,options:RequestInit) => {
    requests.push({body:String(options.body),key:new Headers(options.headers).get('Idempotency-Key')})
    if(requests.length===1) throw new Error('lost response')
    return Response.json({id:'provider-mail'})
  })
  await assert.rejects(sendFrozenEmail(env,body,'fixed-key'))
  Object.assign(env,{RESEND_FROM:'changed@example.test',MAIL_BRAND_NAME:'Changed',MAIL_PUBLIC_ORIGIN:'https://changed.example.test'})
  assert.equal(await sendFrozenEmail(env,body,'fixed-key'),'provider-mail')
  assert.deepEqual(requests[0],requests[1])
  assert.equal(JSON.parse(requests[1].body).from,'original@example.test')
})

test('provider redirects, malformed ids and oversized acknowledgements stay unconfirmed', async t => {
  const env = {RESEND_FROM:'mail@example.test',RESEND_API_KEY:'test'} as Env
  const body = emailPayload(env,'buyer@example.test',{subject:'Subject',html:'<p>Body</p>',text:'Body'})
  for (const response of [new Response(null,{status:302,headers:{Location:'https://other.example.test'}}),Response.json({id:''}),Response.json({id:'bad/id'}),Response.json({id:'x'.repeat(129)}),Response.json({id:'valid',padding:'x'.repeat(16400)})]) {
    t.mock.method(globalThis,'fetch',async (_url:string,options:RequestInit) => {assert.equal(options.redirect,'manual'); return response})
    await assert.rejects(sendFrozenEmail(env,body,'same-key'))
  }
})


test('login availability reports unsafe mail origins before accepting a code request', async () => {
  const env = {RESEND_API_KEY:'test',RESEND_FROM:'mail@example.test',PARTNER_AUTH_SECRET:'s'.repeat(32),ADMIN_EMAIL:'admin@example.test',ADMIN_USERNAME:'admin',ADMIN_TOTP_SECRET:'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'} as Env
  for (const origin of [undefined,'http://shop.example.test','https://shop.example.test/path']) {
    env.MAIL_PUBLIC_ORIGIN = origin
    const response = await authRoute(new Request('https://request.example.test/api/admin/session'),env,'/api/admin/session')
    const data = await response!.json() as {configured:boolean;mailReady:boolean}
    assert.equal(data.configured,true, 'Mail availability must not replace administrator authorization config')
    assert.equal(data.mailReady,false)
    assert.equal(mailConfigured(env),false)
  }
  env.MAIL_PUBLIC_ORIGIN = 'https://mail-store.example.test'
  assert.equal(mailConfigured(env),true)
  const response = await authRoute(new Request('https://request.example.test/api/admin/session'),env,'/api/admin/session')
  assert.equal((await response!.json() as {mailReady:boolean}).mailReady,true)
})

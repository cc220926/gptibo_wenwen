import test from 'node:test'
import assert from 'node:assert/strict'
import { checkoutSession } from '../src/lib/checkout-session.ts'

test('Session input requires both a complete account and token before authorizing recharge', () => {
  for (const raw of ['{', 'null', '{}', '{"user":{"email":"buyer@example.test"}}', '{"user":{"email":"wrong"},"accessToken":"token"}', '{"user":{"email":"buyer@example.test"},"accessToken":" "}']) {
    const parsed = checkoutSession(raw)
    assert.equal(parsed.credential, null)
    assert.equal(parsed.email, '')
    assert.ok(parsed.problem)
  }
  assert.equal(checkoutSession('').problem, '')
})

test('Session recovery preserves exact JSON bytes for the original idempotent submission', () => {
  const original = '  { "user": { "email": "buyer@example.test" }, "accessToken": "private-token" }\n'
  const parsed = checkoutSession(original, 'session')
  assert.equal(parsed.email, 'buyer@example.test')
  assert.equal(parsed.problem, '')
  assert.deepEqual(parsed.credential, { mode: 'session', session: original })
})

test('an empty login response explains how to log in and cannot authorize a new or recovery submission', () => {
  for (const raw of ['{}', ' \n { \t } \n']) for (const mode of [undefined, 'session', 'access_token'] as const) {
    const result = checkoutSession(raw, mode)
    assert.equal(result.credential, null)
    assert.match(result.problem, /尚未登录/)
    assert.match(result.problem, /chatgpt\.com/)
    assert.match(result.problem, /同一浏览器/)
  }
})

test('an existing uncertain access-token submission can recover from Session without changing credential mode or token bytes', () => {
  const raw = JSON.stringify({ user: { email: 'buyer@example.test' }, accessToken: ' private-token ' })
  assert.deepEqual(checkoutSession(raw, 'access_token').credential, { mode: 'access_token', access_token: ' private-token ' })
  assert.deepEqual(checkoutSession(raw).credential, { mode: 'session', session: raw })
})


test('new complete Session inputs retain account identity and enforce the encoded request limit without truncation', () => {
  const raw=JSON.stringify({user:{email:'buyer@example.test'},account:{id:'account-two'},accessToken:'private-token',extra:'x'.repeat(150000)})
  assert.deepEqual(checkoutSession(raw).credential,{mode:'session',session:raw})
  assert.equal(checkoutSession(JSON.stringify({user:{email:'buyer@example.test'},accessToken:'x'.repeat(128*1024+1)})).credential,null)
  const oversized=JSON.stringify({user:{email:'buyer@example.test'},accessToken:'token',extra:'中'.repeat(100000)})
  assert.equal(checkoutSession(oversized).credential,null)
  assert.match(checkoutSession(oversized).problem,/过长/)
  assert.match(checkoutSession('x'.repeat(256*1024+1)).problem,/过长/)
})

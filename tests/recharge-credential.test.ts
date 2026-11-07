import test from 'node:test'
import assert from 'node:assert/strict'
import { rechargeCredentialToken } from '../shared/recharge-credential.ts'

test('credential validation extracts supported wrappers without rewriting idempotent payloads', () => {
  const token = 'sensitive-fixture-token'
  for (const value of [token, JSON.stringify({ sessionToken: token }), JSON.stringify({ data: { session: token } }), JSON.stringify({ auth: { accessToken: token } })]) assert.equal(rechargeCredentialToken(value, 'session').token, token)
  const expires = '2030-01-01T00:00:00Z'
  assert.deepEqual(rechargeCredentialToken(JSON.stringify({ auth: { access_token: token, expires } }), 'access_token'), { token, expires })
  assert.equal(rechargeCredentialToken('  ' + token + '  ', 'access_token').token, token)
})

test('only the extracted token has a 128 KiB character bound', () => {
  const token = 'x'.repeat(128 * 1024)
  const raw = JSON.stringify({ user: { email: 'buyer@example.test' }, accessToken: token, extra: 'x'.repeat(80000) })
  assert.equal(rechargeCredentialToken(raw, 'session').token.length, 128 * 1024)
  assert.throws(() => rechargeCredentialToken(token + 'x', 'session'))
  assert.throws(() => rechargeCredentialToken(JSON.stringify({ accessToken: token + 'x' }), 'access_token'))
})

test('missing tokens and malformed wrappers fail without including credentials in errors', () => {
  for (const raw of ['', '  ', '{}', '{"sensitive-fixture-token":true}', '{"accessToken":"  "}', '{sensitive-fixture-token']) {
    assert.throws(() => rechargeCredentialToken(raw, 'session'), error => error instanceof Error && !error.message.includes('sensitive-fixture-token'))
  }
})

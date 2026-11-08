import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscriptionExpiryHint, subscriptionFailureMessage } from '../worker/recharge/errors.ts'

test('active-plan errors extract only a calendar-valid date with no inferred timezone', () => {
  const message = '当前账号的目标套餐有效至 2026-11-08 05:26，到期后才能再次购买（GPT_PLAN_ALREADY_ACTIVE）'
  assert.equal(subscriptionExpiryHint(message), '2026-11-08 05:26')
  for (const invalid of ['2026-02-30 05:26', '2026-13-08 05:26', '2026-11-08 24:26', '2026-11-08 05:60', '9999-11-08 05:26']) assert.equal(subscriptionExpiryHint(message.replace('2026-11-08 05:26', invalid)), null)
  assert.equal(subscriptionExpiryHint(message.replace('GPT_PLAN_ALREADY_ACTIVE', 'OTHER_ERROR')), null)
  assert.equal(subscriptionExpiryHint('x'.repeat(4001) + message), null)
  assert.equal(subscriptionExpiryHint({ message }), null)
})

test('customer copy uses only normalized context and an upstream-authorized retry flag', () => {
  const hint = subscriptionExpiryHint('PRIVATE-SESSION target@example.test 当前账号的目标套餐有效至 2026-11-08 05:26（GPT_PLAN_ALREADY_ACTIVE）')
  const text = subscriptionFailureMessage(hint, true)
  assert.match(text, /本次未充值/)
  assert.match(text, /2026-11-08 05:26/)
  assert.match(text, /未注明时区/)
  assert.match(text, /本订单重新提交/)
  assert.doesNotMatch(text, /PRIVATE|example|北京时间/)
  assert.doesNotMatch(subscriptionFailureMessage(hint, false), /可在本订单重新提交/)
  assert.doesNotMatch(subscriptionFailureMessage('malicious session', false), /malicious/)
})

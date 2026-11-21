import test from 'node:test'
import assert from 'node:assert/strict'
import { homeGuideCopy, homeHelpCopy, searchHomeQuestions } from '../src/lib/home-guidance.ts'

test('help search finds recovery, credentials, manual delivery and refunds without mixing up actions', () => {
  assert.equal(searchHomeQuestions('zh-CN', '页面关了')[0].id, 'recovery')
  assert.equal(searchHomeQuestions('zh-CN', '手动')[0].id, 'manual')
  assert.equal(searchHomeQuestions('zh-CN', 'Session')[0].id, 'credentials')
  assert.equal(searchHomeQuestions('zh-CN', '质保')[0].id, 'refund')
  assert.equal(searchHomeQuestions('zh-CN', '质保')[0].action, 'orders')
  assert.equal(searchHomeQuestions('zh-CN', '手动')[0].action, 'support')
})

test('search handles whitespace, full-width English, casing, multiple terms and no results', () => {
  assert.equal(searchHomeQuestions('en', '  ＳＥＳＳＩＯＮ   PRIVACY  ')[0].id, 'credentials')
  assert.equal(searchHomeQuestions('zh-CN', '付款 延迟')[0].id, 'pending')
  assert.deepEqual(searchHomeQuestions('zh-CN', '不存在的问题' + 'x'.repeat(200)), [])
  assert.deepEqual(searchHomeQuestions('en', 'password refund xyz'), [])
  assert.equal(searchHomeQuestions('zh-CN', ' \n\t ').length, 8)
})

test('both locales cover the same questions and support scenarios with stable destinations', () => {
  const zh = searchHomeQuestions('zh-CN')
  const en = searchHomeQuestions('en')
  assert.deepEqual(en.map(q => [q.id, q.action]), zh.map(q => [q.id, q.action]))
  assert.equal(new Set(zh.map(q => q.id)).size, zh.length)
  assert.deepEqual(homeHelpCopy('en').scenarios.map(s => s.id), homeHelpCopy('zh-CN').scenarios.map(s => s.id))
  assert.equal(searchHomeQuestions('en', '退款')[0].id, 'refund')
})

test('guidance distinguishes redemption and manual delivery and never presents scenarios as real records', () => {
  assert.match(homeGuideCopy('zh-CN').demoDisclaimer, /不会创建订单、付款或提交账号信息/)
  assert.match(homeGuideCopy('zh-CN').subtitle, /以 ChatGPT 充值为例.*其他商品/)
  assert.match(searchHomeQuestions('zh-CN', '兑换')[0].answer, /兑换/)
  assert.match(homeHelpCopy('zh-CN').caseDisclaimer, /并非真实客户案例/)
  assert.match(homeHelpCopy('en').caseDisclaimer, /not real customer cases/)
  assert.match(searchHomeQuestions('zh-CN', '退款')[0].answer, /以商品售后规则及审核结果为准/)
})

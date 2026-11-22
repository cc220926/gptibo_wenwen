import test from 'node:test'
import assert from 'node:assert/strict'
import { homeGuideCopy, homeHelpCopy, homeFeedbackCopy, searchHomeQuestions } from '../src/lib/home-guidance.ts'

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
  assert.equal(searchHomeQuestions('zh-CN', ' \n\t ').length, 9)
})

test('both locales cover the same questions and feedback with stable destinations', () => {
  const zh = searchHomeQuestions('zh-CN')
  const en = searchHomeQuestions('en')
  assert.deepEqual(en.map(q => [q.id, q.action]), zh.map(q => [q.id, q.action]))
  assert.equal(new Set(zh.map(q => q.id)).size, zh.length)
  assert.deepEqual(homeFeedbackCopy('en').items.map(item => [item.id, item.image]), homeFeedbackCopy('zh-CN').items.map(item => [item.id, item.image]))
  assert.match(homeFeedbackCopy('en').languageNote, /Chinese/)
  assert.match(homeFeedbackCopy('en').items[1].description, /had not purchased/)
  assert.match(homeFeedbackCopy('en').items[1].context, /CNY 5/)
  assert.equal(searchHomeQuestions('en', '退款')[0].id, 'refund')
})

test('guidance retains tutorial and support boundaries when adding user feedback', () => {
  assert.match(homeGuideCopy('zh-CN').demoDisclaimer, /不会创建订单、付款或提交账号信息/)
  assert.match(homeGuideCopy('zh-CN').subtitle, /以 ChatGPT 充值为例.*其他商品/)
  assert.match(searchHomeQuestions('zh-CN', '兑换')[0].answer, /兑换/)
  assert.equal(homeHelpCopy('zh-CN').cases, '用户反馈')
  assert.equal(homeHelpCopy('en').cases, 'User feedback')
  assert.match(searchHomeQuestions('zh-CN', '手动')[0].answer, /商品说明.*客服确认/)
  assert.match(searchHomeQuestions('zh-CN', '退款')[0].answer, /以商品售后规则及审核结果为准/)
})


test('Apple login questions are searchable and route account eligibility to support', () => {
  for (const locale of ['zh-CN', 'en'] as const) {
    for (const term of ['Apple', 'apple id', '苹果', '隐藏邮箱']) {
      const matches = searchHomeQuestions(locale, term)
      assert.ok(matches.some(question => question.id === 'apple-login'), `Missing ${locale} question for ${term}`)
      assert.equal(matches.find(question => question.id === 'apple-login')?.action, 'support')
    }
  }
  const answer = searchHomeQuestions('zh-CN', 'Apple')[0].answer
  assert.match(answer, /ChatGPT/)
  assert.match(answer, /购买前.*联系客服.*确认/)
  assert.match(answer, /不保证.*所有账号/)
})

test('feedback separates activation confirmation from an unpurchased referral and keeps reward context', () => {
  const feedback = homeFeedbackCopy('zh-CN')
  assert.equal(feedback.items.length, 2)
  const completed = feedback.items.find(item => item.id === 'subscription-confirmed')!
  const referral = feedback.items.find(item => item.id === 'consultation-referral')!
  assert.equal(completed.quote, '可以了可以了')
  assert.match(referral.description, /尚未购买/)
  assert.match(referral.context, /朋友下单.*返现.*5 元/)
  assert.equal(completed.image, '/feedback/subscription-confirmed.png')
  assert.equal(referral.image, '/feedback/consultation-referral.png')
  assert.ok(feedback.items.every(item => !/星|好评率|400|退款成功|秒到/.test([item.title, item.description, item.context].join(' '))))
})

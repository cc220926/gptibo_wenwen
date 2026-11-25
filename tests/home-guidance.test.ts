import test from 'node:test'
import assert from 'node:assert/strict'
import { homeGuideCopy, homeHelpCopy, homeFeedbackCopy, searchHomeQuestions } from '../src/lib/home-guidance.ts'
import { credentialExpiryProblem } from '../shared/credential-expiry.ts'
import { failureMessages } from '../worker/recharge/errors.ts'

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
  assert.equal(searchHomeQuestions('zh-CN', ' \n\t ').length, 10)
})

test('both locales cover the same questions and feedback with stable destinations', () => {
  const zh = searchHomeQuestions('zh-CN')
  const en = searchHomeQuestions('en')
  assert.deepEqual(en.map(q => [q.id, q.action]), zh.map(q => [q.id, q.action]))
  assert.equal(new Set(zh.map(q => q.id)).size, zh.length)
  assert.deepEqual(homeFeedbackCopy('en').items.map(item => [item.id, item.image]), homeFeedbackCopy('zh-CN').items.map(item => [item.id, item.image]))
  assert.match(homeFeedbackCopy('en').languageNote, /Chinese/)
  const feedback = homeFeedbackCopy('zh-CN')
  assert.equal(new Set(feedback.items.map(item => item.id)).size, feedback.items.length)
  assert.equal(new Set(feedback.items.map(item => item.image)).size, feedback.items.length)
  assert.deepEqual(homeFeedbackCopy('en').items.map(item => item.quote), feedback.items.map(item => item.quote))
  assert.match(feedback.galleryIntro(feedback.items.length), /共 7 段/)
  assert.match(feedback.galleryIntro(3), /共 3 段/)
  assert.match(homeFeedbackCopy('en').items[0].description, /interest in recommending/)
  assert.doesNotMatch(homeFeedbackCopy('en').items[0].context, /redacted/)
  assert.match(homeFeedbackCopy('en').items[1].description, /asked about renewing/)
  assert.match(homeFeedbackCopy('en').items[1].context, /renewal inquiry/)
  assert.match(homeFeedbackCopy('en').items[1].context, /amount is redacted/)
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

test('feedback preserves service praise and renewal inquiry without implying completed referral or renewal orders', () => {
  const feedback = homeFeedbackCopy('zh-CN')
  assert.equal(feedback.items.length, 7)
  const service = feedback.items.find(item => item.id === 'service-feedback')!
  const renewal = feedback.items.find(item => item.id === 'renewal-inquiry')!
  assert.equal(service.quote, '你这个服务太棒了。')
  assert.equal(renewal.quote, '哈喽我想续费一下！')
  assert.match(service.description, /讲解操作.*认可服务.*推荐意向/)
  assert.doesNotMatch(service.context, /遮挡/)
  assert.match(renewal.description, /再次联系.*询问续费/)
  assert.match(renewal.context, /续费咨询/)
  assert.match(renewal.context, /转账金额已遮挡/)
  assert.equal(service.image, '/feedback/service-feedback.png')
  assert.equal(renewal.image, '/feedback/renewal-inquiry.png')
  assert.ok(feedback.items.every(item => !/星|好评率|400|退款成功|秒到|已带来|已成交|续费成功|多次复购/.test([item.title, item.description, item.context].join(' '))))
})


test('service records distinguish reported refunds, referrals, questions and customer-confirmed outcomes', () => {
  const items = homeFeedbackCopy('zh-CN').items
  const item = (id: string) => {
    const found = items.find(entry => entry.id === id)
    assert.ok(found, `Missing conversation ${id}`)
    return found
  }
  const refund = item('refund-conversation')
  assert.equal(refund.quote, '好')
  assert.match(refund.description, /客服.*随后告知已退/)
  assert.match(refund.context, /未展示用户确认到账/)
  const referral = item('friend-referral')
  assert.equal(referral.quote, '我今天又给你介绍了一个')
  assert.match(referral.context, /转介绍返现.*未展示朋友成交/)
  assert.match(item('activation-followup').description, /沟通处理/)
  assert.doesNotMatch(item('activation-followup').description, /多次|重试|several attempts/i)
  assert.equal(item('activation-followup').quote, '可以了，可以了，谢谢')
  assert.match(item('early-renewal').context, /未展示续费完成/)
  assert.equal(item('early-renewal').quote, '是等中午到期后我再重试吗')
  assert.equal(item('recharge-confirmed').quote, '没事了刚充好')
  assert.match(item('recharge-confirmed').description, /用户确认.*后续.*Session/)
  assert.match(item('recharge-confirmed').context, /客服在用户确认完成后/)
  assert.ok(items.every(entry => !/自动退款|保证到账|客服修复成功|多次复购/.test([entry.description, entry.context].join(' '))))
  assert.deepEqual(items.filter(entry => /转账金额已遮挡/.test(entry.context)).map(entry => entry.id), ['renewal-inquiry'])
})


test('Session recovery help matches real expiry messages and keywords in both locales', () => {
  const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`
  const expiryMessages = [
    credentialExpiryProblem(expiredToken, undefined, 2000),
    credentialExpiryProblem('opaque-token', '1970-01-01T00:00:01.000Z', 2000),
  ]
  assert.ok(expiryMessages.every(Boolean), 'Exercise both production expiry messages')
  const queries = [
    'Session 已失效', failureMessages.session_invalid, ...expiryMessages,
    'Session已过期或无权访问，请重新获取完整Session后重试。',
    'Session expired or access denied. Get the complete Session and try again.',
    '失效', '有效期', '过期', '无权访问', 'Session expired', 'Access Token expired', 'unauthorized', 'access denied',
  ]
  const misses: { locale: string; query: string }[] = []
  for (const locale of ['zh-CN', 'en'] as const) {
    for (const query of queries) {
      const match = searchHomeQuestions(locale, query).find(question => question.id === 'session-expired')
      if (!match) misses.push({ locale, query })
      else assert.equal(match.action, 'orders', 'Retry stays in the original order flow')
    }
  }
  assert.deepEqual(misses, [], 'Real error text should find the Session recovery instructions')
})

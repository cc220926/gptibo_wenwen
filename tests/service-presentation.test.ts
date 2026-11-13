import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isGptAccountOffer, isMuseOffer, museQuota, serviceProductRoute } from '../shared/service-presentation.ts'

test('Muse alias resolves only self-owned Muse offers, preserving other product routes', () => {
  const offer = { id: 'custom-aaa', product_id: 'custom-bbb', product_name: 'MuseAI', name: 'Muse 10 亿 精品号' }
  assert.equal(isMuseOffer(offer), true)
  assert.equal(serviceProductRoute(offer), 'product/muse')
  assert.equal(serviceProductRoute({ ...offer, product_name: '软件服务', name: '单次使用' }), 'product/custom-bbb')
  assert.equal(isMuseOffer({ ...offer, id: 'plus' }), false)
  assert.equal(isMuseOffer({ ...offer, product_name: 'Amusement', name: '普通商品' }), false)
})

test('quota comes from the selected plan instead of assuming an account balance', () => {
  assert.equal(museQuota('Muse 10 亿 精品号'), '10 亿 Token')
  assert.equal(museQuota('Muse 310亿 精品号'), '310 亿 Token')
  assert.equal(museQuota('Muse 账号'), '以所选规格说明为准')
})

test('ChatGPT finished accounts have a separate route without reclassifying recharge or other services', () => {
  const account = { id: 'custom-aaa', product_id: 'custom-bbb', product_name: 'ChatGPT Plus 成品号', name: '人工交付' }
  assert.equal(isGptAccountOffer(account), true)
  assert.equal(serviceProductRoute(account), 'product/gpt-plus')
  assert.equal(isGptAccountOffer({ ...account, product_name: 'ChatGPT Plus 成品账号' }), true)
  assert.equal(isGptAccountOffer({ ...account, product_name: 'ChatGPT Plus 自有账号充值' }), false)
  assert.equal(isGptAccountOffer({ ...account, product_name: 'Muse 成品号' }), false)
  assert.equal(isGptAccountOffer({ ...account, id: 'plus' }), false)
  assert.equal(serviceProductRoute({ ...account, product_name: '普通软件' }), 'product/custom-bbb')
})

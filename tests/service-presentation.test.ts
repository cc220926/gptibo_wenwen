import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMuseOffer, museQuota, serviceProductRoute } from '../shared/service-presentation.ts'

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

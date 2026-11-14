import test from 'node:test'
import assert from 'node:assert/strict'
import { mapayPaymentEntry } from '../shared/mapay-payment-entry.ts'

test('only actual Alipay payment payloads become QR codes; cashier pages remain navigation', () => {
  const qr = 'https://qr.alipay.com/fkx12345678'
  const cashier = 'https://mzf.mapay.cn/pay/20261114102743348764'
  const legacy = 'https://mzf.mapay.cn/xpay/epay/submit.php?pid=10101&sign=fixture'
  assert.deepEqual(mapayPaymentEntry(qr), { kind: 'qr', url: qr })
  for (const url of [cashier, legacy]) assert.deepEqual(mapayPaymentEntry(url), { kind: 'redirect', url })
})

test('unsafe or ambiguous Mapay destinations never become payable UI', () => {
  for (const value of [null, '', 'javascript:alert(1)', 'https://mzf.mapay.cn.evil.test/pay/123',
    'https://user@mzf.mapay.cn/pay/123', 'http://mzf.mapay.cn/pay/123',
    'https://mzf.mapay.cn/pay/123?key=secret', 'https://mzf.mapay.cn/pay/123#private',
    'https://mzf.mapay.cn/admin', 'https://mzf.mapay.cn/xpay/epay/submit.php',
    'https://qr.alipay.com/fkx12345678?redirect=private', ' https://qr.alipay.com/fkx12345678']) assert.equal(mapayPaymentEntry(value), null)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { customerFixture } from './customer-fixture.ts'
import worker from '../worker/index.ts'

for (const failingQuery of [
  'SELECT r.* FROM refund_cases r JOIN recharge_refunds',
  'SELECT o.id FROM orders o JOIN recharge_orders',
]) {
  test('refund reconciliation failure does not skip payment polling: ' + failingQuery, async t => {
    const fixture = await customerFixture()
    t.after(() => fixture.db.close())
    t.mock.method(console, 'error', () => {})
    const originalPrepare = fixture.env.INTEREST_DB.prepare.bind(fixture.env.INTEREST_DB)
    let paymentPollingStarted = false
    fixture.env.INTEREST_DB.prepare = sql => {
      if (sql.includes(failingQuery)) throw new Error('simulated refund queue failure')
      if (sql.includes("SELECT * FROM payments WHERE state='pending'")) paymentPollingStarted = true
      return originalPrepare(sql)
    }
    await worker.scheduled({ scheduledTime: 0 }, fixture.env)
    assert.equal(paymentPollingStarted, true)
  })
}

test('payment polling failure does not skip recharge polling or later fulfillment queues', async t => {
  const fixture = await customerFixture()
  t.after(() => fixture.db.close())
  t.mock.method(console, 'error', () => {})
  const originalPrepare = fixture.env.INTEREST_DB.prepare.bind(fixture.env.INTEREST_DB)
  let rechargePollingStarted = false
  let gmailQueueStarted = false
  fixture.env.INTEREST_DB.prepare = sql => {
    if (sql.includes("SELECT * FROM payments WHERE state='pending'")) throw new Error('simulated payment queue failure')
    if (sql.includes('SELECT t.* FROM recharge_orders t JOIN orders o')) rechargePollingStarted = true
    if (sql.includes('SELECT k.order_id FROM account_supplier_orders')) gmailQueueStarted = true
    return originalPrepare(sql)
  }
  await worker.scheduled({ scheduledTime: 0 }, fixture.env)
  assert.equal(rechargePollingStarted, true)
  assert.equal(gmailQueueStarted, true)
})

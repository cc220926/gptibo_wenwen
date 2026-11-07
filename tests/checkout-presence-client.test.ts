import assert from 'node:assert/strict'
import test from 'node:test'
import { checkoutPresence, validPresence } from '../src/lib/checkout-presence.ts'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
class Page extends EventTarget {
  hidden = false
  focused = true
  hasFocus() { return this.focused }
}
function fixture(checkout = false) {
  const page = new Page(), win = new EventTarget()
  const calls: Array<{ tabId: string; active: boolean } | undefined> = []
  const values: Array<number | null> = []
  let clock = 1_000, nextId = 0
  const options = {
    enabled: true, checkout, page, win,
    now: () => clock,
    newId: () => 'activity-' + ++nextId,
    interaction: () => true,
    publish: (n: number | null) => { values.push(n) },
    request: async (activity?: { tabId: string; active: boolean }) => { calls.push(activity); return { others: 2, windowSeconds: 60 } },
  }
  return { page, win, calls, values, options, advance: (ms: number) => { clock += ms } }
}

test('browsing only reads; opening checkout counts activity, idle expires, fresh interaction uses a new ID', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(), session = checkoutPresence(f.options)
  t.after(session.stop)
  await flush()
  assert.deepEqual(f.calls, [undefined])
  assert.equal(f.values.at(-1), 2)
  session.setCheckout(true); await flush()
  const firstId = f.calls.at(-1)!.tabId
  assert.equal(f.calls.at(-1)!.active, true)
  f.advance(30_000); t.mock.timers.tick(30_000); await flush()
  assert.deepEqual(f.calls.at(-1), { tabId: firstId, active: true })
  f.advance(30_000); t.mock.timers.tick(30_000); await flush()
  assert.ok(f.calls.some(c => c?.tabId === firstId && !c.active))
  assert.equal(f.calls.at(-1), undefined)
  f.page.dispatchEvent(new Event('keydown')); await flush()
  assert.equal(f.calls.at(-1)!.active, true)
  assert.notEqual(f.calls.at(-1)!.tabId, firstId)
  const secondId = f.calls.at(-1)!.tabId
  session.setCheckout(false); await flush()
  assert.ok(f.calls.some(c => c?.tabId === secondId && !c.active))
  assert.equal(f.calls.at(-1), undefined)
})

test('blur and hidden tabs stop activity and clear display; BFCache return can resume', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(true), session = checkoutPresence(f.options)
  t.after(session.stop)
  await flush()
  const firstId = f.calls[0]!.tabId
  f.win.dispatchEvent(new Event('blur')); await flush()
  assert.deepEqual(f.calls.at(-1), { tabId: firstId, active: false })
  assert.equal(f.values.at(-1), null)
  const before = f.calls.length
  f.advance(30_000); t.mock.timers.tick(30_000); await flush()
  assert.equal(f.calls.length, before)
  f.win.dispatchEvent(new Event('focus')); await flush()
  assert.equal(f.calls.at(-1)!.active, true)
  assert.notEqual(f.calls.at(-1)!.tabId, firstId)
  f.win.dispatchEvent(new Event('pagehide')); await flush()
  assert.equal(f.values.at(-1), null)
  f.win.dispatchEvent(new Event('pageshow')); await flush()
  assert.equal(f.values.at(-1), 2)
  f.page.hidden = true
  f.page.dispatchEvent(new Event('visibilitychange')); await flush()
  assert.equal(f.calls.at(-1)!.active, false)
  assert.equal(f.values.at(-1), null)
})

test('disabled telemetry makes no requests, even when checkout or focus changes', async () => {
  const f = fixture(true)
  const session = checkoutPresence({ ...f.options, enabled: false })
  session.setCheckout(true)
  f.page.dispatchEvent(new Event('pointerdown'))
  f.win.dispatchEvent(new Event('focus'))
  await flush(); session.stop()
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.values, [null])
})

test('an initially hidden checkout stays idle on focus until a fresh checkout interaction', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(true)
  f.page.hidden = true
  const session = checkoutPresence(f.options)
  t.after(session.stop)
  assert.equal(f.calls.length, 0)
  f.advance(61_000); t.mock.timers.tick(61_000); await flush()
  f.page.hidden = false
  f.page.dispatchEvent(new Event('visibilitychange')); await flush()
  assert.deepEqual(f.calls, [undefined])
  f.win.dispatchEvent(new Event('focus')); await flush()
  assert.ok(f.calls.every(c => c === undefined))
  f.page.dispatchEvent(new Event('pointerdown')); await flush()
  assert.equal(f.calls.at(-1)!.active, true)
})

test('zero counts are displayed while failures and expired data hide the indicator', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  let requests = 0, finish!: (value: unknown) => void
  const session = checkoutPresence({ ...f.options, request: async () => {
    requests++
    if (requests === 1) return { others: 4, windowSeconds: 60 }
    if (requests === 2) return new Promise(resolve => { finish = resolve })
    if (requests === 3) throw Error('network unavailable')
    return { others: 0, windowSeconds: 60 }
  } })
  t.after(session.stop)
  await flush()
  assert.equal(f.values.at(-1), 4)
  f.advance(30_000); t.mock.timers.tick(30_000); await flush()
  f.advance(60_000); t.mock.timers.tick(60_000); await flush()
  assert.equal(requests, 2)
  assert.equal(f.values.at(-1), null)
  finish({ others: 9, windowSeconds: 60 }); await flush()
  assert.equal(f.values.at(-1), null)
  f.advance(30_000); t.mock.timers.tick(30_000); await flush()
  assert.equal(f.values.at(-1), null)
  f.advance(30_000); t.mock.timers.tick(30_000); await flush()
  assert.equal(f.values.at(-1), 0)
})

test('late active responses cannot restore display after checkout is closed or page stopped', async () => {
  const f = fixture(true)
  let finish!: (value: unknown) => void
  const session = checkoutPresence({ ...f.options, request: async activity => {
    f.calls.push(activity)
    if (activity?.active) return new Promise(resolve => { finish = resolve })
    return { others: 0, windowSeconds: 60 }
  } })
  const tabId = f.calls[0]!.tabId
  session.setCheckout(false)
  assert.deepEqual(f.calls[1], { tabId, active: false })
  session.stop()
  finish({ others: 50, windowSeconds: 60 }); await flush()
  assert.equal(f.values.at(-1), null)
  assert.equal(f.calls.length, 2)
})

test('malformed or invented response values are never accepted as a visitor count', () => {
  for (const value of [null, {}, { others: -1, windowSeconds: 60 }, { others: 1.5, windowSeconds: 60 }, { others: '9', windowSeconds: 60 }, { others: 1, windowSeconds: 300 }]) {
    assert.equal(validPresence(value), false)
  }
  assert.equal(validPresence({ others: 0, windowSeconds: 60 }), true)
})

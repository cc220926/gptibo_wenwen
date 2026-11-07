import assert from 'node:assert/strict'
import test from 'node:test'
import { customerHistoryFeed, readCustomerHistoryPage, type CustomerHistoryView } from '../src/lib/customer-history.ts'

const mask = (n: number) => `buyer${n}***@example.invalid`
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('browser rejects malformed or unmasked history responses without displaying them', () => {
  const valid = { emails: [mask(1), mask(2)], nextCursor: null }
  assert.deepEqual(readCustomerHistoryPage(valid, 0), valid)
  for (const page of [
    { emails: ['real@example.invalid'], nextCursor: null },
    { emails: [mask(1), mask(1)], nextCursor: null },
    { emails: [mask(1)], nextCursor: 0 },
    { emails: [], nextCursor: 1 },
    { emails: Array.from({ length: 61 }, (_, i) => mask(i)), nextCursor: null },
  ]) assert.equal(readCustomerHistoryPage(page, 0), null)
})

test('feed pages through all available display entries, then loops from the first page', async () => {
  const calls: number[] = []
  let view: CustomerHistoryView | null = null
  const feed = customerHistoryFeed({
    request: async cursor => {
      calls.push(cursor)
      if (cursor === 0) return { emails: Array.from({ length: 60 }, (_, i) => mask(i)), nextCursor: 60 }
      if (cursor === 60) return { emails: [mask(60), mask(61)], nextCursor: null }
      throw new Error('unexpected cursor')
    },
    publish: value => { view = value },
  })
  await tick()
  assert.deepEqual(view?.emails, [mask(0), mask(1), mask(2), mask(3)])
  for (let i = 0; i < 60; i++) { feed.advance(); await tick() }
  assert.deepEqual(view?.emails.slice(0, 3), [mask(60), mask(61), mask(0)])
  assert.deepEqual(calls.slice(0, 2), [0, 60])
  feed.stop()
})

test('late responses after unmount and invalid later pages never expose stale entries', async () => {
  let finish!: (value: unknown) => void
  const views: Array<CustomerHistoryView | null> = []
  const stopped = customerHistoryFeed({
    request: () => new Promise(resolve => { finish = resolve }),
    publish: value => views.push(value),
  })
  stopped.stop()
  finish({ emails: [mask(1)], nextCursor: null })
  await tick()
  assert.deepEqual(views, [])

  let current: CustomerHistoryView | null = null
  const failed = customerHistoryFeed({
    request: async cursor => cursor === 0
      ? { emails: Array.from({ length: 60 }, (_, i) => mask(i)), nextCursor: 60 }
      : { emails: ['real@example.invalid'], nextCursor: null },
    publish: value => { current = value },
  })
  await tick()
  for (let i = 0; i < 52; i++) failed.advance()
  await tick()
  assert.equal(current, null)
  failed.stop()
})

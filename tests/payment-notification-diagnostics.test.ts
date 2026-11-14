import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { paymentNotification } from '../worker/payments/service.ts'
import { signZpayParams } from '../worker/payments/zpay-protocol.ts'
import type { Env, Statement, Value } from '../worker/platform.ts'

type Context = Parameters<Parameters<typeof test>[1]>[0]
const id = 'YMX-' + 'D'.repeat(32)
const privateText = 'PRIVATE-notification-key-body-url-buyer@example.invalid'
const credentials = { pid: '10101', key: privateText }
type Diagnostic = { event: string; provider: string; outcome: string; stage: string; reason?: string }

function notice(patch: Record<string, string> = {}) {
  const params = new URLSearchParams({ pid: credentials.pid, type: 'alipay', out_trade_no: id.slice(4), trade_no: 'fixture-trade', money: '0.01', trade_status: 'TRADE_SUCCESS', sign_type: 'MD5', name: privateText, ...patch })
  params.set('sign', signZpayParams(params, credentials.key))
  return new Request('https://shop.example.invalid/api/payments/notify/mapay?' + params)
}

function setup(t: Context) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  const dir = new URL('../migrations/', import.meta.url)
  for (const file of readdirSync(dir).filter(file => file.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'))
  const now = Date.now()
  db.prepare("INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,payment_status,status,created_at,updated_at,last_event_id,is_test,customer_email) VALUES(?,?,?,'plus','Fixture',1,'live','unpaid','pending',?,?,?,1,?)")
    .run(id, 'fixture-owner', 'fixture-key', now, now, 'fixture-event', privateText)
  db.prepare("INSERT INTO payments(order_id,provider,account,amount_cents,expires_at,created_at,updated_at) VALUES(?,'mapay',?,1,?,?,?)")
    .run(id, credentials.pid, now + 300000, now, now)
  const state = { gatewayStatus: 1, gatewayError: false, fault: '' }
  const bound = new WeakMap<Statement, { sql: string; values: Value[] }>()
  const env = { MAPAY_PID: credentials.pid, MAPAY_KEY: credentials.key, INTEREST_DB: {
    prepare(sql: string) {
      const value = { sql, values: [] as Value[] }
      const statement: Statement = {
        bind(...values) { value.values = values; return this },
        async first<T>() { return (db.prepare(sql).get(...value.values) ?? null) as T | null },
        async all<T>() { return { results: db.prepare(sql).all(...value.values) as T[] } },
        async run() {
          if (state.fault === 'receipt' && sql.startsWith('UPDATE payments SET notified_at=')) throw new Error(privateText)
          return db.prepare(sql).run(...value.values)
        },
      }; bound.set(statement, value); return statement
    },
    async batch(statements: Statement[]) {
      if (state.fault === 'apply') throw new Error(privateText)
      db.exec('BEGIN')
      try { const result = statements.map(statement => { const value = bound.get(statement)!; return db.prepare(value.sql).run(...value.values) }); db.exec('COMMIT'); return result }
      catch (error) { db.exec('ROLLBACK'); throw error }
    },
  } } as Env
  t.mock.method(globalThis, 'fetch', async () => {
    if (state.gatewayError) throw new Error(privateText)
    return Response.json({ code: 1, pid: Number(credentials.pid), type: 'alipay', out_trade_no: id.slice(4), money: '0.01', status: state.gatewayStatus, trade_no: 'fixture-trade', untrusted: privateText })
  })
  const logs: Diagnostic[] = []
  const capture = (...args: unknown[]) => { assert.equal(args.length, 1); logs.push(JSON.parse(String(args[0]))) }
  t.mock.method(console, 'info', capture); t.mock.method(console, 'warn', capture)
  const paid = () => db.prepare('SELECT state,notified_at FROM payments WHERE order_id=?').get(id)!
  return { db, env, state, logs, paid }
}

function expected(outcome: string, stage: string, reason?: string, provider = 'mapay'): Diagnostic {
  return { event: 'payment-notification', provider, outcome, stage, ...(reason ? { reason } : {}) }
}
function assertPrivate(logs: Diagnostic[], request?: Request) {
  const output = JSON.stringify(logs)
  for (const value of [privateText, credentials.pid, id, 'fixture-trade', request?.url, request && new URL(request.url).searchParams.get('sign')].filter(Boolean)) assert.equal(output.includes(value!), false)
}

test('callback diagnostics separate arrival and provider rejection without logging an untrusted provider', async t => {
  const s = setup(t), request = notice()
  const response = await paymentNotification(request, s.env, privateText)
  assert.equal(response.status, 400); assert.equal(await response.text(), 'failure')
  assert.deepEqual(s.logs, [expected('received', 'provider', undefined, 'unknown'), expected('rejected', 'provider', 'provider_unavailable', 'unknown')])
  assertPrivate(s.logs, request); assert.equal(s.paid().state, 'pending')
})

test('invalid signatures, gateway uncertainty and query failures remain rejected with safe verification reasons', async t => {
  const s = setup(t)
  for (const kind of ['signature', 'pending', 'unavailable']) {
    s.logs.length = 0; s.state.gatewayStatus = kind === 'pending' ? 0 : 1; s.state.gatewayError = kind === 'unavailable'
    let request = notice()
    if (kind === 'signature') { const url = new URL(request.url); url.searchParams.set('money', '99.00'); request = new Request(url) }
    const response = await paymentNotification(request, s.env, 'mapay')
    assert.equal(response.status, 400); assert.equal(await response.text(), 'failure')
    const reason = kind === 'signature' ? 'invalid_signature' : kind === 'pending' ? 'gateway_not_confirmed' : 'gateway_unavailable'
    assert.deepEqual(s.logs, [expected('received', 'provider'), expected('rejected', 'verification', reason)])
    assertPrivate(s.logs, request); assert.equal(s.paid().state, 'pending'); assert.equal(s.paid().notified_at, null)
  }
})

test('verified callbacks distinguish local lookup failures from payment application failures', async t => {
  const s = setup(t), request = notice()
  s.db.prepare("UPDATE payments SET account='different-account' WHERE order_id=?").run(id)
  assert.equal((await paymentNotification(request, s.env, 'mapay')).status, 400)
  assert.deepEqual(s.logs, [expected('received', 'provider'), expected('rejected', 'lookup', 'payment_not_matched')])
  s.logs.length = 0; s.db.prepare('UPDATE payments SET account=? WHERE order_id=?').run(credentials.pid, id); s.state.fault = 'apply'
  const response = await paymentNotification(request, s.env, 'mapay')
  assert.equal(response.status, 400); assert.equal(await response.text(), 'failure')
  assert.deepEqual(s.logs, [expected('received', 'provider'), expected('rejected', 'apply', 'internal')])
  assertPrivate(s.logs, request); assert.equal(s.paid().state, 'pending')
})

test('receipt-stage failure retries without double booking and success diagnostics omit payment details', async t => {
  const s = setup(t), request = notice(); s.state.fault = 'receipt'
  assert.equal((await paymentNotification(request, s.env, 'mapay')).status, 400)
  assert.deepEqual(s.logs, [expected('received', 'provider'), expected('rejected', 'receipt', 'internal')])
  assert.equal(s.paid().state, 'paid'); assert.equal(s.paid().notified_at, null)
  s.state.fault = ''; s.logs.length = 0
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = await paymentNotification(request, s.env, 'mapay')
    assert.equal(response.status, 200); assert.equal(await response.text(), 'success')
  }
  assert.deepEqual(s.logs, [expected('received', 'provider'), expected('applied', 'receipt'), expected('received', 'provider'), expected('applied', 'receipt')])
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM order_events WHERE action='payment-confirmed'").get()!.n, 1)
  assert.equal(s.paid().state, 'paid'); assert.equal(typeof s.paid().notified_at, 'number'); assertPrivate(s.logs, request)
})

test('diagnostic sink failure cannot change payment acknowledgement or booking', async t => {
  const s = setup(t)
  t.mock.method(console, 'info', () => { throw new Error(privateText) })
  t.mock.method(console, 'warn', () => { throw new Error(privateText) })
  const response = await paymentNotification(notice(), s.env, 'mapay')
  assert.equal(response.status, 200); assert.equal(await response.text(), 'success'); assert.equal(s.paid().state, 'paid')
})

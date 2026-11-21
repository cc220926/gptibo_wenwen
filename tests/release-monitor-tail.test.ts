import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWranglerTailArgs, classifyCliDiagnostic, createJsonObjectStream, monitorChildEnvironment, parseMonitorArgs, sanitizeTailRecord } from '../scripts/release/monitor-tail.mjs'

test('release tail keeps payment diagnoses and drops every private request/log field', () => {
  const secret = 'buyer@example.test-PRIVATE-token'
  const input = {
    eventTimestamp: 1795260000000, outcome: 'ok', cpuTime: 7, wallTime: 12,
    scriptVersion: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tag: secret },
    event: { request: { method: 'POST', url: `https://shop.example.test/api/payments/notify/mapay?sign=${secret}`, headers: { cookie: secret }, body: secret, cf: { ip: secret } }, response: { status: 400, body: secret } },
    logs: [{ message: [secret, JSON.stringify({ event: 'payment-notification', provider: 'mapay', outcome: 'rejected', stage: 'verification', reason: 'invalid_signature', body: secret })] }],
    exceptions: [{ name: 'TypeError', message: secret, stack: secret }, { name: secret, message: secret }],
  }
  const safe = sanitizeTailRecord(input)
  assert.equal(safe.route, '/api/payments/notify/mapay'); assert.equal(safe.status, 400)
  assert.equal(safe.cpuTime, 7); assert.equal(safe.wallTime, 12)
  assert.equal(safe.scriptVersion, input.scriptVersion.id)
  assert.deepEqual(safe.exceptionNames, { TypeError: 1, other: 1 })
  assert.deepEqual(safe.paymentNotifications, [{ provider: 'mapay', outcome: 'rejected', stage: 'verification', reason: 'invalid_signature' }])
  assert.ok(!JSON.stringify(safe).includes(secret)); assert.ok(!JSON.stringify(safe).includes('sign='))
})

test('release tail masks order IDs and arbitrary routes and preserves failed queue names on successful cron', () => {
  for (const suffix of ['', '/payment', '/fulfillment']) {
    const safe = sanitizeTailRecord({ event: { request: { url: 'https://shop.example.test/api/orders/private-order' + suffix + '?email=private', method: 'GET' } } })
    assert.equal(safe.route, '/api/orders/:id' + suffix)
  }
  const safe = sanitizeTailRecord({ outcome: 'ok', event: { cron: '* * * * *', scheduledTime: 1795260000000 }, logs: [{ message: ['Recharge reconciliation queue temporarily unavailable', 'PRIVATE queue temporarily unavailable'] }], exceptions: [] })
  assert.equal(safe.kind, 'scheduled'); assert.equal(safe.cron, '* * * * *')
  assert.deepEqual(safe.queueFailures, ['Recharge reconciliation queue'])
  assert.equal(safe.outcome, 'ok'); assert.equal(safe.scheduledTime, 1795260000000)
  const unknown = sanitizeTailRecord({ scriptVersion: 'secret', cpuTime: 'secret', event: { cron: 'secret', request: { url: 'https://shop.example.test/api/admin/private@example.test' } } })
  assert.equal(unknown.route, '/api/other'); assert.equal(unknown.scriptVersion, null); assert.equal(unknown.cron, null); assert.equal(unknown.cpuTime, null)
})

test('release tail parser handles split chunks, escaped braces, multiple objects and non-JSON CLI prose', () => {
  const seen: unknown[] = [], diagnostics: string[] = []
  const parser = createJsonObjectStream((value: unknown) => seen.push(value), (value: string) => diagnostics.push(value))
  const first = { message: 'brace { and quote " and slash \\', nested: { data: ['}'] } }, second = { event: 'second' }
  const text = 'CLI warning PRIVATE\n' + JSON.stringify(first, null, 4) + '\n' + JSON.stringify(second) + '\n'
  for (let i = 0; i < text.length; i += 3) parser.write(text.slice(i, i + 3))
  parser.end()
  assert.deepEqual(seen, [first, second]); assert.deepEqual(diagnostics, [])
})

test('release tail parser bounds oversized input and emits diagnostics without private content', () => {
  const seen: unknown[] = [], diagnostics: string[] = []
  const parser = createJsonObjectStream((value: unknown) => seen.push(value), (value: string) => diagnostics.push(value), 40)
  parser.write(JSON.stringify({ message: 'PRIVATE'.repeat(30) }) + '\n{"ok":true}\n{bad}\n{"partial":"PRIVATE')
  parser.end()
  assert.deepEqual(seen, [{ ok: true }]); assert.deepEqual(diagnostics, ['object-too-large', 'invalid-json', 'incomplete-json'])
  assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE'))
})

test('release tail CLI only permits the expected Worker and disables Wrangler disk logs', () => {
  assert.equal(parseMonitorArgs(['--config', './wrangler.production.jsonc', '--name', 'gptpay1688-store']).name, 'gptpay1688-store')
  for (const args of [['--config', 'x', '--name', 'different'], ['--config', 'x', '--config', 'y'], ['--config', 'x']]) assert.throws(() => parseMonitorArgs(args))
  const env = monitorChildEnvironment({ WRANGLER_WRITE_LOGS: 'true', WRANGLER_LOG_SANITIZE: 'false' })
  assert.equal(env.WRANGLER_WRITE_LOGS, 'false'); assert.equal(env.WRANGLER_LOG_SANITIZE, 'true'); assert.equal(env.WRANGLER_SEND_METRICS, 'false')
})

test('release tail invokes Wrangler without the invalid full-rate sampling filter', () => {
  const options = parseMonitorArgs(['--config', './wrangler.production.jsonc', '--name', 'gptpay1688-store'])
  const args = buildWranglerTailArgs('/local/wrangler.js', options)
  assert.deepEqual(args, ['/local/wrangler.js', 'tail', 'gptpay1688-store', '--config', options.config, '--format', 'json'])
  assert.ok(!args.includes('--sampling-rate'))
  assert.throws(() => buildWranglerTailArgs('/local/wrangler.js', { ...options, name: 'different' }))
})

test('release tail CLI diagnostics provide fixed failure classes without exposing raw details', () => {
  const examples = [
    ['A sampling rate must be between 0 and 1', 'invalid-sampling-rate'],
    ['Proxy environment variables detected.', 'proxy-detected'],
    ['Authentication error', 'authentication-error'],
    ['fetch failed ECONNREFUSED', 'network-error'],
    ['Tail connection lost.', 'tail-disconnected'],
    ['unknown argument', 'configuration-error'],
    ['Permission denied', 'permission-denied'],
  ]
  for (const [raw, expected] of examples) {
    const result = classifyCliDiagnostic(raw + ' buyer@example.test token=PRIVATE')
    assert.equal(result, expected)
    assert.ok(!result.includes('PRIVATE'))
  }
})

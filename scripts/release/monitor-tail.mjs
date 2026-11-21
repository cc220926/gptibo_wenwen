import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { sanitizeTailEvent } from './monitor-queries.mjs'

const exceptionNames = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AbortError', 'TimeoutError'])
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const finiteTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

// Additional metadata is strictly typed/allowlisted. Never echo unknown event
// properties, arbitrary exception messages, request URLs or log text.
export function sanitizeTailRecord(input) {
  const record = input && typeof input === 'object' ? input : {}
  const safe = sanitizeTailEvent(record)
  const cron = record.event?.cron
  safe.cron = typeof cron === 'string' && cron.length <= 64 && /^[0-9*,/\-\s]+$/.test(cron) ? cron : null
  safe.scheduledTime = finiteTime(record.event?.scheduledTime)
  if (safe.cron !== null) safe.kind = 'scheduled'
  safe.cpuTime = finiteTime(record.cpuTime)
  safe.wallTime = finiteTime(record.wallTime)
  const version = record.scriptVersion?.id ?? record.scriptVersion
  safe.scriptVersion = typeof version === 'string' && uuid.test(version) ? version : null
  safe.exceptionNames = {}
  for (const error of Array.isArray(record.exceptions) ? record.exceptions : []) {
    const name = exceptionNames.has(error?.name) ? error.name : 'other'
    safe.exceptionNames[name] = (safe.exceptionNames[name] ?? 0) + 1
  }
  return safe
}

// Wrangler prints complete pretty JSON objects separated by lines. Ignore all
// other CLI prose. Bound memory and retain no raw input in any diagnostic.
export function createJsonObjectStream(onObject, onDiagnostic = () => {}, maxBytes = 2_000_000) {
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0)
  let raw = '', depth = 0, inString = false, escaped = false, lineStart = true, discarding = false, bytes = 0
  const reset = () => { raw = ''; depth = 0; inString = false; escaped = false; discarding = false; bytes = 0 }
  function write(chunk) {
    for (const char of String(chunk)) {
      if (!depth) {
        if (lineStart && char === '{') { raw = '{'; depth = 1; bytes = 1 }
        lineStart = char === '\n' || lineStart && /[ \t\r]/.test(char)
        continue
      }
      bytes += Buffer.byteLength(char)
      if (!discarding && bytes > maxBytes) { raw = ''; discarding = true; onDiagnostic('object-too-large') }
      if (!discarding) raw += char
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === '{' || char === '[') depth++
      else if (char === '}' || char === ']') depth--
      if (!depth) {
        if (!discarding) {
          let parsed
          try { parsed = JSON.parse(raw) } catch { onDiagnostic('invalid-json') }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) onObject(parsed)
        }
        reset(); lineStart = false
      }
    }
  }
  return { write, end() { if (depth) onDiagnostic('incomplete-json'); reset() } }
}

export function parseMonitorArgs(args) {
  assert.equal(args.length, 4, 'Usage: monitor-tail.mjs --config <file> --name gptpay1688-store')
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--config', '--name'].includes(args[i]) && !options[args[i]])
    options[args[i]] = args[i + 1]
  }
  assert.equal(options['--name'], 'gptpay1688-store', 'Unexpected production Worker')
  assert.ok(options['--config'])
  return { config: path.resolve(options['--config']), name: options['--name'] }
}

export function monitorChildEnvironment(env) {
  // Wrangler's shouldLogToDisk checks WRANGLER_WRITE_LOGS. Do not rely only
  // on sanitizing stdout: its debug logger must never persist raw traffic.
  return { ...env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'warn', NO_COLOR: '1' }
}

export function buildWranglerTailArgs(bin, options) {
  assert.equal(options.name, 'gptpay1688-store')
  // Wrangler rejects sampling-rate >= 1. Omit the flag to add no sampling
  // filter; Cloudflare can still impose its own service-side tail limits.
  return [bin, 'tail', options.name, '--config', options.config, '--format', 'json']
}

export function classifyCliDiagnostic(chunk) {
  const text = String(chunk)
  if (/sampling rate must be between 0 and 1/i.test(text)) return 'invalid-sampling-rate'
  if (/proxy environment variables detected/i.test(text)) return 'proxy-detected'
  if (/tail connection lost|unable to reconnect to the tail|closed unexpectedly/i.test(text)) return 'tail-disconnected'
  if (/authentication error|unauthori[sz]ed|not logged in|login required|invalid api token|expired.*token/i.test(text)) return 'authentication-error'
  if (/access denied|permission denied|forbidden|unexpected server response:\s*403/i.test(text)) return 'permission-denied'
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|fetch failed|network|TLS|certificate|WebSocket/i.test(text)) return 'network-error'
  if (/unknown argument|missing required argument|invalid.*config|parsing.*config/i.test(text)) return 'configuration-error'
  return /(?:error|failed|unable|denied)/i.test(text) ? 'cli-error' : 'cli-warning'
}

function run() {
  const options = parseMonitorArgs(process.argv.slice(2))
  const parsed = ts.parseConfigFileTextToJson(options.config, readFileSync(options.config, 'utf8'))
  assert.ok(!parsed.error && parsed.config?.name === options.name, 'Config Worker name does not match')
  const require = createRequire(import.meta.url)
  const bin = path.join(path.dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js')
  const emit = record => process.stdout.write(JSON.stringify(record) + '\n')
  let observations = 0, stopping = false
  const child = spawn(process.execPath, buildWranglerTailArgs(bin, options), {
    shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: monitorChildEnvironment(process.env),
  })
  const stream = createJsonObjectStream(record => {
    if (!('event' in record) || !('outcome' in record)) { emit({ monitor: 'non-event-json' }); return }
    if (!observations) emit({ monitor: 'connected-observation-received' })
    observations++
    emit(sanitizeTailRecord(record))
  }, reason => emit({ monitor: 'parse-diagnostic', reason }))
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => stream.write(chunk))
  child.stderr.on('data', chunk => emit({ monitor: classifyCliDiagnostic(chunk) }))
  child.on('error', () => { emit({ monitor: 'spawn-error' }); process.exitCode = 1 })
  child.on('close', (code, signal) => {
    stream.end()
    emit({ monitor: 'closed', observations, code: Number.isInteger(code) ? code : null, signal: ['SIGTERM', 'SIGINT', 'SIGKILL'].includes(signal) ? signal : null })
    if (!stopping && code !== 0) process.exitCode = 1
  })
  const stop = () => {
    if (stopping) return
    stopping = true; emit({ monitor: 'stop-requested' }); child.kill('SIGINT')
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') }, 10000).unref()
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  emit({ monitor: 'started', worker: options.name })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run() } catch { process.stderr.write('{"monitor":"configuration-or-start-failed"}\n'); process.exitCode = 1 }
}

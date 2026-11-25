import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import ts from 'typescript'

// Read-only gate: never creates resources, changes production config, or deploys.
const [productionFile, baselineFile, candidateFile] = process.argv.slice(2)
assert.ok(productionFile && baselineFile && candidateFile, 'Usage: node verify-config.mjs production.jsonc baseline.json candidate.json')
function read(file) {
  const raw = readFileSync(file, 'utf8')
  const parsed = ts.parseConfigFileTextToJson(file, raw)
  assert.ok(!parsed.error, 'Invalid JSON configuration')
  return { config: parsed.config, sha256: createHash('sha256').update(raw).digest('hex') }
}
const prod = read(productionFile), baseline = read(baselineFile), candidate = read(candidateFile)
const p = prod.config, b = baseline.config, c = candidate.config
assert.match(b.name, /^gptibo-seo-rehearsal-[a-z0-9-]+$/)
assert.equal(c.name, b.name)
assert.notEqual(b.name, p.name, 'Production Worker must never be used for rehearsal')
const stageOrigin = new URL(c.vars.STOREFRONT_SEO_ORIGIN)
assert.equal(stageOrigin.protocol, 'https:')
assert.ok(stageOrigin.hostname.startsWith(b.name + '.') && stageOrigin.hostname.endsWith('.workers.dev'))
assert.equal(stageOrigin.href, stageOrigin.origin + '/')
assert.ok(!stageOrigin.username && !stageOrigin.password && !stageOrigin.search && !stageOrigin.hash)
const isolatedVars = new Set(['TURNSTILE_SITE_KEY', 'TURNSTILE_HOSTNAMES', 'MAIL_PUBLIC_ORIGIN', 'MAIL_BRAND_NAME', 'PAYMENT_NOTIFY_ORIGIN', 'RECHARGE_NOTIFY_URL'])
for (const stage of [b, c]) {
  const credentialKeys = Object.keys(stage.vars).filter(key => key !== 'TURNSTILE_SITE_KEY' && /SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ENCRYPTION_KEY|(?:^|_)(?:API_KEY|CLIENT_KEY|KEY)$/.test(key))
  assert.deepEqual(credentialKeys, [], 'Cloud rehearsal config must not contain provider credentials, even when present in production vars')
  assert.deepEqual(stage.routes, [], 'No production custom-domain or zone routes')
  assert.equal(stage.workers_dev, true)
  assert.equal(stage.preview_urls, false)
  assert.equal(stage.compatibility_date, p.compatibility_date)
  assert.deepEqual(stage.compatibility_flags, p.compatibility_flags)
  assert.deepEqual(stage.triggers, p.triggers, 'Keep cron schedules identical')
  assert.equal(stage.account_id, p.account_id)
  assert.deepEqual(Object.keys(stage).filter(k => !['$schema'].includes(k)).sort(), Object.keys(p).filter(k => k !== '$schema').sort())
  for (const [key, value] of Object.entries(p.vars)) {
    if (!isolatedVars.has(key)) assert.deepEqual(stage.vars[key], value, `Business variable changed: ${key}`)
  }
  assert.deepEqual(Object.keys(stage.vars).filter(k => !(k in p.vars) && k !== 'STOREFRONT_SEO_ORIGIN'), [], 'No copied production secrets or unreviewed variables')
  assert.equal(stage.vars.TURNSTILE_SITE_KEY, '1x00000000000000000000AA')
  assert.equal(stage.vars.TURNSTILE_HOSTNAMES, stageOrigin.hostname)
  for (const key of ['MAIL_PUBLIC_ORIGIN', 'PAYMENT_NOTIFY_ORIGIN']) assert.equal(stage.vars[key], stageOrigin.origin)
  assert.equal(stage.vars.RECHARGE_NOTIFY_URL, stageOrigin.origin + '/api/recharge/webhook')
  assert.equal(stage.d1_databases.length, 1)
  assert.equal(stage.d1_databases[0].binding, p.d1_databases[0].binding)
  assert.equal(stage.d1_databases[0].database_name, stage.name)
  assert.match(stage.d1_databases[0].database_id, /^[0-9a-f-]{36}$/)
  assert.ok(!p.d1_databases.some(db => db.database_id === stage.d1_databases[0].database_id))
  assert.notEqual(stage.d1_databases[0].database_id, '00000000-0000-0000-0000-000000000000')
  assert.equal(stage.assets.binding, p.assets.binding)
  assert.equal(stage.assets.not_found_handling, p.assets.not_found_handling)
  for (const limiter of p.ratelimits) {
    const actual = stage.ratelimits.find(x => x.name === limiter.name)
    assert.ok(actual, `Missing buyer limiter ${limiter.name}`)
    assert.deepEqual(actual.simple, limiter.simple, `Changed buyer budget ${limiter.name}`)
  }
  assert.equal(new Set(stage.ratelimits.map(x => x.namespace_id)).size, stage.ratelimits.length)
  assert.ok(stage.ratelimits.every(x => !p.ratelimits.some(y => String(y.namespace_id) === String(x.namespace_id))), 'Never share production quota')
}
assert.equal(b.vars.STOREFRONT_SEO_ORIGIN ?? '', '')
assert.deepEqual(b.assets.run_worker_first, p.assets.run_worker_first)
assert.match(b.main, /\/worker\/index\.ts$/)
assert.equal(c.assets.run_worker_first, true)
assert.match(c.main, /\/worker\/storefront-entry\.ts$/)
assert.equal(c.d1_databases[0].database_id, b.d1_databases[0].database_id, 'Upgrade and rollback must retain the same isolated D1')
assert.deepEqual(c.vars, { ...b.vars, STOREFRONT_SEO_ORIGIN: stageOrigin.origin })
assert.equal(b.ratelimits.length, p.ratelimits.length)
assert.equal(c.ratelimits.length, b.ratelimits.length + 1)
assert.deepEqual(c.ratelimits.filter(x => x.name !== 'SEO_CATALOG_LIMITER'), b.ratelimits)
assert.deepEqual(c.ratelimits.find(x => x.name === 'SEO_CATALOG_LIMITER')?.simple, { limit: 6, period: 60 })
console.log(JSON.stringify({ verified: true, productionConfigSha256: prod.sha256, baselineConfigSha256: baseline.sha256, candidateConfigSha256: candidate.sha256, businessVariablesPreserved: true, existingLimiterBudgetsPreserved: true, cronPreserved: true, resourcesIsolated: true, configCredentialVarsAbsent: true, remoteSecretBindingsRequireSeparateAudit: true }, null, 2))

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { validTotpSecret, totpCode, verifyTotp } from '../worker/totp.ts'

const script = new URL('../scripts/admin-setup.mjs', import.meta.url)
const run = (dir: string, email = 'owner@example.invalid') => spawnSync(process.execPath, [script.pathname, '--dir', dir, '--username', 'store-admin', '--email', email], { encoding: 'utf8' })

test('admin setup creates private usable credentials and enrollment QR without printing secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gptibo-admin-setup-'))
  try {
    const first = run(dir)
    assert.equal(first.status, 0, first.stderr)
    const raw = await readFile(join(dir, 'secrets.json'), 'utf8')
    const secrets = JSON.parse(raw)
    assert.equal(secrets.ADMIN_EMAIL, 'owner@example.invalid')
    assert.equal(secrets.ADMIN_USERNAME, 'store-admin')
    assert.ok(validTotpSecret(secrets.ADMIN_TOTP_SECRET))
    assert.match(secrets.PARTNER_AUTH_SECRET, /^[a-f0-9]{64}$/)
    const now = Date.now(), step = Math.floor(now / 30000)
    assert.equal(await verifyTotp(secrets.ADMIN_TOTP_SECRET, await totpCode(secrets.ADMIN_TOTP_SECRET, step), now), step)
    const png = await readFile(join(dir, 'totp.png'))
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    assert.ok(!first.stdout.includes(secrets.ADMIN_TOTP_SECRET))
    assert.ok(!first.stdout.includes(secrets.PARTNER_AUTH_SECRET))
    assert.ok(!first.stdout.includes('otpauth://'))
    if (process.platform !== 'win32') {
      assert.equal((await stat(dir)).mode & 0o777, 0o700)
      for (const file of await readdir(dir)) assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600)
    }
    const repeat = run(dir)
    assert.equal(repeat.status, 0, repeat.stderr)
    assert.equal(await readFile(join(dir, 'secrets.json'), 'utf8'), raw, 're-running must preserve enrolled TOTP and existing recovery sessions')
    const changed = run(dir, 'different@example.invalid')
    assert.notEqual(changed.status, 0)
    assert.equal(await readFile(join(dir, 'secrets.json'), 'utf8'), raw, 'different admin must not silently replace existing credentials')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('admin setup rejects invalid input before creating credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gptibo-admin-invalid-'))
  try {
    const result = run(dir, 'not-an-email')
    assert.notEqual(result.status, 0)
    assert.deepEqual(await readdir(dir), [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

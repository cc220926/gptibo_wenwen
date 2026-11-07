import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseHistoryCsv, historyImportSql } from '../scripts/import-customer-history.mjs'
import { isMaskedCustomerEmail } from '../shared/customer-history.ts'

test('CSV import accepts BOM, quotes and CRLF, normalizes masks and collapses only repeated display strings', () => {
  const result = parseHistoryCsv('\uFEFF"客户邮箱"\r\n"Ab***@Example.Invalid"\r\nab***@example.invalid\r\nxy***z@example.invalid\r\n\r\n')
  assert.deepEqual(result, { sourceRows: 3, emails: ['ab***@example.invalid', 'xy***z@example.invalid'] })
  assert.deepEqual(parseHistoryCsv('客户邮箱\n***@example.invalid'), { sourceRows: 1, emails: ['***@example.invalid'] })
})

test('import rejects unmasked addresses, malformed CSV and unsupported columns without echoing customer values', () => {
  const invalid = ['客户邮箱\nprivate@example.invalid', '客户邮箱\na*b@example.invalid', '客户邮箱,订单号\na***@example.invalid,1', '客户邮箱\na***@example.invalid,', '客户邮箱\n"a***@example.invalid', '客户邮箱\n"a***@example.invalid"junk', '客户邮箱\na"***@example.invalid', '客户邮箱\n"a***\n@example.invalid"', '客户邮箱\n', 'email\na***@example.invalid']
  for (const csv of invalid) assert.throws(() => parseHistoryCsv(csv))
  try { parseHistoryCsv('客户邮箱\nsecret-person@example.invalid') } catch (error) { assert.ok(!String(error).includes('secret-person')) }
  for (const value of ['a***@-example.invalid', 'a***@example..invalid', 'a***@example.invalid\n', 'a***@example.invalid<script>', 'unmasked@example.invalid***', 'x'.repeat(65) + '***@example.invalid']) assert.equal(isMaskedCustomerEmail(value), false)
})

test('generated SQL is idempotent and separate from financial orders, including multi-batch imports', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec(await readFile(new URL('../migrations/0050_customer_history.sql', import.meta.url), 'utf8'))
  db.exec('CREATE TABLE orders(id TEXT PRIMARY KEY); INSERT INTO orders VALUES (\'keep\')')
  const emails = Array.from({ length: 205 }, (_, i) => `c${i}***@example.invalid`)
  const sql = historyImportSql(emails)
  db.exec(sql); db.exec(sql)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_history').get()!.n, 205)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  db.exec(historyImportSql([emails[0]], 'another-shop'))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_history WHERE shop_id=?').get('another-shop')!.n, 1)
  assert.throws(() => historyImportSql(['not-masked@example.invalid']))
  assert.throws(() => historyImportSql(emails, "platform'); DROP TABLE orders;--"))
})

test('CLI writes private SQL only, without printing masks or changing the source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gptibo-history-')); t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'source.csv'), output = join(root, '.secrets', 'history', 'import.sql')
  const source = '客户邮箱\na***@example.invalid\nb***@example.invalid\na***@example.invalid\n'
  await writeFile(input, source)
  const run = (target: string) => spawnSync(process.execPath, [new URL('../scripts/import-customer-history.mjs', import.meta.url).pathname, '--input', input, '--output', target], { encoding: 'utf8' })
  const result = run(output)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /"sourceRows": 3/)
  assert.match(result.stdout, /"displayEntries": 2/)
  assert.ok(!result.stdout.includes('a***@example.invalid'))
  assert.match(await readFile(output, 'utf8'), /INSERT INTO customer_history/)
  assert.equal(await readFile(input, 'utf8'), source)
  if (process.platform !== 'win32') {
    assert.equal((await stat(output)).mode & 0o777, 0o600)
    assert.equal((await stat(join(root, '.secrets', 'history'))).mode & 0o777, 0o700)
  }
  assert.notEqual(run(join(root, 'public.sql')).status, 0)
  if (process.platform !== 'win32') {
    const link = join(root, '.secrets', 'symlink.sql')
    await symlink(input, link)
    assert.notEqual(run(link).status, 0)
    assert.equal(await readFile(input, 'utf8'), source)
  }
})

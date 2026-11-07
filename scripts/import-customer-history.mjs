#!/usr/bin/env node
import { readFile, lstat } from 'node:fs/promises'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMaskedCustomerEmail } from '../shared/customer-history.ts'
import { ensurePrivateDirectory, writePrivateFile } from './private-files.mjs'

const help = `Prepare a private SQL import of historical paid-customer display masks.
Usage: node scripts/import-customer-history.mjs --input SOURCE.csv --output .secrets/order-feed-import/customer-history.sql [--shop platform]
The CSV must have one column named 客户邮箱. Every value must already be masked.
The owner must supply historical paid-customer records; this script cannot verify payment.
Repeated display masks are collapsed; these counts are not customer or order counts.
SQL only inserts into customer_history, preserving existing masks on repeat imports.
The output must be a .sql file inside a .secrets directory. This command never connects to a database or deploys.`

// Small strict CSV reader: quoted fields, escaped quotes, CRLF and UTF-8 BOM.
// Content is data, never interpreted as formulas or instructions.
export function parseHistoryCsv(text) {
  text = text.replace(/^\uFEFF/, '')
  const rows = []
  let row = [], field = '', quoted = false, closed = false
  const finishField = () => { row.push(field); field = ''; closed = false }
  const finishRow = () => { finishField(); rows.push(row); row = [] }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else { quoted = false; closed = true }
      } else field += char
    } else if (char === ',') finishField()
    else if (char === '\n' || char === '\r') {
      finishRow()
      if (char === '\r' && text[i + 1] === '\n') i++
    } else if (char === '"' && !field && !closed) quoted = true
    else {
      if (closed || char === '"') throw new Error('CSV quoting is invalid.')
      field += char
    }
  }
  if (quoted) throw new Error('CSV contains an unfinished quoted field.')
  if (field || closed || row.length) finishRow()
  if (rows[0]?.length !== 1 || rows[0][0].trim() !== '客户邮箱') throw new Error('CSV must have exactly one column named 客户邮箱.')
  const emails = new Set()
  let sourceRows = 0
  for (let i = 1; i < rows.length; i++) {
    const fields = rows[i]
    // Ignore genuinely blank lines, but reject a blank value in a multi-column row.
    if (fields.length === 1 && !fields[0].trim()) continue
    if (fields.length !== 1) throw new Error(`CSV record ${i + 1} must contain one field.`)
    const email = fields[0].trim().toLowerCase()
    if (!isMaskedCustomerEmail(email)) throw new Error(`CSV record ${i + 1} must contain a valid masked email with at least three consecutive asterisks.`)
    sourceRows++
    emails.add(email)
  }
  if (!sourceRows) throw new Error('CSV contains no masked customer records.')
  return { sourceRows, emails: [...emails] }
}

export function historyImportSql(emails, shop = 'platform') {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(shop)) throw new Error('Invalid shop ID.')
  if (!emails.length || emails.some(email => !isMaskedCustomerEmail(email))) throw new Error('Only valid masked emails may be imported.')
  const quote = value => "'" + value.replaceAll("'", "''") + "'"
  const lines = ['-- Historical display masks only; not financial orders or a customer count.']
  for (let i = 0; i < emails.length; i += 100) {
    lines.push('INSERT INTO customer_history(shop_id,masked_email) VALUES\n' + emails.slice(i, i + 100).map(email => `(${quote(shop)},${quote(email)})`).join(',\n') + '\nON CONFLICT(shop_id,masked_email) DO NOTHING;')
  }
  return lines.join('\n') + '\n'
}

function options(args) {
  const result = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { result.help = true; continue }
    const key = args[i].slice(2)
    if (!args[i].startsWith('--') || !['input', 'output', 'shop'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || result[key]) throw new Error('Invalid or repeated option. Use --help.')
    result[key] = args[++i]
  }
  return result
}

async function privateOutput(path) {
  const root = parse(path).root
  const parts = relative(root, path).split(sep)
  const privateIndex = parts.indexOf('.secrets')
  if (privateIndex < 0 || privateIndex === parts.length - 1 || !path.endsWith('.sql')) throw new Error('Output must be a .sql file inside a .secrets directory.')
  let current = root
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i])
    // macOS /var is a system symlink to /private/var. Reject links inside the
    // private subtree, where a redirected output could escape its protected path.
    try { if (i >= privateIndex && (await lstat(current)).isSymbolicLink()) throw new Error('Refusing symbolic links in private output path.') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (i >= privateIndex && i < parts.length - 1) await ensurePrivateDirectory(current)
  }
}

async function main() {
  const opts = options(process.argv.slice(2))
  if (opts.help) { console.log(help); return }
  if (!opts.input || !opts.output) throw new Error('Provide --input and --output. Use --help.')
  const input = resolve(opts.input), output = resolve(opts.output)
  if (input === output) throw new Error('Input and output must differ.')
  const data = await readFile(input)
  if (data.length > 10 * 1024 * 1024) throw new Error('CSV is too large (maximum 10 MiB).')
  const parsed = parseHistoryCsv(new TextDecoder('utf-8', { fatal: true }).decode(data))
  const sql = historyImportSql(parsed.emails, opts.shop ?? 'platform')
  await privateOutput(output)
  await ensurePrivateDirectory(dirname(output))
  await writePrivateFile(output, sql)
  console.log(JSON.stringify({ sourceRows: parsed.sourceRows, displayEntries: parsed.emails.length, repeatedMasks: parsed.sourceRows - parsed.emails.length, output }, null, 2))
  console.log('Private SQL prepared. No database changes or deployment performed.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'History import preparation failed.'); process.exitCode = 1 })
}

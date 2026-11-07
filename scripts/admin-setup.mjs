#!/usr/bin/env node
import { open, readFile, lstat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import QRCode from 'qrcode'
import { generateTotpSecret, validTotpSecret } from '../worker/totp.ts'
import { ensurePrivateDirectory, protectPrivatePath, writePrivateFile } from './private-files.mjs'

const help = `Initialize local Workers admin credentials and authenticator pairing.
Usage: npm run admin:setup -- --email owner@example.invalid --username store-admin
Options: --email EMAIL --username NAME --dir PRIVATE_DIRECTORY --help
Without options, an interactive terminal asks for email and username.
Secrets are saved locally; this command never deploys or sends email.
Repeat runs preserve existing credentials. Changing identity requires an explicit migration.`

function options(args) {
  const result = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { result.help = true; continue }
    const key = args[i].slice(2)
    if (!args[i].startsWith('--') || !['email', 'username', 'dir'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || result[key]) throw new Error('Invalid or repeated option. Use --help.')
    result[key] = args[++i]
  }
  return result
}

async function rejectLink(path) {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Refusing a symbolic link in private setup output.') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

async function setup({ email, username, dir }) {
  email = email.trim().toLowerCase()
  username = username.trim()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid administrator email address.')
  if (!/^[A-Za-z0-9_.-]{3,80}$/.test(username)) throw new Error('Username must contain 3–80 letters, digits, dots, underscores or hyphens.')
  const directory = resolve(dir || fileURLToPath(new URL('../.secrets/admin-setup/', import.meta.url)))
  await rejectLink(directory)
  await ensurePrivateDirectory(directory)
  const path = join(directory, 'secrets.json')
  await rejectLink(path)
  let secrets
  try {
    const raw = await readFile(path, 'utf8')
    try { secrets = JSON.parse(raw) } catch { throw new Error('Existing private configuration is invalid; nothing was replaced.') }
    if (secrets.ADMIN_EMAIL !== email || secrets.ADMIN_USERNAME !== username) throw new Error('Existing administrator identity differs; nothing was replaced.')
    if (!validTotpSecret(secrets.ADMIN_TOTP_SECRET) || typeof secrets.PARTNER_AUTH_SECRET !== 'string' || secrets.PARTNER_AUTH_SECRET.length < 32) throw new Error('Existing private credentials are invalid; nothing was replaced.')
    await protectPrivatePath(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    secrets = { ADMIN_EMAIL: email, ADMIN_USERNAME: username, ADMIN_TOTP_SECRET: generateTotpSecret(), PARTNER_AUTH_SECRET: randomBytes(32).toString('hex') }
    // Exclusive creation prevents a concurrent setup from rotating enrolled credentials.
    const file = await open(path, 'wx', 0o600)
    try {
      await protectPrivatePath(path)
      await file.writeFile(JSON.stringify(secrets, null, 2) + '\n')
      await file.sync()
    } finally { await file.close() }
  }
  const issuer = 'Recharge AI'
  const uri = 'otpauth://totp/' + encodeURIComponent(issuer + ':' + username) + '?' + new URLSearchParams({ secret: secrets.ADMIN_TOTP_SECRET, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  const qrPath = join(directory, 'totp.png')
  const notesPath = join(directory, 'README.txt')
  await rejectLink(qrPath)
  await rejectLink(notesPath)
  await writePrivateFile(qrPath, await QRCode.toBuffer(uri, { type: 'png', width: 360, margin: 3, errorCorrectionLevel: 'M' }))
  await writePrivateFile(notesPath, `管理员验证器配对\n\n用户名：${username}\n收验证码邮箱：${email}\n\n1. 在自己的验证器应用中扫描同目录 totp.png。该图片含登录密钥，请勿公开或转发。\n2. 保管 secrets.json；重跑初始化会保留现有密钥。\n3. 管理员登录需要用户名、邮箱验证码和验证器的6位动态码。\n4. 部署时用目标 Worker 的 Secrets 导入 secrets.json；不要覆盖已在使用的其他环境凭据。\n5. 另行配置 RESEND_API_KEY、RESEND_FROM 和 MAIL_PUBLIC_ORIGIN 并验证真实收信。\n\n初始化命令未上传配置、未开通发信或登录服务。\n`)
  console.log('Private credentials saved: ' + path)
  console.log('Open the authenticator QR locally: ' + qrPath)
  console.log('No credentials were printed, deployed or sent. Existing credentials were preserved.')
}

async function main() {
  const opts = options(process.argv.slice(2))
  if (opts.help) { console.log(help); return }
  if (!opts.email || !opts.username) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Provide --email and --username, or run in an interactive terminal.')
    const input = createInterface({ input: process.stdin, output: process.stdout })
    try {
      if (!opts.email) opts.email = await input.question('Administrator email: ')
      if (!opts.username) opts.username = (await input.question('Administrator username [store-admin]: ')) || 'store-admin'
    } finally { input.close() }
  }
  await setup(opts)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Administrator setup failed.')
  process.exitCode = 1
})

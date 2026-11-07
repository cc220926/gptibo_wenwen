import { ApiError, hash, type Env } from '../platform.ts'

const bytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0))
const base64 = (value: Uint8Array) => btoa(Array.from(value, byte => String.fromCharCode(byte)).join(''))
async function key(env: Env) {
  let raw: Uint8Array<ArrayBuffer>
  try { raw = bytes(env.CDK_ENCRYPTION_KEY ?? '') } catch { throw new ApiError('卡密加密密钥配置无效。', 503) }
  if (raw.length !== 32) throw new ApiError('请配置独立的 32 字节卡密加密密钥。', 503)
  const fingerprint = await hash(base64(raw))
  const saved = await env.INTEREST_DB.prepare('SELECT fingerprint FROM inventory_key WHERE id=1').first<{ fingerprint: string }>()
  if (saved && saved.fingerprint !== fingerprint) throw new ApiError('卡密密钥与原库存不匹配，请恢复原密钥。', 503)
  return { raw, fingerprint }
}
export async function vaultReady(env: Env) { try { await key(env); return true } catch { return false } }
/** Reuse imported keys within one operation, so bulk imports do not query D1 per code. */
export async function openVault(env: Env) {
  const { raw, fingerprint } = await key(env)
  await env.INTEREST_DB.prepare('INSERT INTO inventory_key(id,fingerprint) VALUES(1,?) ON CONFLICT DO NOTHING').bind(fingerprint).run()
  // A concurrent first import must not establish a different key.
  await key(env)
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt'])
  const hmac = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return {
    async seal(value: string, context: string) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) }, aes, new TextEncoder().encode(value))
      return base64(iv) + '.' + base64(new Uint8Array(cipher))
    },
    async fingerprint(value: string) {
      return base64(new Uint8Array(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(value))))
    },
  }
}
export async function seal(env: Env, value: string, context: string) { return (await openVault(env)).seal(value, context) }
export async function unseal(env: Env, value: string, context: string) {
  const { raw } = await key(env), [iv, cipher] = value.split('.')
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv), additionalData: new TextEncoder().encode(context) }, aes, bytes(cipher)))
}

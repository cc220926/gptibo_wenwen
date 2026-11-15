import { signature } from '../../shared/xgift-signature.ts'
import { ApiError, type Env } from '../platform.ts'
import { boundedResponseText } from '../bounded-response.ts'

// Native /v1 protocol, not the Dujiao or Yiciyuan compatibility protocols.
export const MUSE_ORIGIN = 'https://api.gptibo.com'
export const museConfigured = (env: Env) => Boolean(env.MUSE_KEY_ID && env.MUSE_API_SECRET)
export class MuseError extends ApiError {
  code: string
  constructor(code = 'unconfirmed', status = 503) {
    super('Muse 供货结果暂未确认，请保留原订单并稍后查询。', status)
    this.code = code
  }
}
export async function museRequest<T>(env: Env, path: string, raw = '', idempotency = ''): Promise<T> {
  if (!museConfigured(env)) throw new ApiError('Muse 供货接口尚未配置。', 503)
  if (!/^\/(?:products|balance|preflight|orders(?:\/(?:by-merchant\/)?[A-Za-z0-9_.:-]+(?:\/delivery)?)?)$/.test(path)) throw new MuseError()
  if ((path === '/orders') !== Boolean(idempotency) || (idempotency && !/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotency))) throw new MuseError()
  const window = Math.floor(Date.now() / 60000)
  for (const [bucket, limit] of [['all', 240], ...(path === '/preflight' ? [['preflight', 10]] : path.endsWith('/delivery') ? [['delivery', 50]] : [])] as [string, number][]) {
    const claimed = await env.INTEREST_DB.prepare(`INSERT INTO muse_rate_limits(key_id,bucket,window_start,used) VALUES(?,?,?,1)
      ON CONFLICT(key_id,bucket) DO UPDATE SET window_start=excluded.window_start,used=CASE WHEN window_start=excluded.window_start THEN used+1 ELSE 1 END
      WHERE window_start<>excluded.window_start OR used<? RETURNING used`).bind(env.MUSE_KEY_ID!, bucket, window, limit).first()
    if (!claimed) throw new MuseError('rate_limited', 429)
  }
  const method = raw ? 'POST' : 'GET', url = new URL('/v1' + path, MUSE_ORIGIN)
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomUUID()
  try {
    const response = await fetch(url, {
      // Workers rejects redirect:'error' before sending. Manual + rejection
      // preserves the no-redirect boundary without forwarding signed headers.
      method, ...(raw ? { body: raw } : {}), redirect: 'manual', signal: AbortSignal.timeout(12000),
      headers: { Accept: 'application/json', ...(raw ? { 'Content-Type': 'application/json' } : {}),
        'X-Key-Id': env.MUSE_KEY_ID!, 'X-Timestamp': timestamp, 'X-Nonce': nonce,
        'X-Signature': await signature(env.MUSE_API_SECRET!, method, url, timestamp, nonce, env.MUSE_KEY_ID!, idempotency, raw),
        ...(idempotency ? { 'Idempotency-Key': idempotency } : {}) },
    })
    if (response.status >= 300 && response.status < 400) throw new MuseError('redirect_refused', response.status)
    let value
    try { value = JSON.parse(await boundedResponseText(response)) }
    catch { throw new MuseError('invalid_response', response.status) }
    if (!response.ok || !value || !Object.hasOwn(value, 'data')) {
      throw new MuseError(typeof value?.error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(value.error.code) ? value.error.code : 'unconfirmed', response.ok ? 503 : response.status)
    }
    return value.data as T
  } catch (error) {
    if (error instanceof MuseError) throw error
    throw new MuseError(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'transport_error')
  }
}
// Muse-branded SKUs plus explicitly allowed non-Muse native account_delivery SKUs.
// Anything else in the supplier catalogue stays invisible and unpurchasable.
export const GPTIBO_EXTRA_PRODUCTS: readonly string[] = ['codex-sms-once', 'gpt-plus-account']
export const isMuseCode = (code: string) => /^muse(?:[-_]|$)/i.test(code)
export const gptiboSupplyCode = (code: string) => /^[A-Za-z0-9_.:-]{1,100}$/.test(code) && (isMuseCode(code) || GPTIBO_EXTRA_PRODUCTS.includes(code))
/** Public, non-sensitive presentation hint for storefront pages (never the supplier code itself). */
export const supplyKind = (code: string | null) => code === 'codex-sms-once' ? 'codex-sms' as const : code === 'gpt-plus-account' ? 'gpt-account' as const : null
export type MuseProduct = { code: string; name: string; supply_minor: number; enabled: boolean; available: boolean; fulfillment_type: string }
export const minor = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10000000
export async function museProducts(env: Env) {
  const rows = await museRequest<MuseProduct[]>(env, '/products')
  if (!Array.isArray(rows)) throw new MuseError('products_invalid')
  const products = rows.filter(p => typeof p?.code === 'string' && gptiboSupplyCode(p.code) && p.fulfillment_type === 'account_delivery')
  if (new Set(products.map(p => p.code)).size !== products.length || products.some(p => !/^[A-Za-z0-9_.:-]{1,100}$/.test(p.code) || typeof p.name !== 'string' || !minor(p.supply_minor) || typeof p.enabled !== 'boolean' || typeof p.available !== 'boolean')) throw new MuseError('products_invalid')
  return products.map(p => ({ code: p.code, name: p.name.slice(0, 150), supply_minor: p.supply_minor, enabled: p.enabled, available: p.available, fulfillment_type: p.fulfillment_type }))
}
export async function museBalance(env: Env) {
  const b = await museRequest<{ currency: string; available_minor: number; frozen_minor: number }>(env, '/balance')
  if (b?.currency !== 'CNY' || !minor(b.available_minor) || !minor(b.frozen_minor)) throw new MuseError('balance_invalid')
  return b
}

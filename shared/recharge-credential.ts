export const RECHARGE_RETENTION_UNAVAILABLE = 'recharge_retention_unavailable'

// Validate the extracted token while retaining the caller's exact bytes for
// idempotent recovery. Any retained request must use the order-scoped encrypted vault.
export function rechargeCredentialToken(raw: string, mode: 'session' | 'access_token'): { token: string; expires?: unknown } {
  const text = raw.trim()
  if (!text) throw new Error('Empty credential')
  let token: unknown = text
  let expires: unknown
  if (text.startsWith('{')) {
    let parsed
    try { parsed = JSON.parse(text) } catch { throw new Error('Invalid credential JSON') }
    token = undefined
    const keys = mode === 'session' ? ['sessionToken', 'session', 'accessToken', 'access_token'] : ['accessToken', 'access_token']
    for (const source of [parsed, parsed?.data, parsed?.auth]) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue
      const value = keys.map(key => source[key]).find(value => typeof value === 'string' && value.trim())
      if (value !== undefined) { token = value; expires = source.expires ?? parsed.expires; break }
    }
  }
  if (typeof token !== 'string' || !token.trim() || token.trim().length > 128 * 1024) throw new Error('Invalid credential token')
  return { token: token.trim(), expires }
}

import { credentialExpiryProblem } from '../../shared/credential-expiry.ts'

export function checkoutSession(value: string, retryMode?: 'session' | 'access_token' | null) {
  if (value.length > 256 * 1024) return { email: '', problem: 'Session 内容过长，请仅复制官方 Session 页面返回的完整 JSON。', credential: null }
  if (!value.trim()) return { email: '', problem: '', credential: null }
  let session: { user?: { email?: unknown }; accessToken?: unknown; expires?: unknown }
  try { session = JSON.parse(value) }
  catch { return { email: '', problem: '请复制并粘贴完整的 Session JSON。', credential: null } }
  if (session && typeof session === 'object' && !Array.isArray(session) && Object.keys(session).length === 0) {
    return { email: '', problem: '获取到的是空内容 {}，可能尚未登录 ChatGPT 或登录已失效。请先访问 chatgpt.com 登录，再在同一浏览器重新获取 Session。', credential: null }
  }
  if (!session || typeof session.user?.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(session.user.email) || typeof session.accessToken !== 'string' || !session.accessToken.trim()) {
    return { email: '', problem: 'Session 缺少账号信息，请重新获取完整内容。', credential: null }
  }
  // An unknown original request must retain its exact payload, even if it has
  // since expired. The server independently verifies the original key/hash.
  const problem = retryMode ? '' : credentialExpiryProblem(session.accessToken, session.expires)
  if (problem) return { email: '', problem, credential: null }
  // Recover an existing uncertain token submission without changing its request body.
  const credential = retryMode === 'access_token' ? { mode: 'access_token' as const, access_token: session.accessToken } : { mode: 'session' as const, session: value }
  // Retain complete identity JSON for channel two; validate without trimming or
  // extracting it into a different wire payload. Account for JSON escaping too.
  if (session.accessToken.trim().length > 128 * 1024 || new TextEncoder().encode(JSON.stringify({ mode: 'auto_recharge', order_id: 'x'.repeat(100), credential, customer_confirmed_email: true })).byteLength > 256 * 1024) {
    return { email: '', problem: 'Session 内容过长，请仅复制官方 Session 页面返回的完整 JSON。', credential: null }
  }
  return { email: session.user.email, problem: '', credential }
}

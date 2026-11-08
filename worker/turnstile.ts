import { ApiError, json, type Env } from './platform.ts'
import { boundedResponseText } from './bounded-response.ts'

const action = 'order_create'
const unavailable = () => new ApiError('人机验证服务暂不可用，请稍后重试。', 503)

function widget(request: Request, env: Env) {
  const hostname = new URL(request.url).hostname
  const hosts = (env.TURNSTILE_HOSTNAMES ?? '').split(',').map(host => host.trim())
  if (!env.TURNSTILE_SITE_KEY?.trim() || !env.TURNSTILE_SECRET_KEY?.trim() || !hosts.includes(hostname)) throw unavailable()
  return { hostname, siteKey: env.TURNSTILE_SITE_KEY.trim(), secret: env.TURNSTILE_SECRET_KEY.trim() }
}

export function verificationConfig(request: Request, env: Env) {
  // Login/recovery retain their existing OTP/TOTP controls. This widget protects checkout.
  if (new URL(request.url).searchParams.get('purpose') === 'auth') return json({ enabled: false, purpose: 'auth' })
  if (env.TURNSTILE_ENABLED !== 'true') return json({ enabled: false, purpose: action })
  return json({ enabled: true, purpose: action, siteKey: widget(request, env).siteKey })
}

export async function verifyOrderChallenge(request: Request, env: Env, token: unknown) {
  if (env.TURNSTILE_ENABLED !== 'true') return
  const config = widget(request, env)
  if (typeof token !== 'string' || !token.trim() || token.length > 2048) throw new ApiError('请先完成人机验证，再继续下单。')
  const payload: Record<string, string> = { secret: config.secret, response: token }
  const ip = request.headers.get('CF-Connecting-IP')
  if (ip) payload.remoteip = ip
  let result: { success?: unknown; hostname?: unknown; action?: unknown; challenge_ts?: unknown; 'error-codes'?: unknown }
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      redirect: 'error', signal: AbortSignal.timeout(8000),
    })
    if (response.status !== 200) { await response.body?.cancel(); throw new Error() }
    result = JSON.parse(await boundedResponseText(response, 16384))
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error()
  } catch { throw unavailable() }
  if (Array.isArray(result['error-codes']) && result['error-codes'].some(code => ['missing-input-secret', 'invalid-input-secret', 'internal-error'].includes(code))) throw unavailable()
  const timestamp = typeof result.challenge_ts === 'string' ? Date.parse(result.challenge_ts) : NaN
  const age = Date.now() - timestamp
  if (result.success !== true || result.hostname !== config.hostname || result.action !== action || !Number.isFinite(age) || age > 300000 || age < -60000) throw new ApiError('人机验证未通过或已过期，请重新验证。')
}

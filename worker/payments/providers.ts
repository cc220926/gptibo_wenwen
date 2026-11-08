import { ApiError, type Env } from '../platform.ts'
import { alipay } from './alipay.ts'
import { zpay } from './zpay.ts'
import type { PaymentProvider } from './types.ts'

export function alipayConfigured(env: Env) { return Boolean(env.ALIPAY_APP_ID && env.ALIPAY_SELLER_ID && env.ALIPAY_APP_PRIVATE_KEY && env.ALIPAY_PUBLIC_KEY) }
export function zpayConfigured(env: Env) { return Boolean(env.ZPAY_PID && env.ZPAY_KEY && /^[A-Za-z0-9]{4,64}$/.test(env.ZPAY_PID) && env.ZPAY_KEY.length >= 16) }
export function servicePaymentProviderId(env: Env) { return env.SERVICE_PAYMENT_PROVIDER === 'zpay' ? 'zpay' : 'alipay' }
export function servicePaymentConfigured(env: Env) { return servicePaymentProviderId(env) === 'zpay' ? zpayConfigured(env) : alipayConfigured(env) }
// Resolve using the payment's persisted provider, not today's checkout default.
export function paymentProvider(env: Env, id: string): PaymentProvider {
  if (id === 'alipay' && alipayConfigured(env)) return alipay({ ALIPAY_APP_ID: env.ALIPAY_APP_ID!, ALIPAY_SELLER_ID: env.ALIPAY_SELLER_ID!, ALIPAY_APP_PRIVATE_KEY: env.ALIPAY_APP_PRIVATE_KEY!, ALIPAY_PUBLIC_KEY: env.ALIPAY_PUBLIC_KEY!, ALIPAY_GATEWAY: env.ALIPAY_GATEWAY })
  if (id === 'zpay' && zpayConfigured(env)) return zpay({ pid: env.ZPAY_PID!, key: env.ZPAY_KEY! })
  throw new ApiError('该订单的支付渠道尚未配置，请联系支持。', 503)
}

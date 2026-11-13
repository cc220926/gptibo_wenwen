import { ApiError, type Env } from '../platform.ts'
import { alipay } from './alipay.ts'
import { zpay } from './zpay.ts'
import { mapay } from './mapay.ts'
import type { PaymentProvider } from './types.ts'

export function alipayConfigured(env: Env) { return Boolean(env.ALIPAY_APP_ID && env.ALIPAY_SELLER_ID && env.ALIPAY_APP_PRIVATE_KEY && env.ALIPAY_PUBLIC_KEY) }
export function zpayConfigured(env: Env) { return Boolean(env.ZPAY_PID && env.ZPAY_KEY && /^[A-Za-z0-9]{4,64}$/.test(env.ZPAY_PID) && env.ZPAY_KEY.length >= 16) }
export function mapayConfigured(env: Env) { return Boolean(env.MAPAY_PID && /^\d{1,20}$/.test(env.MAPAY_PID) && env.MAPAY_KEY && env.MAPAY_KEY.length >= 16 && env.MAPAY_KEY.length <= 256) }
export const isEpayProvider = (id: string) => id === 'zpay' || id === 'mapay'
export function servicePaymentProviderId(env: Env, muse = false) { const id = muse ? env.MUSE_PAYMENT_PROVIDER ?? env.SERVICE_PAYMENT_PROVIDER : env.SERVICE_PAYMENT_PROVIDER; return id === 'mapay' ? 'mapay' : id === 'zpay' ? 'zpay' : 'alipay' }
export function servicePaymentConfigured(env: Env, muse = false) { const id = servicePaymentProviderId(env, muse); return id === 'mapay' ? mapayConfigured(env) : id === 'zpay' ? zpayConfigured(env) : alipayConfigured(env) }
// Resolve using the payment's persisted provider, not today's checkout default.
export function paymentProvider(env: Env, id: string): PaymentProvider {
  if (id === 'alipay' && alipayConfigured(env)) return alipay({ ALIPAY_APP_ID: env.ALIPAY_APP_ID!, ALIPAY_SELLER_ID: env.ALIPAY_SELLER_ID!, ALIPAY_APP_PRIVATE_KEY: env.ALIPAY_APP_PRIVATE_KEY!, ALIPAY_PUBLIC_KEY: env.ALIPAY_PUBLIC_KEY!, ALIPAY_GATEWAY: env.ALIPAY_GATEWAY })
  if (id === 'zpay' && zpayConfigured(env)) return zpay({ pid: env.ZPAY_PID!, key: env.ZPAY_KEY! })
  if (id === 'mapay' && mapayConfigured(env)) return mapay({ pid: env.MAPAY_PID!, key: env.MAPAY_KEY! })
  throw new ApiError('该订单的支付渠道尚未配置，请联系支持。', 503)
}

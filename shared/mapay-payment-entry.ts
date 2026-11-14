import { publicAlipayQr } from './public-payment.ts'

// A cashier web page is a navigation target, never an Alipay payment QR.
export function mapayPaymentEntry(value: unknown): { kind: 'qr' | 'redirect'; url: string } | null {
  const qr = publicAlipayQr(value)
  if (qr) return { kind: 'qr', url: qr }
  if (typeof value !== 'string' || value !== value.trim() || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return null
  try {
    const url = new URL(value)
    if (url.origin !== 'https://mzf.mapay.cn' || url.username || url.password || url.hash || url.searchParams.has('key')) return null
    // Keep historical signed cashier URLs usable without turning them into QR codes.
    if (/^\/pay\/[A-Za-z0-9_-]{1,64}$/.test(url.pathname) && !url.search
      || url.pathname === '/xpay/epay/submit.php' && url.searchParams.has('sign')) return { kind: 'redirect', url: value }
  } catch { /* Untrusted gateway payload. */ }
  return null
}

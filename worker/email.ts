import { emailTemplates } from './emails.generated.ts'
import type { Env } from './platform.ts'
import { membershipClaimUrl } from '../shared/membership-claim.ts'
import { boundedResponseText } from './bounded-response.ts'
import { platformEmailFields } from '../emails/brand.ts'

export type VerificationKind = 'admin-login' | 'partner-login' | 'order-recovery'
export type EmailMessage = { subject: string; html: string; text: string }
export type MailBrandEnv = Pick<Env, 'MAIL_PUBLIC_ORIGIN' | 'MAIL_BRAND_NAME'>
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

/** Only deployment configuration may supply the public origin, never request headers. */
export function mailBrand(env: MailBrandEnv) {
  let url: URL
  try { url = new URL(env.MAIL_PUBLIC_ORIGIN ?? '') } catch { throw new Error('Mail public origin is not configured') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port || !url.hostname.includes('.') || url.hostname.endsWith('.invalid')) throw new Error('Mail public origin is invalid')
  const name = (env.MAIL_BRAND_NAME ?? 'GPTibo').trim()
  if (!name || name.length > 80 || name.includes('__RECHARGE_') || Array.from(name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('Mail brand name is invalid')
  return { name, origin: url.origin }
}

/** Apply trusted brand markers BEFORE customer values, so their text is never reinterpreted. */
export function brandEmailMessage(env: MailBrandEnv, template: EmailMessage): EmailMessage {
  const { name, origin } = mailBrand(env)
  return replaceBrand(template, { BRAND_NAME:name, BRAND_LOGO:origin + '/email-logo.png', BRAND_ORDERS_URL:origin + '/orders', BRAND_WORKSPACE_URL:origin + '/join', BRAND_ADMIN_URL:origin + '/admin' })
}
function replaceBrand(template: EmailMessage, fields: Record<string, string>): EmailMessage {
  const pattern = /__RECHARGE_(BRAND_[A-Z_]+)__/g
  const replace = (value: string, html = false) => value.replace(pattern, (marker, key: string) => fields[key] === undefined ? marker : html ? escapeHtml(fields[key]) : fields[key])
  return { subject:replace(template.subject), html:replace(template.html, true), text:replace(template.text) }
}
function brandedTemplate(kind: keyof typeof emailTemplates, env?: MailBrandEnv) {
  // Pure preview calls retain their historical demo defaults; every send path supplies env.
  return env ? brandEmailMessage(env, emailTemplates[kind]) : replaceBrand(emailTemplates[kind], platformEmailFields)
}

/** Freeze the entire provider body before the first attempt; persist this exact string for retries. */
export function emailPayload(env: Pick<Env, 'RESEND_FROM'>, to: string, message: EmailMessage): string {
  const body = JSON.stringify({ from: env.RESEND_FROM, to:[to], ...message })
  validatePayload(body)
  return body
}
function validatePayload(body: string) {
  if (body.length > 262144) throw new Error('Mail payload is too large')
  const value = JSON.parse(body) as { from?:unknown; to?:unknown; subject?:unknown; html?:unknown; text?:unknown }
  if (!value || typeof value.from !== 'string' || !value.from.trim() || /[\r\n]/.test(value.from) || !Array.isArray(value.to) || value.to.length !== 1 || typeof value.to[0] !== 'string' || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.to[0]) || typeof value.subject !== 'string' || !value.subject || /[\r\n]/.test(value.subject) || typeof value.html !== 'string' || !value.html || typeof value.text !== 'string' || !value.text) throw new Error('Mail payload is invalid')
}

/** Send persisted bytes unchanged, including the original sender after a configuration rotation. */
export async function sendFrozenEmail(env: Pick<Env, 'RESEND_API_KEY'>, body: string, idempotencyKey: string): Promise<string> {
  if (!env.RESEND_API_KEY || !idempotencyKey || /[\r\n]/.test(idempotencyKey)) throw new Error('Mail delivery is not configured')
  validatePayload(body)
  const response = await fetch('https://api.resend.com/emails', {
    method:'POST', redirect:'manual',
    headers:{ Authorization:'Bearer ' + env.RESEND_API_KEY, 'Content-Type':'application/json', 'Idempotency-Key':idempotencyKey },
    body, signal:AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error('delivery failed')
  const result = JSON.parse(await boundedResponseText(response, 16384)) as {id?:unknown} | null
  if (!result || typeof result.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.id)) throw new Error('Mail result not confirmed')
  return result.id
}

export function membershipDeliveryMessage(kind: 'link' | 'cdk', orderId: string, value: string, instructions: string, plan?: string, env?: MailBrandEnv) {
  const claimUrl = plan === 'gmail-account' ? null : membershipClaimUrl(value)
  if (plan !== 'gmail-account' && kind === 'link' && !claimUrl) throw new Error('Invalid membership claim link')
  const duo = plan === 'duolingo-12m' || kind === 'cdk'
  const template = brandedTemplate(plan === 'gmail-account' ? 'delivery-gmail' : claimUrl && duo ? 'delivery-duolingo-link' : kind === 'link' ? 'delivery-link' : 'delivery-cdk', env)
  const values: Record<string, string> = { __RECHARGE_DELIVERY_ORDER__: orderId, __RECHARGE_DELIVERY_VALUE__: value, __RECHARGE_DELIVERY_URL__: claimUrl ?? '', __RECHARGE_DELIVERY_INSTRUCTIONS__: instructions }
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
  const pattern = /__RECHARGE_DELIVERY_(?:ORDER|VALUE|URL|INSTRUCTIONS)__/g
  return { subject: template.subject, html: template.html.replace(pattern, key => key === '__RECHARGE_DELIVERY_VALUE__' && claimUrl ? `<a href="${escape(claimUrl)}" style="color:#6256cf;word-break:break-all">${escape(value)}</a>` : escape(values[key]).replaceAll('\n', '<br />')), text: template.text.replace(pattern, key => values[key]) }
}

export type RechargeReminderDetails = { orderId: string; planName: string; contacts: string }
export function rechargeReminderMessage(details: RechargeReminderDetails, env?: MailBrandEnv) {
  const values: Record<string, string> = {
    '__RECHARGE_REMINDER_ORDER_ID__': details.orderId,
    '__RECHARGE_REMINDER_PLAN_NAME__': details.planName,
    '__RECHARGE_REMINDER_CONTACTS__': details.contacts,
  }
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]!)
  const template = brandedTemplate('recharge-reminder', env)
  // One pass prevents customer/partner text from being interpreted as another placeholder.
  const pattern = /__RECHARGE_REMINDER_(?:ORDER_ID|PLAN_NAME|CONTACTS)__/g
  return { subject: template.subject, html: template.html.replace(pattern, key => escape(values[key]).replaceAll('\n', '<br />')), text: template.text.replace(pattern, key => values[key]) }
}

export async function sendRechargeReminderEmail(env: Env, to: string, message: ReturnType<typeof rechargeReminderMessage>, id: string) {
  await sendEmail(env, to, message, 'recharge-reminder/' + id)
}

export async function sendMembershipPreviewEmail(env: Env, to: string, message: ReturnType<typeof membershipDeliveryMessage>, id: string) {
  return sendEmail(env, to, message, 'membership-preview/' + id)
}

export function partnerInvitationMessage(env?: MailBrandEnv) {
  return brandedTemplate('partner-welcome', env)
}

export function verificationMessage(kind: VerificationKind, code: string, env?: MailBrandEnv) {
  // Only server-generated codes enter the pre-rendered HTML; never accept arbitrary markup.
  if (!/^\d{6}$/.test(code)) throw new Error('Invalid verification code')
  const template = brandedTemplate(kind, env)
  return {
    subject: template.subject,
    html: template.html.replaceAll('__RECHARGE_VERIFICATION_CODE__', code),
    text: template.text.replaceAll('__RECHARGE_VERIFICATION_CODE__', code),
  }
}

export async function sendVerificationEmail(env: Env, kind: VerificationKind, to: string, code: string, challenge: string) {
  await sendEmail(env, to, verificationMessage(kind, code, env), kind + '/' + challenge)
}

export async function sendPartnerInvitationEmail(env: Env, to: string, invitationId: string) {
  await sendEmail(env, to, partnerInvitationMessage(env), 'partner-welcome/' + invitationId)
}

async function sendEmail(env: Env, to: string, message: EmailMessage, idempotencyKey: string) {
  return sendFrozenEmail(env, emailPayload(env, to, message), idempotencyKey)
}

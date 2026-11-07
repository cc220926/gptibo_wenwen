import { ApiError, body, json, type Env } from './platform.ts'
import type { Partner } from './partner-auth.ts'

export type PayoutAccount = { phone: string; name: string; version: number }
export const payoutAccount = (env: Env, partnerId: string) => env.INTEREST_DB.prepare('SELECT phone,name,version FROM partner_payout_accounts WHERE partner_id=?').bind(partnerId).first<PayoutAccount>()

export async function savePayoutAccount(request: Request, env: Env, partner: Partner) {
  if (request.method !== 'POST') throw new ApiError('请求方式不支持。', 405)
  const data = await body(request)
  const phone = typeof data.phone === 'string' ? data.phone.trim() : ''
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const nameChars = Array.from(name)
  const hasControl = nameChars.some(char => { const point = char.codePointAt(0)!; return point < 32 || (point >= 127 && point <= 159) })
  if (!/^1[3-9][0-9]{9}$/.test(phone) || !name || nameChars.length > 50 || hasControl || !Number.isSafeInteger(data.version) || Number(data.version) < 0) throw new ApiError('请填写有效的支付宝手机号和收款人姓名（最多 50 字）。')
  const version = Number(data.version), event = crypto.randomUUID(), db = env.INTEREST_DB
  await db.batch([
    db.prepare(`INSERT INTO partner_payout_accounts(partner_id,phone,name,version,last_event_id)
      SELECT id,?,?,1,? FROM partners WHERE id=? AND active=1 AND auth_version=?
        AND (?=0 OR EXISTS(SELECT 1 FROM partner_payout_accounts a WHERE a.partner_id=partners.id AND a.version=?))
      ON CONFLICT(partner_id) DO UPDATE SET phone=excluded.phone,name=excluded.name,version=partner_payout_accounts.version+1,last_event_id=excluded.last_event_id WHERE partner_payout_accounts.version=?`)
      .bind(phone, name, event, partner.id, partner.auth_version, version, version, version),
    db.prepare("INSERT INTO admin_audit(id,target_id,action,note,created_at) SELECT ?,partner_id,'partner-payout-account',?,? FROM partner_payout_accounts WHERE partner_id=? AND last_event_id=?")
      .bind(event, '更新支付宝收款信息；版本 ' + (version + 1), Date.now(), partner.id, event),
  ])
  if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(event).first()) throw new ApiError('收款信息或账号已更新，请刷新后重新确认。', 409)
  return json({ ok: true })
}

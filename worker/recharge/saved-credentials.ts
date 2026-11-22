import { ApiError, hash, type Env } from '../platform.ts'
import { seal, unseal, vaultReady } from '../fulfillment/vault.ts'
import { RECHARGE_RETENTION_UNAVAILABLE } from '../../shared/recharge-credential.ts'

export class RechargeRetentionUnavailable extends ApiError {
  readonly code = RECHARGE_RETENTION_UNAVAILABLE
  constructor() {
    super('加密保存暂不可用，本次充值尚未提交。可以不保存资料，在原订单继续。', 503)
  }
}

const RETENTION_MS = 30 * 86400000
export type SavedCredential = { order_id: string; attempt_id: string; encrypted_request: string; saved_at: number; retain_until: number; credential_expires_at: number | null }
export const retainedCredential = (env: Env, id: string) => env.INTEREST_DB.prepare('SELECT * FROM recharge_saved_credentials WHERE order_id=?').bind(id).first<SavedCredential>()
export const retainedMetadata = (env: Env, id: string) => env.INTEREST_DB.prepare('SELECT order_id,attempt_id,saved_at,retain_until,credential_expires_at FROM recharge_saved_credentials WHERE order_id=?').bind(id).first<Omit<SavedCredential, 'encrypted_request'>>()
export const credentialRetentionEnabled = (env: Env) => env.RECHARGE_SAVED_CREDENTIALS_ENABLED === 'true'
export const canRetainCredential = async (env: Env) => credentialRetentionEnabled(env) && await vaultReady(env)
const context = (order: string, attempt: string) => 'recharge-request:' + order + ':' + attempt

export async function retainedRequest(env: Env, saved: SavedCredential, expectedHash: string) {
  if (saved.retain_until <= Date.now()) throw new ApiError('原资料已超过保存期限，请重新提交 Session。', 409)
  try {
    const raw = await unseal(env, saved.encrypted_request, context(saved.order_id, saved.attempt_id))
    if (await hash(raw) !== expectedHash) throw new Error('Snapshot mismatch')
    return raw
  } catch { throw new ApiError('原资料暂时无法读取，请重新提交 Session 或联系客服。', 409) }
}
export async function retainedStatement(env: Env, order: string, attempt: string, raw: string, expires: number | null, previous?: SavedCredential) {
  const savedAt = previous?.saved_at ?? Date.now(), until = previous?.retain_until ?? savedAt + RETENTION_MS
  let encrypted: string
  try { encrypted = await seal(env, raw, context(order, attempt)) }
  catch { throw new RechargeRetentionUnavailable() }
  return env.INTEREST_DB.prepare(`INSERT INTO recharge_saved_credentials(order_id,attempt_id,encrypted_request,saved_at,retain_until,credential_expires_at)
    SELECT order_id,id,?,?,?,? FROM recharge_redemptions WHERE id=? AND order_id=?
    ON CONFLICT(order_id) DO UPDATE SET attempt_id=excluded.attempt_id,encrypted_request=excluded.encrypted_request,saved_at=excluded.saved_at,retain_until=excluded.retain_until,credential_expires_at=excluded.credential_expires_at`)
    .bind(encrypted, savedAt, until, expires, attempt, order)
}
export async function purgeRetainedCredentials(env: Env) {
  await env.INTEREST_DB.prepare(`DELETE FROM recharge_saved_credentials WHERE (
      ?=1 OR retain_until<=? OR EXISTS (
        SELECT 1 FROM recharge_redemptions a
        WHERE a.id=recharge_saved_credentials.attempt_id AND a.order_id=recharge_saved_credentials.order_id AND a.status='rejected'
      )
    )
    AND NOT EXISTS(SELECT 1 FROM recharge_orders t WHERE t.order_id=recharge_saved_credentials.order_id AND t.lease_until>?)`).bind(Number(!credentialRetentionEnabled(env)), Date.now(), Date.now()).run()
}

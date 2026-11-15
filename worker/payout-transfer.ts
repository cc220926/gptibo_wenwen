import { eligibleSql, profitSql } from './finance.ts'
import { ApiError, body, json, type Env } from './platform.ts'

type Payout = { id: string; version: number; status: string; reviewed_at: number | null; transfer_state: string; transfer_id: string | null }
function text(v: unknown, max: number, label: string) {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw new ApiError(`请填写有效的${label}。`)
  return v.trim()
}
// Executed again inside the same DB transaction that claims transfer permission.
// Validate the snapshot, reservations and current finance, not only its old total.
const financeGuard = `
  AND EXISTS(SELECT 1 FROM partner_payout_items WHERE payout_id=partner_payouts.id)
  AND NOT EXISTS(SELECT 1 FROM partner_payout_items i LEFT JOIN orders o ON o.id=i.order_id
    WHERE i.payout_id=partner_payouts.id AND (o.id IS NULL OR o.payout_id IS NOT partner_payouts.id
      OR o.partner_id IS NOT partner_payouts.partner_id OR NOT (${eligibleSql('o')}) OR i.profit_cents<>${profitSql('o')}))
  AND (SELECT COUNT(*) FROM orders WHERE payout_id=partner_payouts.id)=(SELECT COUNT(*) FROM partner_payout_items WHERE payout_id=partner_payouts.id)
  AND gross_cents=(SELECT SUM(profit_cents) FROM partner_payout_items WHERE payout_id=partner_payouts.id)
  AND deduction_cents=COALESCE((SELECT SUM(amount_cents) FROM partner_payout_debit_items WHERE payout_id=partner_payouts.id),0)
  AND amount_cents=gross_cents-deduction_cents AND amount_cents>0
  AND NOT EXISTS(SELECT 1 FROM partner_payout_debit_items i LEFT JOIN partner_debits d ON d.id=i.debit_id
    WHERE i.payout_id=partner_payouts.id AND (d.id IS NULL OR d.payout_id IS NOT partner_payouts.id OR d.partner_id IS NOT partner_payouts.partner_id OR d.amount_cents<>i.amount_cents))
  AND (SELECT COUNT(*) FROM partner_debits WHERE payout_id=partner_payouts.id)=(SELECT COUNT(*) FROM partner_payout_debit_items WHERE payout_id=partner_payouts.id)
  AND NOT EXISTS(SELECT 1 FROM partner_debits WHERE partner_id=partner_payouts.partner_id AND payout_id IS NULL)
  AND NOT EXISTS(SELECT 1 FROM orders h JOIN partner_payouts hp ON hp.id=h.payout_id LEFT JOIN recharge_orders t ON t.order_id=h.id
    WHERE h.partner_id=partner_payouts.partner_id AND hp.status='paid' AND (h.refund_hold=1 OR (h.payment_status='paid' AND t.financial_hold=1)))`

export async function handlePayout(request: Request, env: Env, id: string, verify: () => Promise<void>) {
  const db = env.INTEREST_DB, data = await body(request), note = text(data.note, 300, '处理说明'), action = String(data.action)
  if (!['approve', 'start-transfer', 'paid', 'rejected', 'mark-unknown', 'confirm-not-transferred'].includes(action)) throw new ApiError('处理方式无效。')
  const reference = action === 'paid' ? text(data.reference, 100, '线下付款流水号').toUpperCase() : ''
  const ps = await db.prepare('SELECT * FROM partner_payouts WHERE id=?').bind(id).first<Payout>()
  if (!ps || ps.status !== 'pending' || ps.version !== data.version) throw new ApiError('结算申请已处理，请刷新。', 409)
  const inFlight = ['transferring', 'unknown'].includes(ps.transfer_state)
  if (action === 'approve' || action === 'start-transfer') {
    if (ps.transfer_state !== 'idle' || (action === 'approve' ? ps.reviewed_at !== null : ps.reviewed_at === null)) throw new ApiError('申请状态已变化。已领取的转账不可重复发起，请核对转账结果。', 409)
    await verify() // Fail closed on unavailable/unverifiable supplier finance.
    const event = crypto.randomUUID(), now = Date.now(), starting = action === 'start-transfer'
    const change = starting
      ? "transfer_state='transferring',transfer_id=?,transfer_started_at=?"
      : 'review_token=?,reviewed_at=?'
    await db.batch([
      db.prepare(`UPDATE partner_payouts SET ${change},note=?,version=version+1 WHERE id=? AND status='pending' AND transfer_state='idle' AND reviewed_at IS ${starting ? 'NOT ' : ''}NULL AND version=? ${financeGuard}`).bind(event, now, note, id, ps.version),
      db.prepare(`INSERT INTO admin_audit(id,target_id,action,note,created_at) SELECT ?,id,?,?,? FROM partner_payouts WHERE id=? AND status='pending' AND version=? AND ${starting ? 'transfer_id' : 'review_token'}=?`).bind(event, starting ? 'payout-transfer-start' : 'payout-review', `${env.ADMIN_USERNAME}: ${note}`, now, id, ps.version + 1, event),
    ])
    if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(event).first()) throw new ApiError('申请已变化或收益存在退款/抵扣，请刷新核对；不要转账。', 409)
    return json({ ok: true, ...(starting ? { attemptId: event } : {}) })
  }
  if (action === 'rejected' && ps.transfer_state !== 'idle') throw new ApiError('转账可能已发生，不能直接退回。请核对账单后登记成功或确认未转出。', 409)
  if (action !== 'rejected' && (!ps.reviewed_at || !inFlight || data.attemptId !== ps.transfer_id)) throw new ApiError('请先领取转账处理权，或刷新后核对已有转账结果。', 409)
  if (action === 'mark-unknown' && ps.transfer_state !== 'transferring') throw new ApiError('当前已进入核对流程，请刷新。', 409)
  if (action === 'paid' && data.transferConfirmed !== true) throw new ApiError('请确认账单显示转账已成功，再登记真实流水。')
  let evidence = ''
  if (action === 'confirm-not-transferred') {
    if (data.confirmedNotTransferred !== true) throw new ApiError('必须核对账单确认未转出，结果不明不能释放资金。')
    evidence = text(data.evidence, 500, '未转出核验依据')
    if (evidence.length < 10) throw new ApiError('请详细填写账单核对依据（至少 10 字）。')
  }
  const event = crypto.randomUUID(), now = Date.now()
  const status = action === 'paid' ? 'paid' : action === 'mark-unknown' ? 'pending' : 'rejected'
  const state = action === 'paid' ? 'succeeded' : action === 'mark-unknown' ? 'unknown' : 'not_sent'
  // Audit is a single-use transaction claim. All state, receipt and reservation
  // mutations depend on it; any DB failure rolls back the entire batch.
  await db.batch([
    db.prepare(`INSERT INTO admin_audit(id,target_id,action,note,created_at) SELECT ?,id,?,?,? FROM partner_payouts WHERE id=? AND status='pending' AND version=? AND transfer_state=? AND transfer_id IS ?
      AND (?='' OR NOT EXISTS(SELECT 1 FROM partner_transfer_receipts WHERE reference=?))`).bind(event, action === 'mark-unknown' ? 'payout-transfer-unknown' : 'payout-handle', `${env.ADMIN_USERNAME}: ${action}; ${note}${evidence ? '; 核验依据: ' + evidence : ''}`, now, id, ps.version, ps.transfer_state, ps.transfer_id, reference, reference),
    db.prepare(`INSERT INTO partner_transfer_receipts(reference,payout_id,created_at) SELECT ?,?,? WHERE ?<>'' AND EXISTS(SELECT 1 FROM admin_audit WHERE id=?)`).bind(reference, id, now, reference, event),
    db.prepare(`UPDATE partner_payouts SET status=?,transfer_state=?,note=?,reference=?,handled_at=?,transfer_resolved_at=?,version=version+1 WHERE id=? AND EXISTS(SELECT 1 FROM admin_audit WHERE id=?)`).bind(status, state, note, reference, status === 'pending' ? null : now, status === 'pending' ? null : now, id, event),
    db.prepare("UPDATE partner_debits SET payout_id=NULL WHERE payout_id=? AND EXISTS(SELECT 1 FROM admin_audit WHERE id=?) AND EXISTS(SELECT 1 FROM partner_payouts WHERE id=? AND status='rejected')").bind(id, event, id),
    db.prepare("UPDATE orders SET payout_id=NULL WHERE payout_id=? AND EXISTS(SELECT 1 FROM admin_audit WHERE id=?) AND EXISTS(SELECT 1 FROM partner_payouts WHERE id=? AND status='rejected')").bind(id, event, id),
  ])
  if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(event).first()) throw new ApiError('申请已变化或流水号已登记，资金未释放，请刷新核对。', 409)
  return json({ ok: true })
}

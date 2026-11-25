import { productNameForId } from '../../shared/email-products'
export { useResource as usePartnerData } from '@/lib/use-resource'

export type Partner = { referralOrigin?: string; storefront_url?: string; login_url?: string; id: string; slug: string; name: string; email: string; active: number; version: number; parent_id?: string | null; can_recruit?: boolean; has_children?: boolean; has_upstream_earnings?: boolean }
export type Offer = { saleIssue?: string; id: string; product_id: string; name: string; cost_cents: number; price_cents: number; version: number; enabled: number; renewal_only: number }
export type Payout = { transfer_state: 'idle' | 'transferring' | 'unknown' | 'succeeded' | 'not_sent'; transfer_id: string | null; id: string; partner_name?: string; amount_cents: number; gross_cents: number; deduction_cents: number; reviewed_at: number | null; status: string; recipient: string; note: string; reference: string; created_at: number; version: number }
export type PayoutAccount = { phone: string; name: string; version: number }
export type Dashboard = { partner: Partner; payoutAccount: PayoutAccount; capabilities?: { multiStore?: boolean; tickets?: boolean; notifications?: boolean }; plans: Offer[]; stats: { total: number; demo_profit: number; available: number; minimum: number; debt: number; withdrawalHeld: boolean; nextPayoutAt: number | null; payoutCoolingDown: boolean }; totals: { pending: number; paid: number }; payouts: Payout[]; mailReady: boolean }
export const money = (cents: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(cents / 100)
export const date = (timestamp: number) => new Date(timestamp).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
export const offerName = (p: Pick<Offer, 'product_id' | 'name'>) => p.product_id === 'chatgpt' ? 'ChatGPT ' + p.name : p.product_id === 'codex-sms' ? 'Codex 接码' : productNameForId(p.product_id) + ' · ' + p.name
export const toCents = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim()) ? Math.round(Number(v) * 100) : NaN
export const payoutLabel = (status: string, reviewed?: number | null, transferState?: string) => status === 'pending' ? transferState === 'unknown' ? '待核对转账' : transferState === 'transferring' ? '转账处理中' : reviewed ? '待领取转账' : '待审核' : ({ paid: '已提现', rejected: '已退回' })[status] ?? status

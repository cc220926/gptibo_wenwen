export const MANUAL_DELIVERY_STATES = {
  queued: '待人工交付',
  running: '人工处理中',
  held: '已暂停交付',
  review: '需人工核对',
  delivered: '已交付',
} as const

export type ManualDeliveryState = keyof typeof MANUAL_DELIVERY_STATES
export type ManualDeliveryRow = {
  id: string; productName: string; planName: string; customerEmail: string | null
  priceCents: number; createdAt: number; updatedAt: number; state: ManualDeliveryState
  refundHold: boolean; refundedCents: number; redemptionBlocked: boolean
}
export type ManualDeliveryQueue = {
  rows: ManualDeliveryRow[]; total: number; page: number
  counts: Record<ManualDeliveryState, number>
}

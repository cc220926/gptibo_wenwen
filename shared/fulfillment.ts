export type DeliveryKind = 'stock' | 'manual'
export type ServiceProduct = { id: string; name: string; category: string; description: string; version: number; hidden: number }
export type ServiceTask = { provider?: 'muse'; supplierState?: string; kind: DeliveryKind; state: string; productId: string; productName: string; expiresAt: number; mailState: string }
export const isServicePlan = (id: string) => /^custom-[a-f0-9-]+$/.test(id)

import { DEFAULT_PRODUCT_ORDER, type StorefrontProductId } from '../shared/product-order.ts'
import { ApiError, body, json, type Env } from './platform.ts'

export type PlatformProductVisibility = { hiddenProductIds: StorefrontProductId[]; version: number }

export async function platformProductVisibility(env: Env): Promise<PlatformProductVisibility> {
  const row = await env.INTEREST_DB.prepare('SELECT hidden_product_ids,version FROM platform_product_visibility WHERE id=1')
    .first<{ hidden_product_ids: string; version: number }>()
  if (!row) throw new ApiError('商品上下架设置暂不可用。', 503)
  return { hiddenProductIds: JSON.parse(row.hidden_product_ids) as StorefrontProductId[], version: row.version }
}

export async function platformProductHidden(env: Env, productId: string): Promise<boolean> {
  return Boolean(await env.INTEREST_DB.prepare('SELECT 1 FROM platform_product_visibility v,json_each(v.hidden_product_ids) h WHERE v.id=1 AND h.value=?')
    .bind(productId).first())
}

export async function platformProductVisibilityRoute(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET') return json(await platformProductVisibility(env))
  if (request.method !== 'POST') throw new ApiError('请求方式不支持。', 405)
  const data = await body(request)
  if (!Array.isArray(data.hiddenProductIds) || new Set(data.hiddenProductIds).size !== data.hiddenProductIds.length ||
      !data.hiddenProductIds.every(id => DEFAULT_PRODUCT_ORDER.some(known => known === id))) throw new ApiError('下架商品列表无效或重复。')
  if (!Number.isSafeInteger(data.version) || Number(data.version) < 0) throw new ApiError('商品设置版本无效，请刷新后重试。')
  if (typeof data.note !== 'string' || !data.note.trim() || data.note.trim().length > 500) throw new ApiError('请填写 1–500 字的修改说明。')
  const current = await platformProductVisibility(env)
  if (current.version !== data.version) throw new ApiError('商品设置已更新，请刷新后重试。', 409)
  const hiddenProductIds = data.hiddenProductIds as StorefrontProductId[]
  const eventId = crypto.randomUUID(), now = Date.now(), db = env.INTEREST_DB
  await db.batch([
    db.prepare('UPDATE platform_product_visibility SET hidden_product_ids=?,version=version+1,change_id=?,updated_at=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(hiddenProductIds), eventId, now, current.version),
    db.prepare("INSERT INTO admin_audit(id,action,target_id,note,created_at) SELECT ?,'platform-product-visibility','platform',?,? FROM platform_product_visibility WHERE id=1 AND change_id=?")
      .bind(eventId, `${env.ADMIN_USERNAME}: ${JSON.stringify(current.hiddenProductIds)}→${JSON.stringify(hiddenProductIds)}; ${data.note.trim()}`, now, eventId),
  ])
  if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(eventId).first()) throw new ApiError('商品设置已更新，请刷新后重试。', 409)
  return json(await platformProductVisibility(env))
}

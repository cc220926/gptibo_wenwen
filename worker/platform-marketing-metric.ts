import { ApiError, body, json, type Env } from './platform.ts'
import type { MarketingMetric } from '../shared/marketing-metric.ts'

type Settings = MarketingMetric & { version: number }

export async function platformMarketingMetric(env: Env): Promise<Settings> {
  const row = await env.INTEREST_DB.prepare('SELECT enabled,display_text,display_count,version FROM platform_marketing_metric WHERE id=1')
    .first<{ enabled: number; display_text: string; display_count: number; version: number }>()
  if (!row) throw new ApiError('展示信息设置暂不可用。', 503)
  return { enabled: row.enabled === 1, displayText: row.display_text, displayCount: row.display_count, version: row.version }
}

export async function platformMarketingMetricRoute(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET') return json(await platformMarketingMetric(env))
  if (request.method !== 'POST') throw new ApiError('请求方式不支持。', 405)
  const data = await body(request)
  if (typeof data.enabled !== 'boolean') throw new ApiError('展示状态无效。')
  if (typeof data.displayText !== 'string' || data.displayText.trim() !== data.displayText ||
    data.displayText.length < 1 || data.displayText.length > 120 ||
    data.displayText.split('{count}').length !== 2 || /[\r\n<>]/.test(data.displayText)) throw new ApiError('展示文案需为 1–120 字，且包含一次 {count}。')
  if (typeof data.displayCount !== 'number' || !Number.isSafeInteger(data.displayCount) || data.displayCount < 0 || data.displayCount > 999999) throw new ApiError('展示数值需为 0–999999 的整数。')
  if (typeof data.version !== 'number' || !Number.isSafeInteger(data.version) || data.version < 0) throw new ApiError('设置版本无效，请刷新后重试。')
  const current = await platformMarketingMetric(env)
  if (current.version !== data.version) throw new ApiError('展示设置已更新，请刷新后重试。', 409)
  const eventId = crypto.randomUUID(), now = Date.now(), db = env.INTEREST_DB
  await db.batch([
    db.prepare('UPDATE platform_marketing_metric SET enabled=?,display_text=?,display_count=?,version=version+1,change_id=?,updated_at=? WHERE id=1 AND version=?')
      .bind(data.enabled ? 1 : 0, data.displayText, data.displayCount, eventId, now, current.version),
    db.prepare("INSERT INTO admin_audit(id,action,target_id,note,created_at) SELECT ?,'platform-marketing-metric','platform',?,? FROM platform_marketing_metric WHERE id=1 AND change_id=?")
      .bind(eventId, `${env.ADMIN_USERNAME}: ${JSON.stringify(current)}→${JSON.stringify({ enabled: data.enabled, displayText: data.displayText, displayCount: data.displayCount })}`, now, eventId),
  ])
  if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(eventId).first()) throw new ApiError('展示设置已更新，请刷新后重试。', 409)
  return json(await platformMarketingMetric(env))
}

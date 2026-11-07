import { ApiError, json, type Env } from './platform.ts'
import { resolvePartner } from './partners.ts'
import { CUSTOMER_HISTORY_PAGE_SIZE, isMaskedCustomerEmail } from '../shared/customer-history.ts'

export async function customerHistory(request: Request, env: Env) {
  if (request.method !== 'GET') throw new ApiError('请求方式不支持。', 405)
  const url = new URL(request.url)
  if (url.searchParams.get('product') !== 'chatgpt') throw new ApiError('商品无效。')
  const rawCursor = url.searchParams.get('cursor') ?? '0'
  const cursor = Number(rawCursor)
  if (!/^(0|[1-9]\d*)$/.test(rawCursor) || !Number.isSafeInteger(cursor)) throw new ApiError('翻页参数无效。')
  const partner = await resolvePartner(env, url.searchParams.get('partner'))
  const rows = (await env.INTEREST_DB.prepare('SELECT id,masked_email FROM customer_history WHERE shop_id=? AND id>? ORDER BY id LIMIT ?')
    .bind(partner?.id ?? 'platform', cursor, CUSTOMER_HISTORY_PAGE_SIZE + 1)
    .all<{ id: number; masked_email: string }>()).results
  // Fail closed even if private database contents bypassed the import script.
  if (!Array.isArray(rows) || rows.some((row, i) => !Number.isSafeInteger(row.id) || row.id <= (i ? rows[i - 1].id : cursor) || !isMaskedCustomerEmail(row.masked_email))) {
    throw new ApiError('历史客户展示暂不可用。', 503)
  }
  const page = rows.slice(0, CUSTOMER_HISTORY_PAGE_SIZE)
  return json({ emails: page.map(row => row.masked_email), nextCursor: rows.length > CUSTOMER_HISTORY_PAGE_SIZE ? page.at(-1)!.id : null })
}

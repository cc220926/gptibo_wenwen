import { decode, encode, hasPngSignature } from 'fast-png'
import type { StoreBranding } from '../shared/store-branding.ts'
import { announcementContentLimit, announcementTitleLimit, type AnnouncementSettings } from '../shared/announcements.ts'
import { ApiError, body, json, type Env } from './platform.ts'

export async function platformBranding(env: Env): Promise<StoreBranding> {
  const row = await env.INTEREST_DB.prepare('SELECT name,logo,page_title AS pageTitle,headline,description,version FROM platform_branding WHERE id=1').first<StoreBranding>()
  if (!row) throw new ApiError('主站店铺形象暂不可用。', 503)
  return row
}

export async function platformAnnouncement(env: Env): Promise<AnnouncementSettings> {
  const row = await env.INTEREST_DB.prepare('SELECT enabled,placement,title,content,version FROM platform_announcements WHERE id=1').first<Omit<AnnouncementSettings, 'enabled'> & { enabled: number }>()
  if (!row) throw new ApiError('主站公告暂不可用。', 503)
  return { ...row, enabled: row.enabled === 1 }
}

function text(value: unknown, limit: number, label: string, multiline = false) {
  if (typeof value !== 'string' || value.length > limit * 2 || Array.from(value.trim()).length > limit ||
      Array.from(value).some(character => { const code = character.charCodeAt(0); return code === 127 || (code < 32 && !(multiline && [9, 10, 13].includes(code))) })) throw new ApiError(`${label}无效，最多 ${limit} 个字。`)
  return value.trim()
}

function version(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ApiError('设置版本无效，请刷新后重试。')
  return Number(value)
}

// Only bounded PNG pixels survive. Never retain uploaded metadata or trailing bytes.
export function cleanPlatformLogo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 350000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new ApiError('请通过上传按钮选择有效的 PNG / JPG Logo。')
  try {
    const raw = Uint8Array.from(atob(value.slice(value.indexOf(',') + 1)), char => char.charCodeAt(0))
    if (raw.length > 256 * 1024 || raw.length < 33 || !hasPngSignature(raw)) throw new Error()
    const view = new DataView(raw.buffer)
    const width = view.getUint32(16), height = view.getUint32(20)
    if (view.getUint32(8) !== 13 || new TextDecoder().decode(raw.slice(12, 16)) !== 'IHDR' || !width || !height || width > 256 || height > 256) throw new Error()
    const image = decode(raw, { checkCrc: true })
    const safe = encode({ width: image.width, height: image.height, data: image.data, channels: image.channels, depth: image.depth, palette: image.palette, transparency: image.transparency })
    if (safe.length > 256 * 1024) throw new Error()
    return 'data:image/png;base64,' + btoa(Array.from(safe, byte => String.fromCharCode(byte)).join(''))
  } catch { throw new ApiError('Logo 图片无效或过大，请重新上传。') }
}

async function update(env: Env, table: 'platform_branding' | 'platform_announcements', fields: string, values: (string | number)[], expected: number) {
  const id = crypto.randomUUID(), now = Date.now()
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare(`UPDATE ${table} SET ${fields},version=version+1,change_id=?,updated_at=? WHERE id=1 AND version=?`).bind(...values, id, now, expected),
    env.INTEREST_DB.prepare(`INSERT INTO admin_audit(id,action,target_id,note,created_at) SELECT ?,?,'platform',?,? FROM ${table} WHERE id=1 AND change_id=?`)
      .bind(id, table === 'platform_branding' ? 'platform-branding' : 'platform-announcement', `${env.ADMIN_USERNAME}: 保存主站商店设置`, now, id),
  ])
  if (!await env.INTEREST_DB.prepare('SELECT id FROM admin_audit WHERE id=?').bind(id).first()) throw new ApiError('设置已更新，请刷新后重试。', 409)
}

// The commerce router authenticates administrators before dispatching here.
export async function platformBrandingRoute(request: Request, env: Env, upload = false) {
  if (request.method === 'GET' && !upload) return json(await platformBranding(env))
  if (request.method !== 'POST') throw new ApiError('请求方式不支持。', 405)
  const data = await body(request, 360000)
  if (upload) return json({ logo: cleanPlatformLogo(data.logo) })
  const expected = version(data.version)
  const name = text(data.name, 32, '店铺名称'), pageTitle = text(data.pageTitle, 80, '网页标题')
  const headline = text(data.headline, 80, '首页标题'), description = text(data.description, 200, '首页简介')
  const logo = data.logo === '' ? '' : cleanPlatformLogo(data.logo)
  await update(env, 'platform_branding', 'name=?,logo=?,page_title=?,headline=?,description=?', [name, logo, pageTitle, headline, description], expected)
  return json(await platformBranding(env))
}

export async function platformAnnouncementRoute(request: Request, env: Env) {
  if (request.method === 'GET') return json(await platformAnnouncement(env))
  if (request.method !== 'POST') throw new ApiError('请求方式不支持。', 405)
  const data = await body(request, 32768), expected = version(data.version)
  if (typeof data.enabled !== 'boolean' || typeof data.placement !== 'string' || !['home', 'product', 'both'].includes(data.placement)) throw new ApiError('公告状态或展示位置无效。')
  const title = text(data.title, announcementTitleLimit, '公告标题'), content = text(data.content, announcementContentLimit, '公告内容', true)
  if (data.enabled && (!title || !content)) throw new ApiError('启用公告前，请填写标题和内容。')
  await update(env, 'platform_announcements', 'enabled=?,placement=?,title=?,content=?', [Number(data.enabled), String(data.placement), title, content], expected)
  return json(await platformAnnouncement(env))
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { encode, decode } from 'fast-png'
import { customerFixture } from './customer-fixture.ts'
import { emptyStoreBranding } from '../shared/store-branding.ts'
import { emptyAnnouncement, announcementHiddenToday, hideAnnouncementToday } from '../shared/announcements.ts'

const brandingPath = '/api/admin/branding'
const announcementPath = '/api/admin/announcement'
const branding = { ...emptyStoreBranding, name: ' 星河主站 ', pageTitle: '星河订阅', headline: '欢迎来到星河', description: '按需选择服务' }
const announcement = { ...emptyAnnouncement, enabled: true, placement: 'both', title: '主站公告', content: '主站服务安排\n第二行' }
const png = () => Buffer.from(encode({ width: 2, height: 2, data: new Uint8Array(16).fill(255), text: { private: 'remove this metadata' } }))
const dataUrl = (bytes: Uint8Array) => 'data:image/png;base64,' + Buffer.from(bytes).toString('base64')

test('platform settings require admin, same-origin writes, valid input and revisions', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const partner = await s.agent('shop')
  for (const [path, payload] of [[brandingPath, branding], [announcementPath, announcement], [brandingPath + '/logo', { logo: dataUrl(png()) }]] as const) {
    assert.equal((await s.request(path, payload)).status, 401)
    assert.equal((await s.request(path, payload, partner.cookie)).status, 401)
    assert.equal((await s.request(path, payload, s.admin, 'https://evil.example.invalid')).status, 403)
  }
  assert.equal((await s.request(brandingPath)).status, 401)
  assert.equal((await s.request(announcementPath)).status, 401)
  assert.deepEqual(await (await s.request(brandingPath, undefined, s.admin)).json(), emptyStoreBranding)
  assert.deepEqual(await (await s.request(announcementPath, undefined, s.admin)).json(), emptyAnnouncement)
  for (const [field, value] of [['name', '字'.repeat(33)], ['headline', '字'.repeat(81)], ['description', '字'.repeat(201)], ['pageTitle', 'bad\ncopy'], ['logo', 'https://evil.invalid/logo.svg'], ['logo', 'data:image/svg+xml;base64,PHN2Zy8+'], ['version', null], ['version', -1], ['version', 0.5], ['version', '0']] as const) {
    assert.equal((await s.request(brandingPath, { ...branding, [field]: value }, s.admin)).status, 400, field)
  }
  for (const patch of [{ version: null }, { enabled: 'true' }, { placement: 'orders' }, { title: '' }, { title: '字'.repeat(81) }, { content: '字'.repeat(5001) }, { content: '\u0000' }]) {
    assert.equal((await s.request(announcementPath, { ...announcement, ...patch }, s.admin)).status, 400)
  }
  assert.deepEqual(await (await s.request(brandingPath, undefined, s.admin)).json(), emptyStoreBranding)
})

test('platform settings persist, conflict on stale revisions, audit and reset independently', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const saved = await s.request(brandingPath, branding, s.admin)
  assert.equal(saved.status, 200, await saved.clone().text())
  assert.deepEqual(await saved.json(), { ...branding, name: '星河主站', version: 1 })
  assert.equal((await s.request(brandingPath, branding, s.admin)).status, 409)
  assert.equal((await s.request(announcementPath, announcement, s.admin)).status, 200)
  assert.equal((await s.request(announcementPath, announcement, s.admin)).status, 409)
  const competing = await Promise.all([s.request(brandingPath, { ...branding, version: 1, name: '甲' }, s.admin), s.request(brandingPath, { ...branding, version: 1, name: '乙' }, s.admin)])
  assert.deepEqual(competing.map(r => r.status).sort(), [200, 409])
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action IN ('platform-branding','platform-announcement') AND target_id='platform'").get()!.n, 3)
  const catalog = await (await s.request('/api/catalog')).json()
  assert.equal(catalog.platformBranding.pageTitle, branding.pageTitle)
  assert.equal(catalog.announcement.content, announcement.content)
  assert.equal(catalog.partner, undefined)
  assert.equal((await s.request(brandingPath, { ...emptyStoreBranding, version: 2 }, s.admin)).status, 200)
  assert.equal((await s.request(announcementPath, { ...emptyAnnouncement, version: 1 }, s.admin)).status, 200)
  const reset = await (await s.request('/api/catalog')).json()
  assert.deepEqual(reset.platformBranding, { ...emptyStoreBranding, version: 3 })
  assert.equal(reset.announcement, null)
})

test('logo uploads decode and re-encode bounded PNG pixels and remain after saving', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const upload = await s.request(brandingPath + '/logo', { logo: dataUrl(Buffer.concat([png(), Buffer.from('private trailing content')])) }, s.admin)
  assert.equal(upload.status, 200, await upload.clone().text())
  const { logo } = await upload.json()
  const raw = Buffer.from(logo.split(',')[1], 'base64')
  assert.equal(raw.includes(Buffer.from('private')), false)
  assert.deepEqual(decode(raw).text, {})
  assert.equal((await s.request(brandingPath, { ...branding, logo }, s.admin)).status, 200)
  const catalog = await (await s.request('/api/catalog')).json()
  assert.equal(catalog.platformBranding.logo, logo)
  const oversized = Buffer.from(encode({ width: 257, height: 1, data: new Uint8Array(257 * 4) }))
  const corrupt = png(); corrupt[corrupt.length - 1] ^= 1
  for (const bad of ['data:image/png;base64,AAAA', 'data:image/svg+xml;base64,PHN2Zy8+', dataUrl(oversized), dataUrl(corrupt), dataUrl(new Uint8Array(263000))]) {
    assert.equal((await s.request(brandingPath + '/logo', { logo: bad }, s.admin)).status, 400)
    assert.equal((await s.request(brandingPath, { ...branding, logo: bad, version: 1 }, s.admin)).status, 400)
  }
  assert.equal((await s.request(brandingPath + '/logo', { logo: 'x'.repeat(360000) }, s.admin)).status, 413)
})

test('main and partner announcements/configuration never inherit or overwrite each other', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const a = await s.agent('A'), b = await s.agent('B')
  const slug = (id: string) => String(s.db.prepare('SELECT slug FROM partners WHERE id=?').get(id)!.slug)
  assert.equal((await s.request('/api/partner/announcement', { ...announcement, title: '分站公告' }, a.cookie)).status, 200)
  const before = s.db.prepare('SELECT * FROM partner_announcements WHERE partner_id=?').get(a.id)
  assert.equal((await s.request(brandingPath, branding, s.admin)).status, 200)
  assert.equal((await s.request(announcementPath, announcement, s.admin)).status, 200)
  const shop = await (await s.request('/api/catalog?partner=' + slug(a.id))).json()
  assert.equal(shop.platformBranding, null)
  assert.equal(shop.announcement.title, '分站公告')
  assert.deepEqual(s.db.prepare('SELECT * FROM partner_announcements WHERE partner_id=?').get(a.id), before)
  const other = await (await s.request('/api/catalog?partner=' + slug(b.id))).json()
  assert.equal(other.platformBranding, null)
  assert.equal(other.announcement, null)
  assert.equal((await s.request('/api/partner/announcement', { ...announcement, enabled: false, version: 1 }, a.cookie)).status, 200)
  const main = await (await s.request('/api/catalog')).json()
  assert.equal(main.announcement.title, announcement.title)
  assert.equal(main.platformBranding.name, '星河主站')
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  hideAnnouncementToday(storage, '@platform')
  assert.equal(announcementHiddenToday(storage, '@platform'), true)
  assert.equal(announcementHiddenToday(storage, slug(a.id)), false)
})

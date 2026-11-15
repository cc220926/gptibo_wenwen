import { ORDER_PLANS, PLANS, type PlanId } from './demo-orders'

/** Where buyers redeem a Codex SMS CDK. Change here if the supplier moves its redeem site. */
export const SMS_REDEEM_HOST = 'sms.llvi.de'
export const SMS_REDEEM_URL = 'https://' + SMS_REDEEM_HOST

export const PRODUCTS = [
  { id: 'x-premium', name: 'X Premium', category: '社交订阅', tagline: '你的账号，更多可能。', description: '选择 3 或 6 个月 Premium，继续你的精彩。', pitch: '只需 X 用户名，无需密码。', badge: '个人账号', unit: '份', quantity: '所选订阅周期', method: '账号充值', defaultPlan: 'x-premium-3m' as PlanId },
  { id: 'chatgpt', name: 'ChatGPT', category: 'AI 订阅', tagline: '你的日常灵感搭档', description: '写作、学习与深度探索，选择适合自己的订阅。', pitch: '从一个好问题，到一个新想法。在熟悉的账号里，继续你的探索。', badge: '个人账号', unit: '月', quantity: '1 个月', method: '账号直充', defaultPlan: 'plus' as PlanId },
  { id: 'codex-credits', name: 'Codex 点数', category: '工具服务', tagline: '选择点数，直充到账。', description: '250 / 500 点一次性点数包，付款后提交 Session 直充。', pitch: '确认点数并付款，在原订单提交 Session 后直充到自己的账号，进度可随时查看。', badge: '一次性点数', unit: '份', quantity: '所选点数', method: '账号点数直充', defaultPlan: 'codex-credits-250' as PlanId },
  { id: 'gemini', name: 'Gemini Pro', category: 'AI 订阅', tagline: '18 个月，让探索延续', description: '18 个月会员，付款后自动交付领取链接。', pitch: '下单时留下收件邮箱。付款确认后自动发货，领取链接与说明可在订单页查看，也会发送至邮箱。', badge: '自动发货', unit: '18 个月', quantity: '18 个月', method: '订单页与邮件领取链接', defaultPlan: 'gemini-pro-18m' as PlanId },
  { id: 'duolingo', name: '多邻国', category: '语言学习', tagline: '一整年，和 Duo 一起学', description: '1 年会员，付款后自动交付兑换 CDK。', pitch: '给下一年的学习留个位置。付款确认后自动发货，兑换 CDK 与说明可在订单页查看，也会发送至邮箱。', badge: '自动发货', unit: '年', quantity: '1 年', method: '订单页与邮件领取 CDK', defaultPlan: 'duolingo-12m' as PlanId },
  { id: 'codex-sms', name: 'Codex 接码', category: '短信服务', tagline: 'CDK 自动交付，前往兑换接码', description: '付款后自动交付接码 CDK，前往兑换站获取手机号与验证码。', pitch: `付款确认后，CDK 自动显示在原订单并发送至下单邮箱。请前往 ${SMS_REDEEM_HOST} 兑换，在兑换站获取手机号及验证码。`, badge: '自动交付', unit: '次', quantity: '1 次', method: 'CDK 自动邮件发货', defaultPlan: 'codex-sms-once' as PlanId },
  { id: 'gmail', name: 'Gmail 账号', category: '邮箱账号', tagline: '美国个人白号，资料自动交付', description: '美国长效个人 Gmail 白号，带 2FA 与验证链接。', pitch: '填写可正常收件的邮箱，付款确认后自动发送账号资料。请在购买当天首次登录，并提前确认登录环境与质保范围。', badge: '个人白号', unit: '个', quantity: '1 个账号', method: '自动邮件发货', defaultPlan: 'gmail-account' as PlanId },
] as const
export type ProductId = typeof PRODUCTS[number]['id']
export const SMS_STEPS = ['选择付款', '查收 CDK', '兑换接码'] as const
export const UPCOMING_PRODUCTS = [
  { id: 'claude', name: 'Claude', category: 'AI 订阅', description: 'Claude 订阅服务，暂未开放购买。', tags: ['套餐待公布', '交付方式待公布'] },
  { id: 'grok', name: 'Grok', category: 'AI 订阅', description: 'Grok 订阅服务，暂未开放购买。', tags: ['套餐待公布', '交付方式待公布'] },
] as const
export function productPlans(id: ProductId) { return PLANS.filter(plan => plan.productId === id) }
export function productForPlan(planId: PlanId) { return PRODUCTS.find(product => product.id === ORDER_PLANS.find(plan => plan.id === planId)?.productId) ?? { ...PRODUCTS[0], id: 'custom' as const, name: '商品', quantity: '1 份' } }
export { readStorefrontPage as readPage } from './storefront-routing'

import type { StorefrontLocale } from './storefront-locale'

// Informational copy only; never used to create orders or submit credentials.
const copy = {
  'zh-CN': {
    region: '购买前引导', title: '购买前，看清楚再决定。', demo: '开通演示',
    intro: '先看看，ChatGPT 怎么充值。', subtitle: '以 ChatGPT 充值为例，其他商品请查看各自的交付说明。',
    openDemo: '查看充值演示', preview: '现有教程', shortSteps: ['准备账号', '下单付款', '提交充值'],
    previewTitle: 'ChatGPT 充值流程', previewNote: '从登录，到到账',
    demoTitle: 'ChatGPT 充值流程演示', demoDisclaimer: '这是操作示意，不会创建订单、付款或提交账号信息。', tutorialLanguage: '',
  },
  en: {
    region: 'Before you buy', title: 'Know what happens before you buy.', demo: 'How it works',
    intro: 'See how a ChatGPT top-up works.', subtitle: 'This example covers ChatGPT. Check each product for its own delivery instructions.',
    openDemo: 'Watch the top-up guide', preview: 'Existing tutorial', shortSteps: ['Prepare account', 'Order and pay', 'Submit top-up'],
    previewTitle: 'ChatGPT top-up walkthrough', previewNote: 'From login to completion',
    demoTitle: 'ChatGPT top-up walkthrough', demoDisclaimer: 'This walkthrough does not create orders, take payment or submit account information.', tutorialLanguage: 'The existing tutorial is in Chinese.',
  },
} as const

export function homeGuideCopy(locale: StorefrontLocale) { return copy[locale] }

export type HomeQuestion = { id: string; title: string; answer: string; keywords: string; action: 'orders' | 'support' }
const questions: Record<StorefrontLocale, readonly HomeQuestion[]> = {
  'zh-CN': [
    { id: 'apple-login', title: '通过 Apple 登录的 ChatGPT 账号能充值吗？', answer: '已有通过 Apple 登录的 ChatGPT 账号充值案例。购买前请联系客服确认账号情况及所选套餐，不保证所有账号都适用。这里指 ChatGPT 账号订阅，不是 Apple 账户余额充值。', keywords: 'Apple apple id 苹果 登录 隐藏邮箱 hide my email relay ChatGPT', action: 'support' },
    { id: 'recovery', title: '付款页面关了，怎么找回订单？', answer: '进入「我的订单」，使用下单邮箱接收验证码找回订单。原浏览器也会显示已有记录；找回后在同一笔订单继续，不要重复下单。', keywords: '查单 找回 邮箱 关闭 页面 丢失 recovery email', action: 'orders' },
    { id: 'pending', title: '已经付款，为什么还没开通？', answer: '先查看原订单的付款和处理状态。账号充值可能还需要连接账号并提交；等待或超时不代表失败，请勿重复付款。仍有异常时，在原订单联系支持。', keywords: '支付 付款 没到账 充值 延迟 失败 pending payment', action: 'orders' },
    { id: 'manual', title: '人工交付需要我做什么？', answer: '先阅读商品说明。付款后按订单提示联系客服，提供订单号，由工作人员交付。处理时间以商品说明及客服确认为准，不能按自动发货的时间预期等待。', keywords: '人工 客服 联系 时效 手动 manual support', action: 'support' },
    { id: 'delivery', title: '收到卡密或领取链接，就开通了吗？', answer: '不一定。兑换码和领取链接通常需要你按说明完成兑换或领取，再到对应账号确认结果。具体步骤以所购商品的交付说明为准。', keywords: '激活 兑换 CDK 卡密 链接 领取 redeem code link', action: 'orders' },
    { id: 'email', title: '没有收到交付邮件，怎么办？', answer: '先在原订单确认是否已交付，再检查下单邮箱和垃圾邮件。不要因为未收到邮件就重复购买；需要时携订单号联系支持。', keywords: '邮件 收件 垃圾 信箱 发货 email delivery', action: 'orders' },
    { id: 'credentials', title: '需要提供账号密码或 Session 吗？', answer: '账号充值可能需要在原订单的账号连接步骤提交 Session；它属于登录凭据，不要发给客服或写进售后备注。卡密、领取链接和接码等商品无需提交 Session，以商品说明为准。', keywords: '账号 密码 隐私 安全 凭据 session token password privacy', action: 'support' },
    { id: 'renewal', title: '会员没到期，可以提前续费吗？', answer: '不要默认所有套餐都能提前续费或叠加时长。请先核对所选规格的账号条件、新开与续费限制；不确定时，购买前联系支持确认。', keywords: '续费 到期 叠加 时长 新开 renewal subscription', action: 'support' },
    { id: 'refund', title: '出现异常，如何申请售后或退款？', answer: '在原订单查看状态并申请售后，保留订单号与问题说明。是否支持退款、退款金额和处理方式，以商品售后规则及审核结果为准。不要在备注中提交密码、Session 或验证码。', keywords: '退款 售后 退钱 质保 refund after-sales warranty', action: 'orders' },
  ],
  en: [
    { id: 'apple-login', title: 'Can I top up a ChatGPT account that uses Sign in with Apple?', answer: 'We have handled top-ups for ChatGPT accounts using Sign in with Apple. Contact support before buying to confirm your account and selected plan; not every account is guaranteed to be eligible. This concerns a ChatGPT subscription, not an Apple account balance.', keywords: 'Apple apple id 苹果 登录 隐藏邮箱 hide my email relay ChatGPT', action: 'support' },
    { id: 'recovery', title: 'Closed the payment page? Find your order.', answer: 'Open My orders and verify the email used at checkout. Existing records also appear in the original browser. Continue in the same order instead of buying again.', keywords: '查单 找回 邮箱 recovery email closed lost', action: 'orders' },
    { id: 'pending', title: 'Paid, but the service is not active yet?', answer: 'Check payment and processing status in the original order. Account top-ups may still need you to connect an account and submit. Waiting or a timeout does not mean failure. Do not pay again; contact support through the order if needed.', keywords: '支付 没到账 延迟 pending payment failure top-up', action: 'orders' },
    { id: 'manual', title: 'What do I need to do for manual delivery?', answer: 'Read the product description first. After payment, follow the order instructions to contact support with your order number. Delivery time depends on the product and support confirmation; manual delivery is not automatic dispatch.', keywords: '人工 客服 manual support time', action: 'support' },
    { id: 'delivery', title: 'Does receiving a code or link activate it?', answer: 'Not always. Follow the instructions to redeem the code or claim the link, then check the result in the relevant account. Use the delivery instructions for the product you purchased.', keywords: '激活 兑换 CDK redeem code link claim', action: 'orders' },
    { id: 'email', title: 'No delivery email in your inbox?', answer: 'Check whether the original order has been delivered, then check the purchase email and spam folder. Do not buy again just because the email is missing. Contact support with your order number if needed.', keywords: '邮件 email delivery inbox spam', action: 'orders' },
    { id: 'credentials', title: 'Do I need to share a password or Session?', answer: 'Account top-ups may require a Session in the account connection step of the original order. A Session is a login credential: never send it to support or put it in support notes. Codes, claim links and SMS products do not need a Session. Check the product description.', keywords: '账号 密码 隐私 安全 session token password privacy credentials', action: 'support' },
    { id: 'renewal', title: 'Can I renew before my membership expires?', answer: 'Do not assume every plan supports early renewal or stacking time. Check the account requirements and new-subscription or renewal restrictions for the selected plan. Ask support before buying if unsure.', keywords: '续费 到期 renewal subscription expiry stack', action: 'support' },
    { id: 'refund', title: 'How do I request support or a refund?', answer: 'Check status and request support in the original order. Keep your order number and a description of the issue. Refund eligibility, amount and method depend on the product terms and review. Do not include passwords, Sessions or verification codes in notes.', keywords: '退款 售后 refund after-sales warranty', action: 'orders' },
  ],
}

export function searchHomeQuestions(locale: StorefrontLocale, query = '') {
  const terms = query.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean)
  return questions[locale].filter(question => {
    const text = `${question.title} ${question.answer} ${question.keywords}`.normalize('NFKC').toLowerCase()
    return terms.every(term => text.includes(term))
  })
}

const helpCopy = {
  'zh-CN': {
    help: '选购帮助', cases: '用户反馈', helpTitle: '先把疑问问清楚。', helpIntro: '账号要求、订单找回与交付方式，购买前就能了解。',
    allQuestions: '搜索全部问题', search: '搜索购买问题', searchPlaceholder: '搜索问题，例如「退款」', clear: '清除搜索',
    noResults: '没有找到相关问题。试试其他关键词，或联系支持。', questionTitle: '购买前后，都能找到答案',
    questionIntro: '这里只提供操作说明。价格、账号条件与售后范围，以所选商品为准。',
    orders: '查看我的订单', support: '联系支持', resultCount: '个相关问题',
  },
  en: {
    help: 'Buying help', cases: 'User feedback', helpTitle: 'Get your questions answered.', helpIntro: 'Check account requirements, order recovery and delivery before you buy.',
    allQuestions: 'Search all questions', search: 'Search purchase questions', searchPlaceholder: 'Search a question, e.g. refund', clear: 'Clear search',
    noResults: 'No matching questions. Try another keyword or contact support.', questionTitle: 'Answers before and after buying',
    questionIntro: 'These are operating instructions. Check your selected product for prices, account conditions and support terms.',
    orders: 'View my orders', support: 'Contact support', resultCount: 'matching questions',
  },
} as const

export function homeHelpCopy(locale: StorefrontLocale) { return helpCopy[locale] }


// User-provided conversation excerpts. Context stays with each image so a
// pre-purchase recommendation is never represented as completed fulfillment.
export type HomeFeedbackItem = {
  id: string; title: string; category: string; quote: string; description: string
  image: string; alt: string; context: string
}
type HomeFeedbackCopy = {
  title: string; intro: string; open: string; close: string; languageNote: string
  items: readonly HomeFeedbackItem[]
}
const feedbackCopy: Record<StorefrontLocale, HomeFeedbackCopy> = {
  'zh-CN': {
    title: '看看他们怎么说。', intro: '微信沟通节选 · 个人信息已遮挡',
    open: '查看聊天记录', close: '关闭图片', languageNote: '',
    items: [
      {
        id: 'subscription-confirmed', title: '订阅开通确认', category: '开通反馈', quote: '可以了可以了',
        description: '询问订阅状态后，用户确认已开通并表达感谢。',
        image: '/feedback/subscription-confirmed.png',
        alt: '脱敏微信聊天记录：客服询问订阅是否开通，用户回复“可以了可以了”“靠谱！”“感谢”。',
        context: '',
      },
      {
        id: 'consultation-referral', title: '咨询后，推荐给朋友', category: '咨询后推荐', quote: '我就先把你推给我朋友',
        description: '咨询后向朋友推荐，尚未购买；对话含转介绍返现说明。',
        image: '/feedback/consultation-referral.png',
        alt: '脱敏微信聊天记录：咨询者表示暂不需要充值并推荐朋友；商家随后提出朋友下单返现五元。',
        context: '该次对话中，商家随后提出朋友下单返现 5 元，相关内容保留在截图中。',
      },
    ],
  },
  en: {
    title: 'In their own words.', intro: 'WeChat excerpts · Personal information redacted',
    open: 'View conversation', close: 'Close image', languageNote: 'The original screenshots and quotations are in Chinese.',
    items: [
      {
        id: 'subscription-confirmed', title: 'Subscription confirmed', category: 'Activation feedback', quote: '可以了可以了',
        description: 'After being asked about the subscription, the customer confirmed activation and thanked support.',
        image: '/feedback/subscription-confirmed.png',
        alt: 'Redacted WeChat conversation in Chinese: support asks whether the subscription is active; the customer confirms and says thank you.',
        context: '',
      },
      {
        id: 'consultation-referral', title: 'A recommendation after asking', category: 'Pre-purchase recommendation', quote: '我就先把你推给我朋友',
        description: 'The person had not purchased this top-up. The conversation includes a referral reward offer.',
        image: '/feedback/consultation-referral.png',
        alt: 'Redacted WeChat conversation in Chinese: a person does not need a top-up yet and refers a friend; the merchant then offers CNY 5 if the friend orders.',
        context: 'In this conversation, the merchant then offered CNY 5 for a friend’s order. This context remains in the screenshot.',
      },
    ],
  },
}

export function homeFeedbackCopy(locale: StorefrontLocale) { return feedbackCopy[locale] }

import type { StorefrontLocale } from './storefront-locale'

// Informational copy only; never used to create orders or submit credentials.
const copy = {
  'zh-CN': {
    region: '购买前引导', title: '购买前，看清楚再决定。', demo: '开通演示',
    intro: '先看看，付款后怎么继续。', subtitle: '不同商品的交付方式，以详情页说明为准。',
    openDemo: '查看分步演示', preview: '流程示意', shortSteps: ['选套餐', '付款', '订单中继续'],
    demoTitle: '从选购，到查看结果', demoDisclaimer: '这是操作示意，不会创建订单、付款或提交账号信息。',
    previous: '上一步', next: '下一步', done: '了解了，去选商品', stepLabel: '购买步骤',
    steps: [
      { id: 'choose', title: '先选商品，核对购买说明', body: '在详情页确认套餐、价格、账号要求和交付方式，再填写能正常收件的下单邮箱。', scene: '核对套餐与交付方式', note: '以当前商品说明为准' },
      { id: 'payment', title: '在原订单完成付款', body: '使用订单提供的支付方式付款。付款后保留原订单页面，按页面提示继续；重复付款不会让处理更快。', scene: '付款状态与订单同步', note: '保存订单，继续操作' },
      { id: 'continue', title: '按交付方式继续，查看结果', body: '账号充值按指引连接账号；兑换商品按说明领取或兑换；人工商品按订单提示联系支持。进度与结果都在原订单查看。', scene: '付款后，还可能需要操作', note: '换设备可通过下单邮箱找回' },
    ],
  },
  en: {
    region: 'Before you buy', title: 'Know what happens before you buy.', demo: 'How it works',
    intro: 'See what comes after payment.', subtitle: 'Delivery depends on the product. Check its details before buying.',
    openDemo: 'Explore the steps', preview: 'Example walkthrough', shortSteps: ['Choose', 'Pay', 'Continue in your order'],
    demoTitle: 'From choosing to checking the result', demoDisclaimer: 'This walkthrough does not create orders, take payment or submit account information.',
    previous: 'Previous', next: 'Next', done: 'Got it, browse products', stepLabel: 'Purchase steps',
    steps: [
      { id: 'choose', title: 'Choose a product and read its terms', body: 'Check the plan, price, account requirements and delivery method on the product page. Use an email address that can receive order messages.', scene: 'Check the plan and delivery', note: 'Follow the current product description' },
      { id: 'payment', title: 'Pay through your original order', body: 'Use a payment method offered in the order. Keep the order page open and follow its instructions. Paying again will not speed things up.', scene: 'Payment status stays with the order', note: 'Keep your order to continue' },
      { id: 'continue', title: 'Follow the delivery instructions', body: 'Account top-ups need an account connection; codes and links need to be claimed or redeemed; manual products may need support. Check progress and results in the original order.', scene: 'Payment may require a next step', note: 'Recover orders with your purchase email' },
    ],
  },
} as const

export function homeGuideCopy(locale: StorefrontLocale) { return copy[locale] }

export type HomeQuestion = { id: string; title: string; answer: string; keywords: string; action: 'orders' | 'support' }
const questions: Record<StorefrontLocale, readonly HomeQuestion[]> = {
  'zh-CN': [
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
    help: '选购帮助', cases: '售后案例', helpTitle: '先把疑问问清楚。', helpIntro: '账号要求、订单找回与交付方式，购买前就能了解。',
    allQuestions: '搜索全部问题', search: '搜索购买问题', searchPlaceholder: '搜索问题，例如「退款」', clear: '清除搜索',
    noResults: '没有找到相关问题。试试其他关键词，或联系支持。', questionTitle: '购买前后，都能找到答案',
    questionIntro: '这里只提供操作说明。价格、账号条件与售后范围，以所选商品为准。',
    orders: '查看我的订单', support: '联系支持', resultCount: '个相关问题',
    caseTitle: '出问题，可以这样处理。', caseDisclaimer: '以下为处理流程示例，并非真实客户案例。',
    caseBadge: '流程示例', situation: '遇到的情况', nextStep: '接下来怎么做',
    scenarios: [
      { id: 'pending', label: '付款后未开通', situation: '已付款，但账号还没有显示会员。', nextStep: '先查原订单，确认是否需要连接账号或继续提交；不要重复付款。仍有异常，再从原订单申请售后。' },
      { id: 'email', label: '没有收到邮件', situation: '订单已交付，邮箱里却找不到邮件。', nextStep: '先在原订单查看交付内容，再检查收件箱和垃圾邮件；仍有问题时，携订单号联系支持。' },
      { id: 'manual', label: '需要人工交付', situation: '买的是人工商品，付款后没有自动发货。', nextStep: '按原订单指引联系客服并提供订单号，确认所需信息和处理时间；交付进度在原订单查看。' },
    ],
  },
  en: {
    help: 'Buying help', cases: 'Support examples', helpTitle: 'Get your questions answered.', helpIntro: 'Check account requirements, order recovery and delivery before you buy.',
    allQuestions: 'Search all questions', search: 'Search purchase questions', searchPlaceholder: 'Search a question, e.g. refund', clear: 'Clear search',
    noResults: 'No matching questions. Try another keyword or contact support.', questionTitle: 'Answers before and after buying',
    questionIntro: 'These are operating instructions. Check your selected product for prices, account conditions and support terms.',
    orders: 'View my orders', support: 'Contact support', resultCount: 'matching questions',
    caseTitle: 'Know what to do if something goes wrong.', caseDisclaimer: 'These are workflow examples, not real customer cases.',
    caseBadge: 'Workflow example', situation: 'The situation', nextStep: 'What to do next',
    scenarios: [
      { id: 'pending', label: 'Paid, not active', situation: 'Payment is complete but membership is not showing.', nextStep: 'Check the original order for account connection or submission steps. Do not pay again. Request support from that order if the issue persists.' },
      { id: 'email', label: 'Missing email', situation: 'The order is delivered, but the email is missing.', nextStep: 'Check the delivery in the original order, then your inbox and spam folder. Contact support with your order number if needed.' },
      { id: 'manual', label: 'Manual delivery', situation: 'A manual product did not dispatch automatically after payment.', nextStep: 'Follow the order instructions to contact support with the order number. Confirm the required information and timing, then check progress in the original order.' },
    ],
  },
} as const

export function homeHelpCopy(locale: StorefrontLocale) { return helpCopy[locale] }

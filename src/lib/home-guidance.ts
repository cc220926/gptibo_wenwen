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

export type PublicArticle = { slug: string; title: string; answer: string; sections: { title: string; paragraphs: string[] }[]; related?: string }
// Operational guidance is checked against this repository's storefront and order UI.
// No promises of supplier entitlement, delivery time, refund outcome or invented reviews.
export const publicHelpUpdated = '2026-11-21'
export const publicArticles: readonly PublicArticle[] = [
  {
    slug: 'recharge-or-account', title: 'ChatGPT 充值和成品账号有什么区别？',
    answer: '充值是给自己的账号购买所选套餐；成品账号属于另一个商品，按其规格交付账号资料。购买前先确认你希望继续使用自己的账号，还是购买单独交付的账号。',
    sections: [
      { title: '继续使用自己的账号', paragraphs: ['选择 ChatGPT 充值商品，确认套餐和购买须知。付款后是否需要连接账号、如何提交凭据，以原订单的指引为准。', '现有充值教程可在 ChatGPT 商品页的“如何开通”区域查看，继续使用原有示意图。'] },
      { title: '购买成品账号', paragraphs: ['成品账号的交付内容、使用条件和售后范围以对应商品的购买须知为准，不能套用自有账号充值流程。账号内原有数据也不会因此迁移。'] },
      { title: '下单前核对', paragraphs: ['核对商品、规格、最终金额以及售后范围。本站提供独立服务，品牌名称用于识别商品，不表示获得品牌方授权或背书。'] },
    ], related: '/product/chatgpt',
  },
  {
    slug: 'codex-credits', title: 'Codex 点数、订阅和接码有什么区别？',
    answer: '本站 Codex 点数商品为一次性点数包；ChatGPT 订阅按所选套餐提供服务；Codex 接码交付接码 CDK。三类商品分别购买，不能互相替代。',
    sections: [
      { title: '先核对需要的服务', paragraphs: ['需要点数包时进入 Codex 点数商品；需要会员套餐时进入 ChatGPT 商品；需要接码时查看 Codex 接码商品。可售规格与价格以实时商品页为准。'] },
      { title: '交付流程不同', paragraphs: ['点数包付款后按原订单指引连接账号、查看充值进度。接码商品付款确认后在原订单和邮件中查收 CDK，再按兑换说明操作。', '点数的适用条件和使用限制以所选商品说明及账号实际显示为准。不要从商品名称推断点数等于订阅、无限使用或固定任务次数。'] },
    ], related: '/product/codex-credits',
  },
  {
    slug: 'after-payment', title: '付款后还需要完成哪些步骤？',
    answer: '完成付款后回到原订单，先查看付款状态，再根据商品的交付指引继续操作。付款完成、账号连接和交付完成是不同步骤。',
    sections: [
      { title: '查看原订单', paragraphs: ['进入“我的订单”，找到对应订单并查看最新状态。若页面暂未更新，先刷新订单进度；请求超时本身不能证明付款或交付失败。'] },
      { title: '按商品继续操作', paragraphs: ['账号充值可能需要在订单中连接账号；自动发货商品在订单或下单邮箱中查看交付资料；人工交付商品按购买须知等待处理或联系支持。', 'Session 属于登录凭据，只在订单指定的账号连接步骤按指引提交，不要写入售后备注、公开截图或发给其他人。'] },
      { title: '不要重复提交', paragraphs: ['遇到处理中或网络超时，先核对原订单，再按订单提供的操作继续。不要因为页面没有立即更新就重复购买。'] },
    ],
  },
  {
    slug: 'order-recovery', title: '关闭页面后如何找回订单？',
    answer: '先使用下单时的浏览器进入“我的订单”。如果换了设备或浏览器，可在订单页使用下单邮箱验证找回；该功能是否可用以页面提示为准。',
    sections: [
      { title: '原浏览器查询', paragraphs: ['保留下单浏览器的 Cookie，打开“我的订单”查看已有记录。不要先清理浏览器数据，以免丢失当前设备的订单访问凭据。'] },
      { title: '下单邮箱验证', paragraphs: ['在“我的订单”打开邮箱找回入口，填写下单邮箱，接收验证码并完成验证。邮件服务未启用或暂不可用时，页面会显示说明。', '验证码只用于本站的验证步骤，不要在聊天、评价截图或公开内容中展示。'] },
      { title: '仍找不到订单', paragraphs: ['核对邮箱是否与下单时一致。保留订单号和付款记录，通过原商店的联系支持入口说明问题；请勿发送账号密码或 Session。'] },
    ],
  },
  {
    slug: 'after-sales', title: '如何申请售后，退款范围如何确认？',
    answer: '先查看所购商品的购买须知，再从原订单查看或申请售后。商品是否支持售后、可申请金额和处理方式以订单页面为准，提交申请不等于退款已经完成。',
    sections: [
      { title: '从原订单处理', paragraphs: ['在“我的订单”打开对应订单，查看可用的售后入口和当前进度。如果商品已明确说明不支持售后质保，订单会显示相应提示。'] },
      { title: '金额和进度以订单为准', paragraphs: ['订单会根据实际情况显示可申请金额、审核或自动处理状态。不要将“可申请”理解为所有情况都能无条件退款，也不要将提交时间当作到账承诺。'] },
      { title: '说明问题时保护凭据', paragraphs: ['填写发生的问题及必要截图，不填写账号密码、Session、邮箱验证码或完整卡密。申请后的服务状态和后续操作以原订单提示为准。'] },
    ],
  },
]

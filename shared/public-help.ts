export const publicHelpCategories = [
  { id: 'buying', title: '选套餐' },
  { id: 'order', title: '查付款与订单' },
  { id: 'account', title: '账号与安全' },
  { id: 'activation', title: '充值与到账' },
  { id: 'support', title: '申请售后' },
] as const

type PublicHelpCategory = typeof publicHelpCategories[number]['id']
export type HelpParagraph = string | (string | { code: string })[]
export type PublicArticle = { slug: string; category: PublicHelpCategory; title: string; answer: string; keywords?: string; sections: { title: string; paragraphs: HelpParagraph[] }[]; related?: string }
// Operational guidance is checked against this repository's storefront and order UI.
// No promises of supplier entitlement, delivery time, refund outcome or invented reviews.
export const publicHelpUpdated = '2026-11-24'
export const publicArticles: readonly PublicArticle[] = [
  {
    slug: 'recharge-or-account', category: 'buying', title: 'ChatGPT 充值和成品账号有什么区别？',
    answer: '充值是给自己的账号购买所选套餐；成品账号属于另一个商品，按其规格交付账号资料。购买前先确认你希望继续使用自己的账号，还是购买单独交付的账号。',
    sections: [
      { title: '继续使用自己的账号', paragraphs: ['选择 ChatGPT 充值商品，确认套餐和购买须知。付款后是否需要连接账号、如何提交凭据，以原订单的指引为准。', '现有充值教程可在 ChatGPT 商品页的“如何开通”区域查看，继续使用原有示意图。'] },
      { title: '购买成品账号', paragraphs: ['成品账号的交付内容、使用条件和售后范围以对应商品的购买须知为准，不能套用自有账号充值流程。账号内原有数据也不会因此迁移。'] },
      { title: '下单前核对', paragraphs: ['核对商品、规格、最终金额以及售后范围。本站提供独立服务，品牌名称用于识别商品，不表示获得品牌方授权或背书。'] },
    ], related: '/product/chatgpt',
  },
  {
    slug: 'codex-credits', category: 'buying', title: 'Codex 点数、订阅和接码有什么区别？',
    answer: '本站 Codex 点数商品为一次性点数包；ChatGPT 订阅按所选套餐提供服务；Codex 接码交付接码 CDK。三类商品分别购买，不能互相替代。',
    sections: [
      { title: '先核对需要的服务', paragraphs: ['需要点数包时进入 Codex 点数商品；需要会员套餐时进入 ChatGPT 商品；需要接码时查看 Codex 接码商品。可售规格与价格以实时商品页为准。'] },
      { title: '交付流程不同', paragraphs: ['点数包付款后按原订单指引连接账号、查看充值进度。接码商品付款确认后在原订单和邮件中查收 CDK，再按兑换说明操作。', '点数的适用条件和使用限制以所选商品说明及账号实际显示为准。不要从商品名称推断点数等于订阅、无限使用或固定任务次数。'] },
    ], related: '/product/codex-credits',
  },
  {
    slug: 'after-payment', category: 'order', title: '付款后还需要完成哪些步骤？',
    keywords: '已付钱 已付款 没到账 付款后没开通 等待充值 处理中',
    answer: '完成付款后回到原订单，先查看付款状态，再根据商品的交付指引继续操作。付款完成、账号连接和交付完成是不同步骤。',
    sections: [
      { title: '查看原订单', paragraphs: ['进入“我的订单”，找到对应订单并查看最新状态。若页面暂未更新，先刷新订单进度；请求超时本身不能证明付款或交付失败。'] },
      { title: '按商品继续操作', paragraphs: ['账号充值可能需要在订单中连接账号；自动发货商品在订单或下单邮箱中查看交付资料；人工交付商品按购买须知等待处理或联系支持。', 'Session 属于登录凭据，只在订单指定的账号连接步骤按指引提交，不要写入售后备注、公开截图或发给其他人。'] },
      { title: '不要重复提交', paragraphs: ['遇到处理中或网络超时，先核对原订单，再按订单提供的操作继续。不要因为页面没有立即更新就重复购买。'] },
    ],
  },
  {
    slug: 'order-recovery', category: 'order', title: '关闭页面后如何找回订单？',
    keywords: '查单 查订单 找不到订单 付款后找不到订单 支付页面关了 订单丢了',
    answer: '先使用下单时的浏览器进入“我的订单”。如果换了设备或浏览器，可在订单页使用下单邮箱验证找回；该功能是否可用以页面提示为准。',
    sections: [
      { title: '原浏览器查询', paragraphs: ['保留下单浏览器的 Cookie，打开“我的订单”查看已有记录。不要先清理浏览器数据，以免丢失当前设备的订单访问凭据。'] },
      { title: '下单邮箱验证', paragraphs: ['在“我的订单”打开邮箱找回入口，填写下单邮箱，接收验证码并完成验证。邮件服务未启用或暂不可用时，页面会显示说明。', '验证码只用于本站的验证步骤，不要在聊天、评价截图或公开内容中展示。'] },
      { title: '仍找不到订单', paragraphs: ['核对邮箱是否与下单时一致。保留订单号和付款记录，通过原商店的联系支持入口说明问题；请勿发送账号密码或 Session。'] },
    ],
  },
  {
    slug: 'after-sales', category: 'support', title: '如何申请售后，退款范围如何确认？',
    answer: '先查看所购商品的购买须知，再从原订单查看或申请售后。商品是否支持售后、可申请金额和处理方式以订单页面为准，提交申请不等于退款已经完成。',
    sections: [
      { title: '从原订单处理', paragraphs: ['在”我的订单”打开对应订单，查看可用的售后入口和当前进度。如果商品已明确说明不支持售后质保，订单会显示相应提示。'] },
      { title: '金额和进度以订单为准', paragraphs: ['订单会根据实际情况显示可申请金额、审核或自动处理状态。不要将”可申请”理解为所有情况都能无条件退款，也不要将提交时间当作到账承诺。'] },
      { title: 'ChatGPT 订阅的质保范围', paragraphs: ['ChatGPT Plus 和 Pro 订阅享有 30 天质保，从订单显示充值成功时起算。30 天内因非用户原因导致订阅中断，可从原订单联系支持处理。多人共享、反向代理、违规使用和主动拒付属于用户原因，不在质保范围内。质保订阅本身，不质保封号。'] },
      { title: '说明问题时保护凭据', paragraphs: ['填写发生的问题及必要截图，不填写账号密码、Session、邮箱验证码或完整卡密。申请后的服务状态和后续操作以原订单提示为准。'] },
    ],
  },
  {
    slug: 'open-plus-in-china', category: 'buying', title: '国内怎么开通 ChatGPT Plus？不用信用卡可以吗？',
    answer: '可以。在本站用支付宝付款，Plus 会员开在你自己的 ChatGPT 账号上，不需要海外信用卡，也不需要把账号密码交给任何人。Plus 每月 ¥138。',
    keywords: '国内开通 没有信用卡 支付宝 国内怎么买 Plus 国内订阅 大陆购买',
    sections: [
      { title: '为什么自己开通比较难', paragraphs: ['ChatGPT Plus 官方价格为每月 20 美元，只能用海外信用卡、Apple 或 Google Play 付款，不支持支付宝和微信。国内发行的银行卡经常被拒。'] },
      { title: '在本站开通的步骤', paragraphs: ['1. 在 ChatGPT 商品页选择 Plus，核对购买须知，填写可以正常收信的邮箱，用支付宝付款。', '2. 付款后回到原订单，按页面指引获取并提交要充值账号的完整 Session。不需要提供密码或短信验证码。', '3. 在原订单查看进度。显示完成后，刷新 ChatGPT 即可看到 Plus 会员。多数订单 3 分钟内完成。'] },
      { title: '下单前确认', paragraphs: ['如果账号当前还有未到期的订阅，充值可能失败，原订单会提示”当前订阅尚未到期”。请先在 ChatGPT 的”设置 → 我的套餐”里查看当前套餐和到期时间。还没有 ChatGPT 账号的，可以先在 chatgpt.com 免费注册。'] },
    ], related: '/product/chatgpt',
  },
  {
    slug: 'plus-vs-pro', category: 'buying', title: 'ChatGPT Plus 和 Pro 有什么区别，该怎么选？',
    answer: '日常写作、学习和偶尔写代码，选 Plus 就够。每天大量使用 Codex、深度研究，或者 Plus 额度经常用完，再考虑 Pro。',
    keywords: 'Plus Pro 区别 Pro 100 Pro 200 Pro 500 5x 10x 20x 25x 额度 价格',
    sections: [
      { title: '本站套餐与官方档位', paragraphs: ['Plus 对应官方 Plus（$20/月），本站 ¥138。Pro 有三档：Pro 5× 对应 Pro 100（$100/月），本站 ¥699；Pro 10× 对应 Pro 200（$200/月），本站 ¥1350；Pro 25× 对应 Pro 500（$500/月），本站 ¥3500。'] },
      { title: '官方说明的主要区别', paragraphs: ['根据 OpenAI 定价页和帮助中心：Pro 包含 Plus 的全部功能，另外提供 GPT-6 Astra 专业推理、更长的 Codex 和”ChatGPT 工作”会话、更大的上下文窗口（推理模型 400K，Plus 是 256K），以及每月 API 额度。三档 Pro 中，Pro 200 的用量比 Pro 100 多，Pro 500 最多，并且只有 Pro 500 包含 Ultrafast 模式。Pro 只能按月订阅，官方没有年付。', '各档的具体额度由 OpenAI 决定，并且会调整。本站不承诺具体倍数，以 chatgpt.com/pricing 和 OpenAI 帮助中心为准。'] },
    ], related: '/product/chatgpt',
  },
  {
    slug: 'is-it-safe', category: 'account', title: '在本站充值安全吗？会不会封号？',
    answer: '会员开在你自己的账号上，本站不需要你的密码。充值只是换了一种付款方式，不会改变 OpenAI 的使用规则，所以没有平台能保证”永不封号”。',
    keywords: '安全 封号 代充安全吗 密码 风险 会不会被封',
    sections: [
      { title: '本站怎么保护你的账号', paragraphs: ['下单和充值都不需要 ChatGPT 密码或短信验证码。需要提交 Session 的套餐，只在原订单的账号连接步骤提交，不要发给任何私信联系你的人。Session 是临时登录凭证，在 chatgpt.com 退出登录后会失效。'] },
      { title: '哪些行为容易触发风控', paragraphs: ['OpenAI 的使用条款禁止共享账号、转售访问权限和自动抓取数据。多人共用一个账号、频繁切换登录地区、使用反向代理，都更容易被限制。正常一个人使用自己的账号，风险相对较低。'] },
      { title: '出了问题怎么办', paragraphs: ['ChatGPT Plus 和 Pro 订阅享有 30 天质保，从订单显示充值成功时起算。30 天内因非用户原因导致订阅中断，可从原订单联系支持处理。多人共享、反向代理、违规使用和主动拒付属于用户原因，不在质保范围内。质保订阅本身，不质保封号。', '本站是独立服务商，与 OpenAI 没有授权、代理或合作关系。'] },
    ],
  },
  {
    slug: 'invoice', category: 'order', title: '可以开发票吗？公司能报销吗？',
    answer: '可以。本站可开增值税普通发票。需要开票请在付款后从原订单联系客服，提供订单号、发票抬头和税号。',
    keywords: '发票 报销 增值税普通发票 开票 公司 抬头 税号',
    sections: [
      { title: '如何申请发票', paragraphs: ['在”我的订单”打开已付款的订单，点击”联系客服”，说明需要开具发票，并提供发票抬头（个人或企业名称）和纳税人识别号。客服确认后会将电子发票发送到下单邮箱。'] },
      { title: '开票时间', paragraphs: ['提交开票申请后，客服会在工作时间内处理。具体时长以实际处理进度为准，可在原订单跟进。'] },
    ],
  },
  {
    slug: 'renewal-before-expiry', category: 'buying', title: '现在的会员还没到期，可以续费吗？',
    answer: '先查看 ChatGPT 当前套餐和到期时间，再核对所选规格的续费条件。不同规格的限制可能不同。',
    keywords: '已有订阅 会员没到期 有效订阅 叠加 续费限制 account_has_subscription',
    sections: [
      { title: '购买前确认规格', paragraphs: ['在 ChatGPT 核对订阅状态，再看本站商品说明中的新开或续费条件。如果不确定该规格能否用于当前账号，从原商店联系支持确认。'] },
      { title: '已付款，原订单提示订阅仍有效', paragraphs: ['先查看原订单显示的原因和可用操作。若订单允许重试，到满足条件时再回原订单继续。'] },
    ], related: '/product/chatgpt',
  },
  {
    slug: 'account-credentials', category: 'account', title: '充值时，需要把账号密码发给客服吗？',
    answer: '无需把 ChatGPT 密码或验证码发给客服。若所购套餐要求提交 Session，只在原订单的账号连接步骤提交。',
    keywords: '账号安全 密码 验证码 token Access Token 凭据 隐私 如何获取 Session',
    sections: [
      { title: '在订单页查看获取说明', paragraphs: ['付款后打开原订单。如果页面要求连接账号，先确认当前登录的是要充值的 ChatGPT 账号，再按订单里「获取 Session 说明」操作。'] },
      { title: '联系支持时提供订单号', paragraphs: ['遇到问题可以发订单号和报错文字。提交截图前遮住密码、Session、验证码和完整卡密。'] },
    ],
  },
  {
    slug: 'session-expired', category: 'account', title: 'Session 已过期或无权访问，怎么办？',
    answer: '先在 chatgpt.com 退出并重新登录要充值的账号，再按原订单说明获取新的完整 Session。已付款的订单允许重试时，直接在原订单继续，无需再次付款。',
    keywords: '重新获取完整Session后重试 请重新获取完整Session后重试 session无效 凭据失效 核验失败 账号校验失败 JSON 复制不完整 浏览器翻译 连接账号 session expired access denied',
    sections: [
      { title: '1. 重新登录要充值的账号', paragraphs: ['保留原订单页面，在同一个浏览器另开标签页，到 chatgpt.com 退出并重新登录。用原来的登录方式，在 ChatGPT 的账户设置核对账号，尤其是用 Apple 登录或有多个账号时。'] },
      { title: '2. 确认复制了完整的 Session', paragraphs: [
        ['按订单里的「获取 Session 说明」打开获取页。如果只显示 ', { code: '{}' }, '，表示页面返回的是空对象。先确认已在同一浏览器登录，再刷新获取页。'],
        ['复制时，从开头的 ', { code: '{' }, ' 到结尾的 ', { code: '}' }, ' 都要包含。手机上可以用「全选」，保留页面返回的完整内容。'],
        '如果仍提示核验失败，关闭获取页的自动翻译，暂时停用可能改写页面内容的插件，再刷新并重新复制。也可以换个浏览器重新登录并获取，两步都在同一浏览器完成。',
      ] },
      { title: '3. 回原订单按提示重试', paragraphs: ['打开「我的订单」，找到已付款的原订单，进入「连接你的账号」。如果显示「更换 Session 后重试」，先点它打开表单。如果表单已展开，直接粘贴新获取的 Session，核对表单显示的账号，再按页面提示提交。', '如果显示「提交待确认」，先点「刷新进度」。仍待确认时，按提示用原资料核对同一次提交，等订单允许更换资料时再提交新的 Session。'] },
      { title: '4. 这些情况请联系客服', paragraphs: ['重新登录并完整复制后仍报错、已付款却找不到重试入口，或刷新后一直显示提交待确认时，在原订单点「联系客服」。提供订单号和报错文字即可。请把 Session 留在订单表单内，截图中也要遮住登录凭据。'] },
    ],
  },
  {
    slug: 'save-session', category: 'account', title: '加密保存 Session 有什么用？可以取消吗？',
    answer: '如果原订单提供加密保存选项，勾选后可在资料仍有效且订单允许时，用原资料重试同一笔订单。你可以在提交前取消勾选。',
    keywords: '默认勾选 取消保存 不保存 保留资料 保存期限 留存 账号资料 数据安全',
    sections: [
      { title: '保存只用于这笔订单', paragraphs: ['页面出现「加密保存 Session」时，提交前可以自行选择。取消勾选后仍可继续提交；如果之后需要重试，再按订单提示提供资料。'] },
      { title: '保存后资料也可能失效', paragraphs: ['原资料能否继续使用，以订单上显示的状态和按钮为准。如果页面提示资料不可用，请在原订单提交新的 Session。'] },
    ],
  },
  {
    slug: 'apple-login', category: 'account', title: '用 Apple 登录的 ChatGPT 账号可以充值吗？',
    answer: '本站有通过 Apple 登录的账号充值案例。购买前，请联系客服确认你的账号和所选套餐是否适用。',
    keywords: 'Apple ID 苹果登录 隐藏邮箱 Apple 账户',
    sections: [
      { title: '确认要充值的 ChatGPT 账号', paragraphs: ['用原来登录 ChatGPT 的方式，进入账户设置核对账号。使用了隐藏邮件地址时，ChatGPT 显示的邮箱可能和你平时使用的邮箱不同。'] },
      { title: '核对要买的服务', paragraphs: ['这里的充值指 ChatGPT 订阅。确认套餐适用后，在原订单按提示连接已核对的 ChatGPT 账号。'] },
    ], related: '/product/chatgpt',
  },
  {
    slug: 'recharge-in-progress', category: 'activation', title: '订单显示充值中，还要等多久？',
    answer: '打开原订单查看最新进度。多数订单 3 分钟内完成，不同套餐和处理状态的用时可能不同，以商品说明和订单状态为准。',
    keywords: '到账时间 什么时候到账 刷新进度 等多久 转圈 提交待确认 超时',
    sections: [
      { title: '看订单上显示的进度', paragraphs: ['如果页面提示先连接账号，请按订单指引提交。已经提交、页面显示「正在充值」时，可以稍后回原订单查看。多数订单 3 分钟内完成。'] },
      { title: '页面提示提交待确认', paragraphs: ['先点「刷新进度」，并按订单提示核对这一次提交。仍有疑问时，带订单号联系支持。'] },
    ],
  },
  {
    slug: 'confirm-recharge', category: 'activation', title: '怎么确认订阅或 Codex 点数已经到账？',
    answer: '先在原订单确认显示「充值已完成」，再登录该订单对应的 ChatGPT 账号，查看订阅套餐或 Codex 点数。',
    keywords: '怎么确认开通 到账确认 充值结果 查看订阅 查看点数 购买完成',
    sections: [
      { title: '先核对原订单', paragraphs: ['打开「我的订单」，对照商品名称和页面显示的账号线索，确认查看的是这次要核对的订单。付款确认后还可能需要连接账号。'] },
      { title: '再到账户里确认', paragraphs: ['购买会员就查看 ChatGPT 的订阅套餐；购买点数就查看对应账号里的 Codex 用量或点数。若订单已完成但权益显示不一致，从原订单联系支持。'] },
    ],
  },
  {
    slug: 'completed-still-free', category: 'activation', title: '订单已完成，为什么 ChatGPT 还是免费版？',
    answer: '先确认原订单的充值结果，再核对 ChatGPT 账号并重新登录。如果订单确认完成，这个账号仍显示免费版，请从原订单联系客服核查。',
    keywords: '显示 Free 仍显示 Free 未生效 会员没显示 已完成没到账 没看到 Plus 充值成功',
    sections: [
      { title: '1. 查看原订单的充值状态', paragraphs: ['在「我的订单」打开对应订单，核对商品和规格。若页面还要求连接账号，就先按订单指引提交。若显示「正在充值」，稍后回原订单刷新进度。处理时间以所购套餐的商品说明和原订单状态为准。'] },
      { title: '2. 核对账号并刷新订阅状态', paragraphs: ['确认充值完成后，到 ChatGPT 的账户设置核对当前账号。用订单显示的账号线索核对，有多个账号时尤其要注意。然后刷新网页或完全关闭并重开 App。仍显示免费版时，退出并用原来的方式重新登录同一个账号，再查看订阅。'] },
      { title: '3. 根据原订单提示决定是否重试', paragraphs: ['如果原订单提示「充值未完成」并提供重试入口，可在同一笔订单按提示选「使用原资料重试」或「更换 Session 后重试」，无需再次付款。若提示「提交待确认」，先刷新进度，再按提示核对原提交。订单已确认完成时，直接请客服核查。'] },
      { title: '4. 确认已完成仍显示免费版，请联系客服', paragraphs: ['核对账号并重新登录后仍显示免费版，或订单提示未完成却没有重试入口时，从原订单点「联系客服」。提供订单号和订阅页截图，发送前遮住邮箱等个人信息。核查期间请保留这笔订单，避免重复下单。'] },
    ],
  },
  {
    slug: 'retry-original-order', category: 'activation', title: '充值未完成，可以在原订单重试吗？',
    answer: '已付款的订单如果提供重试入口，可以在同一笔订单继续，无需再次付款。先看页面提示的原因和可用按钮。',
    keywords: '充值失败 充值未完成 原订单 原资料 重试 换 Session 再付一次 补发',
    sections: [
      { title: '仍可使用上次的资料', paragraphs: ['如果显示「使用原资料重试」，核对账号后再操作。若显示「核对原提交」，就按提示查询这一次提交的结果。'] },
      { title: '订单提示换资料或联系支持', paragraphs: ['如果原资料已失效且页面允许重新提交，按指引提供新的 Session。如果订单处于售后处理、退款或关闭状态，按页面提示查看进度或带订单号联系支持。'] },
    ],
  },
]

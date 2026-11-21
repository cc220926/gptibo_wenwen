# 主站 SEO / GEO 基础建设

## 版本与边界

分支 `codex/seo-foundation`，基于线上发布提交 `d7df5ef63ba99577048baf2ab28512ee4d51c2df`。发布标签中的 Workers 版本和本次只读查询的当前版本均为 `ddc27a73-f3ac-4414-a8b6-64653251817d`。本分支不包含尚未上线的首页设计分支，不合并、不部署、不修改生产配置、数据库或供应商设置。

原 `worker/index.ts`、commerce、订单、支付、回调、交付、定时任务、数据库迁移、订单 Hook、商品详情组件和充值教程均保持原文件。App 只增加元信息同步 effect 和页脚的购买指南链接，业务 AST 与发布基线一致。

## 实现

- 新入口 `worker/storefront-entry.ts` 将所有 `/api/` 请求以原 Request 和 Env 直接转给原处理器，返回原 Response；scheduled 直接引用原函数。未读取、克隆或改写回调正文。
- 仅精确配置的主站来源启用 SEO。配置缺失、格式不合法或来源不一致时保持原站行为，分站、自定义域名和推广路径不会自动获得收录权限。
- 公共 HTML 通过既有主站 `/api/catalog` 处理逻辑读取零售价、商品形象、可售状态、隐藏及下架信息。使用只允许单条 SELECT、禁止 run 和 batch 的数据库适配器，不传入 Cookie、访客参数或分站身份；不调用支付、供货或邮件服务。
- 首页和有效商品页在原 React 挂载点提供可直接读取的 HTML；JavaScript 加载后仍是原展示和交易界面。未启用 JavaScript时为简洁的文字、规格表及导航，不是完整交互界面。
- 独立生成 robots 和 XML sitemap；仅包含首页、当前公开商品、指南目录和五篇文章。按目录数据动态生成，不把隐藏商品、未知商品、订单、后台、API 或分站放入地图。不存在的内容页返回真实 noindex 404。
- 首页、商品页和指南页提供标题、描述、canonical；查询参数不进入规范网址。规范化首页别名及结尾斜线，保留跳转请求的普通查询参数。
- SPA 进入订单页移除 canonical 并设置 noindex；从直接访问的订单页返回公开页面也能恢复元信息。订单 HTML 只增加来源标记，仍为空的私有应用壳，不注入任何订单数据。
- 全局静态文件的 noindex 和安全头仍保留。公开响应单独设置安全头与收录头；公开内容用 no-store，避免跨身份缓存。HEAD 无正文。
- 公共目录读取超过 1.5 秒时不等待 SEO 完成，公开应用回退到原页面并保持 noindex；sitemap 故障返回可重试的 503，不冒充有效 XML。这个时限不取消已经开始的 D1 只读操作。
- 通用 robots 允许搜索爬虫访问公开内容，继续禁止私有路径；GPTBot 单独禁止抓取。搜索抓取与训练许可分开处理。没有专用 AI 文件、虚构评价、评分或“保证被推荐”的标记。

## 内容与界面

新增 `/help/` 及以下独立文章：

1. `/help/recharge-or-account`：充值与成品账号的区别。
2. `/help/codex-credits`：点数、订阅和接码的区别。
3. `/help/after-payment`：付款后的操作与账号连接。
4. `/help/order-recovery`：原浏览器、下单邮箱和订单找回。
5. `/help/after-sales`：售后入口、适用条件及状态说明。

内容依据仓库的 `shared/codex-credits.ts`、`src/lib/products.ts`、`src/components/order-services.tsx`、`worker/customer-auth.ts`、公开目录与既有订单界面核对；不推断品牌授权、官方额度、到账时长或退款结果。ChatGPT 教程通过既有商品页查看，没有替换原图。首页不新增长篇教程或评价墙，仅增加指南入口。缺少已获授权、脱敏的真实微信截图，评价模块暂不发布。

## 启用与回退

本分支代码和示例配置中的 `STOREFRONT_SEO_ORIGIN` 默认为空，SEO 默认关闭。忽略的生产配置未修改，源文件中的中性 noindex 页面和 robots 仍为安全默认值。

未来经部署流程使用时，需要在同一次版本中检查三个配置：

- `main` 指向 `worker/storefront-entry.ts`。
- `assets.run_worker_first` 为 `true`，否则根页面或导航可能被静态 SPA 回退绕过。保持原 ASSETS 绑定、资源、cron、密钥及所有业务开关。
- `STOREFRONT_SEO_ORIGIN` 设置为经核实的主站 HTTPS 来源，只含协议和主机。只有本机验收允许 loopback HTTP。不得填后台域名、分站域名或生产凭据。

关闭该来源配置会恢复默认禁止收录行为，不能代替需要时的整个版本回退。尚未上线，本轮不创建发布标签。

## 验收与复现

```sh
npm test
node --import ./scripts/seo-regression-loader.mjs --test tests/*.test.ts
node scripts/verify-seo-scope.mjs
npm run build
npm run lint
npm run security:scan
git diff --check
```

验收基线 689 项通过。新增 17 项测试后，共 706 项通过；通过 loader 将未改写的原业务测试切换到新入口，验证新入口下的订单、支付、回调幂等、退款、库存交付、充值、权限及定时任务行为。原测试文件和 fixture 均未修改。

范围审计逐文件对比 815 个受保护文件的 SHA-256，并以 TypeScript AST 排除明确允许的元信息 effect 和指南链接后比较整个 App。它不代替业务测试或生产负载验收。

本地 Workers 使用独立 D1、主站公开目录快照，真实支付和供货开关关闭。HTTP 验收解析 XML 并逐条访问全部 11 个公开网址，验证 GET/HEAD、唯一 h1/canonical、收录头、安全头、Cookie 缺失、私有页 noindex、404 以及 Googlebot、bingbot、OAI-SearchBot 和 GPTBot 规则。浏览器验证了首页到商品、订单、返回首页、独立订单入口和指南，手机及桌面未检测到横向溢出，未发现控制台错误。

原始红灯、绿灯、基线、构建、HTTP 产物、浏览器记录、截图及文件哈希保存于忽略的 `artifacts/seo-foundation/`。本次工作目录为独立 worktree；这些验收材料不提交。

## 上线后工作与当前限制

这些项目需要正式部署或站点所有权，本次仅提供执行清单，不声称已完成线上操作：

- 在 Google Search Console 和 Bing Webmaster Tools 验证主站所有权，提交 sitemap，抽查公开网址的实际抓取及渲染结果。
- 检查生产 Cloudflare WAF / Bot 设置和访问日志，核对搜索爬虫的官方 IP 范围，避免把宽松 User-Agent 白名单当成身份校验。未修改或验证生产 WAF 放行效果。
- 按周记录有效收录、查询展现、点击、落地页、可获得的 Bing AI 引用数据及有效咨询/购买。Google 搜索的 AI 相关流量按其现有报表口径观察，不虚构独立引用排名。
- 公开 HTML 比原站增加目录只读开销；本地响应验证不能证明生产高并发性能。上线前后需要观察 D1 读取、页面延时、错误率和履约队列，出现新增异常应回退。
- 收录、排名及 AI 引用由外部平台决定，本地测试和允许爬虫均不构成效果保证。

Go 后端 CI 在发布基线上已有前端契约和 D1 导入结构相关失败；原业务文件哈希保持一致。本机未安装 Go，不能将 Node 测试通过称为全仓库 CI 全绿。远程 CI 状态和本次对照结果记录于验收约定文件。

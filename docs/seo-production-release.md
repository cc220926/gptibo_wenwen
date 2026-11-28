# SEO production release

## 2026-11-28 Claude API 商品卡

- 主站 `gptpay1688.com`，部署源码 `8e33ab49a40da939685b8292cf045d64e961a347`（`codex/claude-api-catalog-card`），发布标签 `release-2026-11-28-claude-api-card`。基线为博客版 `9881145`、Worker `de398db3-23b0-4f31-80e5-18110c178f6e`。
- 生产 Worker：`27eab594-2a96-49d3-8a88-9990fd64cd50`；deployment：`4b8b5ce1-8fac-435b-8cf2-f0b2320636cf`。兼容回退 Worker：`2f21e453-c73b-4354-a94a-fc59a6fb8427`；deployment：`3adfff9c-0f9f-4159-b618-5189885f18cd`。
- 商品列表使用确认过的原动态 WebP，生产响应与原文件逐字节一致。完整图片为一个普通链接，未经裁切、重编码或加文案。桌面、手机均验证了尺寸、动画与指定商品页导航；目的地独立请求返回 200，未下单。
- 两代依赖图各 23 个文件，在兼容回退版和新版均校验状态、MIME、尺寸与 SHA-256。两版保留现网全部 59 个绑定和生产配置；未改订单、支付、履约或数据库。11 项商品价格及开关未变化，订单与找回会话接口通过冒烟。
- 774 项测试、构建、lint、公开源码扫描、`git diff --check` 通过。私有配置和验收证明放在本机忽略目录 `artifacts/releases/2026-11-28-claude-api-card/`。需要回退时先确认线上仍为本次候选，不覆盖其他发布，不运行数据库迁移。
- 北京时间 11 月 28 日 23:55、11 月 29 日 00:00 两轮对账正常，观测中无 5xx、运行异常或队列失败；支付一致性和履约队列聚合不变。观察窗口内无新真实订单，未验证真实付款和交付。

## 2026-11-28 SEO 价格表与帮助文章

- 主站：`gptpay1688.com`。部署源码为 `b26403f1ffb12bde07af7f1fd56d801a042f6e3c`（`codex/seo-geo-content`），发布标签为 `release-2026-11-28-seo-pricing`。
- 生产 Worker：`9d64a3f8-86e0-408a-895d-b1c9cf9c742f`；deployment：`0472a847-46eb-4205-8b5e-15e9f4017f37`。
- 兼容回退 Worker：`53464516-4891-459a-ad11-8611717eb1d0`；首次生效的 deployment：`00e2d791-9c37-48fb-903f-ee96fcffa259`。业务源码基线为 `a27d6d4`（`release-2026-11-27-gemini-codex-swap`）。
- 先切换兼容回退版，核对生产域名能返回两代资源，再切换候选版。两个包均含新旧资源及 `pricing-v1.css`；两代依赖图分别为 22 和 23 个文件。生产核对 HTTP 状态、MIME、大小、SHA-256。
- 私有部署配置由实际线上基线 `349db678-ceb9-4058-9d00-ae8fa08bef8e` 生成，上传使用 `--keep-vars`。57 个绑定中的 28 个业务变量、23 个密钥绑定名、4 个限流器、D1 和静态资源绑定均一致；域名、每分钟 Cron、安全头、`run_worker_first` 与 SEO origin 保持不变。未迁移数据库、改支付/履约配置或配置 IndexNow 密钥，未提交索引。
- 候选 773 项测试全部通过；构建、lint、公开源码扫描、`git diff --check` 通过。历史 `verify-storefront-scope.mjs` 的旧 allowlist 在基线及候选均不通过；本次相对基线未改下单、支付、交付、Worker 入口或迁移文件。
- 线上核对 `/pricing`、4 篇帮助文章、`llms.txt`、站点地图、订单页 noindex 与分站隔离。首页及商品页加载骨架仅新增价格表入口，没有价格或选购表；旧版 `<noscript>` 保留“启用后即可选购”提示。11 项目录价格和开关与发布前一致，买家初始化、空订单列表及找回入口正常；空下单返回 400 且订单列表仍为空。桌面与移动浏览器均打开下单和找回表单，未填资料、发邮件、创建真实订单或付款。
- 2026-11-28 17:10 和 17:15（Asia/Shanghai）两轮对账事件均正常。观测到的新版流量无 5xx、运行异常或队列失败日志；最终配置复核一致。支付金额与订单状态无不一致，履约队列及充值待核验聚合不变。窗口内没有新真实订单或供应商到账事件，未验证实际付款与交付。

需要回退时，先确认生产 100% 流量仍指向本次候选，再将兼容回退版本切至 100%。回退不运行迁移，不还原数据库。私有配置、双资源包、上线前后快照及白名单监控证据留在本机 `artifacts/releases/2026-11-28-seo-pricing/`，不纳入 Git。

**更早的原订单重试发布见 [原订单重试上线记录](recharge-retry-production-release.md)。**

客户反馈与选购帮助修复于 2026-11-22 10:04:56 Asia/Shanghai 发布，以下为当时的版本记录。

- 运行源码：`abe82acc29d406a695551956a4fa7b0d0bb71d5e`，分支 `codex/customer-feedback-preview`。
- Worker：`6908b099-a207-4185-870a-a627b6fdf336`；deployment：`afc50df8-73f2-4dca-a79a-358858b1da07`。
- 源码标签：`release-2026-11-22-feedback-help`。
- 当时兼容回退：`d6170e1f-9d1e-4311-b284-672543f0fc0a`；deployment：`f403b02a-e307-4b63-b726-c18ac5fdc220`；2026-11-22 10:00:10 Asia/Shanghai 生效。
- 回退源码：`31975c9be06570705d84c915436c24f34f495319`；标签：`release-2026-11-22-feedback-rollback`。

下方旧首页和 SEO 发布记录为历史。旧回退 `5e5085e6`、`c955856c` 不含本轮反馈图片及脚本，不能作为本次兼容回退目标。

## 客户反馈与选购帮助正式发布记录

用户明确要求“上线”。本轮将七段真实微信沟通记录、Apple 登录和 Session 帮助、短窗口滚动及报错搜索修复发布到主站。首页仍只显示两张反馈卡，点击“查看全部反馈 (7)”选择完整记录；保留头像，续费截图中 130 元金额遮挡。商品详情、下单、支付和履约处理代码不变。

### 配置与回退保护

先发布兼容回退版本，再发布新版；每个包 58 个文件，均包含此前所有静态资源和新反馈资源。116 个文件逐一验证字节及 SHA256；两包只有 `index.html` 使用各自版本内容，所有同名资源均一致。新版和兼容版在生产域名各核对 55 个公开静态文件，含全部七张反馈 PNG。发布前已打开的旧页面跨两次部署后仍能进入原订单页。

最终云端审计于 02:11:06 UTC 确认 57 个绑定、27 项业务变量、23 个密钥绑定名、D1、每分钟 Cron、域名、四项限流、Worker 优先入口和安全头保持原值。部署使用 `--keep-vars`；未读取云端密钥值，验证的是密钥绑定名及既有保留机制。私有生产配置文件未修改，SHA256 仍为 `f2aba589e36de3ed4bd68b6c1cc51c147a4e55a2c9d0225a7c7e34f57e3f03fc`。未执行数据库迁移、数据重置或支付/供应商配置变更。

本机归档位于主检出目录忽略路径 `artifacts/releases/2026-11-22-feedback-abe82ac/`，含精确源码快照、双资源包、完整清单、配置和验收证据。若确认本版本引入下单/履约错误、资源缺失、业务配置漂移或新增运行异常，应立即回退；执行前必须再次确认线上仍为本轮候选版本，不能覆盖之后的其他发布。回退不运行迁移、不还原数据库：

```sh
WRANGLER_WRITE_LOGS=false node_modules/.bin/wrangler rollback d6170e1f-9d1e-4311-b284-672543f0fc0a \
  --config artifacts/releases/2026-11-22-feedback-abe82ac/rollback-only.json \
  --yes --message 'Restore compatible homepage after confirmed feedback release regression'
```

### 验证与实际观察

- 配置中的真实 Worker 入口回归 737/737；生产业务开关下的隔离协议、共享数据库和回退演练 3/3。供应商及支付服务采用隔离模拟，不访问真实外部履约接口。首次演练漏传 fixture 文件导致设置错误，已保留日志，补齐配置后 3/3 通过。
- 812 个受保护文件及交易相关 AST 与基线一致，构建、源码扫描和差异检查通过。公开源码扫描 861 路径、0 发现；此前 lint 仅原有五条警告。
- 兼容版和候选版各 20 项 HTTP 检查通过：目录价格和业务开关、首屏与入口哈希、四类商品页、买家初始化、订单与找回配置、空下单请求返回 400 且没有创建订单。
- 生产浏览器验证桌面和 390×844 手机布局；七条反馈都能选择并加载，仅挂载一张大图，金额遮挡有效。十项帮助可展开/收起，“Session 已失效”能找到重新登录后在原订单重试的方法。390×350 短窗口内滚动和原订单跳转正常，关闭后没有残留弹窗或滚动锁。此为浏览器视口模拟，不等同真机系统键盘验证。
- ChatGPT Pro 10×、Codex 500 点、Plus 成品号表单分别显示 ¥1350、¥199、¥85，空邮箱不能继续付款。未填写真实邮箱、提交付款、发送验证码或账号凭据，也未操作 CAPTCHA。
- 02:05:29.493、02:10:29.493 UTC 两个对账周期均 `ok`、异常 0、队列错误 0。实际 Cron 每分钟触发，按 `worker/index.ts` 中 `Math.floor(scheduledTime / 60000) % 5 === 0` 判定五分钟对账，而不是匹配 Cron 字符串。整个候选有界观察共 213 个事件、7 次调度，HTTP 为 189×200、16×304、1×预期空单 400，没有 5xx、运行异常、资源超限、队列失败或断流。观察结束后主动关闭监控，退出码 0。
- 最终聚合窗口 02:04:56.795—02:11:02.065 UTC：无新订单、支付回执、充值提交或验签回调；出现一次 `payment-closed → cancelled` 历史订单事件，未见与候选关联的新业务异常。原有 1 笔等待 Session 的已付订单、22 条充值记录均不变。通知与验证积压、租约、资金保留、采购和交付队列均为 0；已付款回执与订单不一致和金额不匹配均为 0。
- 独立复核源码与资源包、线上配置、HTTP、聚合记录以及全部六张生产截图，未发现新增阻断项，未触发回退。

### 证据边界

没有新的真实付款/履约样本，不能宣称真实支付回调、供应商和邮件已完成端到端联调。浏览器有 8 条来自 Cloudflare Turnstile iframe 的隐藏诊断日志，未见主站来源脚本错误；未完成挑战，不据此宣称 CAPTCHA 验证通过或这些第三方日志绝对无害。此前独立 Go 后端 CI 的基线失败仍不在本次 Workers 发布范围，本轮未重跑或修复它。

早期 `shortHelp` 与 `gallery` 记录分别处于视口调整和图片加载过渡；最终验收使用 `shortHelpStable` 与 `galleryFinal`。资产审计初次将两份 LICENSE 和一份 README 错按字体/图片 MIME 校验，失败证据已保留；仅对三个精确文本路径修正规则，200 状态、字节和 SHA 校验未放宽，独立复核后两包各 55 项全部通过。

证据索引为 `evidence/acceptance-matrix.json`、`final-active.json`、`http-candidate.json`、`candidate-remote-assets.json`、`browser-production-checks.json`、`final.json`、`comparison-before-final.json`、`tail-summary.json`、`resource-manifest.json` 和 `screenshots/`，均保存在本机忽略归档，不提交私有配置、凭据、客户数据、构建输出或临时验收文件。本轮是有界上线观察，不建立持续后台监控。

## 此前首页与首屏修复发布历史

2026-11-22，用户明确要求“发布”。已发布首页改版及 SEO 首屏修复，并完成两个五分钟对账周期的观察。未发现新增回退触发项，当前保持新版。此前“暂不上线”的预览记录为历史阶段。

### 版本与回退

| 项目 | 记录 |
| --- | --- |
| 主站 | https://gptpay1688.com |
| 发布分支 | `codex/homepage-seo-preview` |
| 运行源码 | `31975c9be06570705d84c915436c24f34f495319` |
| 源码标签 | `release-2026-11-22-homepage-seo` |
| 当前 Worker 版本 | `15a92bbc-5a69-46c3-9ced-e2c894bf5933` |
| 当前 deployment | `45c38369-64f4-4a04-8364-8932c5c9a366` |
| 生效时间 | 2026-11-22 00:30:32 Asia/Shanghai / 2026-11-21 16:30:32 UTC |
| 兼容回退版本 | `5e5085e6-4036-40b1-9088-d5a13e122ba2` |
| 回退 deployment | `7cc389b6-72d7-4ef5-8071-7a1f7d4569dc` |
| 回退源码 / 标签 | `d7df5ef63ba99577048baf2ab28512ee4d51c2df` / `release-2026-11-22-homepage-rollback` |

先于新版上线的兼容版本使用原业务代码和 HTML，同时保留 `d7df5ef`、此前 SEO 版本 `bc68dd48`、本轮 `31975c9` 三代静态资源。每个包 46 个文件；两包合计 92 个文件逐一验证 SHA256。候选和兼容版本在生产域名上的 27 个依赖资源均通过状态、MIME、大小和哈希校验。旧页面保持打开跨越两次部署后仍可进入订单页。

本轮不能回退到旧兼容版本 `c955856c`：它没有本轮首页资源。应使用上表的 `5e5085e6`。回退不还原数据库，也不运行迁移。发布归档保存在主检出目录被 Git 忽略的 `artifacts/releases/2026-11-22-homepage-31975c9/`，包含双资源包、哈希清单、只读证据和仅用于云端回退的配置。执行前须先确认当前线上版本仍属于本次发布：

```sh
WRANGLER_WRITE_LOGS=false node_modules/.bin/wrangler rollback 5e5085e6-4036-40b1-9088-d5a13e122ba2 \
  --config artifacts/releases/2026-11-22-homepage-31975c9/rollback-only.json \
  --yes --message 'Restore compatible version after confirmed homepage regression'
```

### 发布内容与配置

首页新增开通演示、选购帮助、售后流程示例三个面板，保留主站四类商品。充值演示复用原教程；未将示例当作真实微信评价。首屏不再注入独立商品表格，脚本加载时显示占位及重试、帮助入口，成功后显示新版首页。商品详情及交易处理保持原逻辑。

最终云端只读审计于 16:40:43 UTC 确认：原 55 个绑定、27 项业务变量、23 个密钥绑定名、D1、Cron、域名、原三项限流和安全头均保持。密钥值不可通过该 API 回读；验证的是密钥绑定名及 Wrangler 默认保留 secret 的机制，普通变量另由 `--keep-vars` 保留。主检出的私有生产配置未修改，SHA256 为 `f2aba589e36de3ed4bd68b6c1cc51c147a4e55a2c9d0225a7c7e34f57e3f03fc`。未执行数据库迁移、数据重置、支付或供应商配置修改。

候选启用 `worker/storefront-entry.ts`、Worker 优先处理静态入口、主站 SEO origin 和独立 SEO 目录限流（6 次/60 秒）。旧版本回退后，脚本级设置仍有此前的 origin/SEO limiter；本次预检确认其归属同一个 Worker，复用原 namespace。兼容部署保留该无业务作用的 origin，未将它误认作业务配置变化。

### 验证与实际观察

- 发布前 configured-entry 回归 733/733，live 模式隔离协议与共享数据库回退 3/3；812 个受保护业务文件及交易相关 AST 与基线一致。发布前再次构建与校验源码、资产和首屏检查。
- 兼容版本 14 项、候选版本 20 项生产 HTTP 检查通过，包括目录价格、真实业务开关、初始 HTML、资源哈希、四类商品页、买家初始化、空订单列表、Turnstile/找回配置，以及空下单请求返回 400 后仍无订单。
- 实际浏览器检查桌面首页及 390×844 手机首页，均无横向溢出和旧商品表格；原教程正常。Pro 10× 的摘要和弹窗为 ¥1350，Codex 500 点为 ¥199，成品号为 ¥85。购买须知、邮箱表单、订单页及邮箱找回入口正常。未提交真实订单、付款、邮箱验证码或客户凭据，未操作 CAPTCHA。
- 16:35:29.493 和 16:40:29.493 UTC 两次五分钟对账调度均为 `ok`，异常数和队列失败数均为 0。观察中未发现候选版本的 5xx、资源限额或监控断流。
- 最终聚合窗口为 16:30:32.987 至 16:41:03.919 UTC，未见新建订单、真实付款回执、充值提交或验签回调；支付回执与订单的不一致和金额不匹配均为 0。通知、订单验证、任务验证积压、租约和已付资金保留均为 0，供应商采购及服务交付待办为空。
- `session` 等待用户资料的订单由基线快照的 1 笔增至 2 笔，充值记录 21→22。一次有界聚合查询确认新增订单于 16:27:46 创建、16:28:12 确认支付，均早于兼容部署和候选部署；它走上游充值支付路径，没有本地 `payments` 记录。新版窗口内的一次 `payment-closed` 是历史未付已取消订单的过期核对，并非新增付款失败。
- 独立复核实际打开七张生产截图，复核配置、HTTP 和资产证据，未发现新增阻断项。

旧预览材料中 `first-paint-failed-mobile.jpg` 与桌面慢加载截图重复，不能作为手机失败证明。本轮已明确作废该证据，重新在真实 390×844 视口验证脚本失败时重试及独立帮助入口，保存 `first-paint-failed-mobile-verified.jpg` 与测量记录；生产手机截图亦已独立复核。

### 结论边界与证据

这次观察证明页面、配置、资源兼容性、已有订单核对和定时任务未见新增异常；没有新的真实付款/履约样本，不能宣称支付、供应商和邮件已完成真实端到端联调。发布前协议回归使用模拟服务。独立 Go 后端 CI 仍有与基线相同的 5 条失败记录，来自 2 个顶层测试（其中一个含 3 个失败子用例），涉及 16 个缺失路由及 3 个 D1 错误；该后端不在本次 Workers 部署路径，不能把整个 CI 描述成全绿。源代码 CI 运行 `44920101057` 已通过。

商品正文仍由 JavaScript 渲染，不是完整 SSR；公开目录与脚本同时失败的复合场景仍可能回到原空壳。真实微信评价待取得可用的脱敏素材。本轮完成的是有界发布观察，不建立持续自动监控。

本机证据目录为工作树下被忽略的 `artifacts/homepage-production-release/`。关键索引：`acceptance-matrix.json`、`final-active.json`、`http-candidate.json`、`candidate-remote-assets.json`、`browser-production-checks.json`、`final.json`、`queue-growth-explanation.json`、`tail-summary.json`、`resource-manifest.json`。最终文件名以归档清单为准；不提交私有配置、凭据、客户数据、构建输出或临时验收文件。

## Previous release procedure and history

This release changes the public SEO entry and catalog bootstrap. The checkout,
payment, provider integrations, fulfillment handlers and database schema stay
at the protected baseline `d7df5ef63ba99577048baf2ab28512ee4d51c2df`.

## Release procedure

1. Compare the actual active Worker bindings with the private production config.
   Preserve business variables, secret bindings, D1, existing rate limits, domain
   routes and cron. Do not deploy the sanitized example config or run migrations.
2. Build two asset packages with `scripts/preprod/asset-audit.mjs`: old HTML and
   both dependency graphs for rollback; new HTML and both dependency graphs for
   forward deployment. A plain old version lacks candidate chunks; a plain new
   build lacks chunks needed by already-open old pages.
3. Obtain aggregate baseline snapshots using `buildMonitoringQueries`. Start
   `scripts/release/monitor-tail.mjs`, which persists only allowlisted metadata
   and disables Wrangler raw disk logs. Do not save raw callback traffic.
4. Deploy the compatible baseline first using the private prepared config and
   `--keep-vars`. Record its new version ID, compare active configuration, then
   verify both dependency graphs through the production domain.
5. Deploy the candidate with the same preserved configuration and `--keep-vars`.
   The only planned production changes are the storefront entry, Worker-first
   assets, the public SEO origin and an independent SEO catalog limiter.
6. Verify catalog prices and checkout switches against baseline; inspect public
   pages, buyer initialization, order lookup and validation. Exercise the visible
   checkout form without submitting a real order or payment.
7. Observe scheduled work across at least two five-minute reconciliation ticks.
   Compare aggregate payment consistency and fulfillment queues with baseline.
   No real activity means real payment/provider delivery remains unobserved.
8. On a confirmed new failure, immediately roll back to the compatible baseline
   version, then recheck configuration, old/new assets and business endpoints.
   Keep the compatible deployment package for later use; a standard `dist`
   rebuild alone does not retain both generations of assets.

## Evidence handling

Private config backups, artifact manifests, remote version snapshots, aggregate
reports and sanitized tail output belong under ignored `artifacts/`, outside Git.
Never retain customer identifiers, callback signatures or secret values in the
release report. A historical waiting-for-customer order, invalid external callback
or client TLS reset alone is not evidence of a release regression.

## Production deployment, 2026-11-21

| Item | Value |
| --- | --- |
| Source commit | `bc68dd48b27569e7d9ac30450cbeff32465a03c4` |
| Release tag | `release-2026-11-21-seo-foundation` |
| Candidate Worker version (now rolled back) | `b6c4145f-f0de-4caa-a079-0ce09eec6669` |
| Activated | 2026-11-21 14:47:18 UTC / 22:47:18 Asia/Shanghai |
| Compatible rollback version | `c955856c-9141-4f59-9083-2bc6b744f1ef` |
| Rollback source | `d7df5ef63ba99577048baf2ab28512ee4d51c2df`, with both asset generations |
| Rollback tag | `release-2026-11-21-seo-rollback` |

The compatible baseline was first deployed and verified through the production
domain. Its 21 dependencies all passed status, MIME, byte-count and SHA checks.
The candidate retains those same old/new dependencies. One candidate font fetch
failed at the transport layer; its isolated retry returned the expected 200,
font MIME, size and SHA. The original failed observation is retained.

Both active deployments preserved all 55 existing bindings, including 27 business
variables and 23 secret bindings, plus the D1 resource, domain, cron, original
limiters and security headers. Secret values are not readable via the API;
Wrangler's secret-preservation behavior and unchanged binding names were checked.
No migrations or production configuration/data resets were performed.

The configured-entry regression suite passed 727 tests; scope verification
preserved 814 protected files and the transaction-related App/useStore ASTs.
Lint and public-source scan passed. The source job in CI run `44915397573` passed;
the separate Go backend job retains the pre-existing failures already reproduced
and documented during the isolated rehearsal. It is not reported as green.

Production HTTP checks passed 14 checks on the compatible baseline and 17 on the
candidate: live catalog prices and checkout switches, page and script responses,
buyer initialization, empty order list, configured Turnstile/recovery and rejection
of an empty order without creation. The first baseline comparison falsely treated
an undefined optional field as different from its JSON-omitted representation;
the corrected comparison passed and both observations were retained.

Visible browser checks passed for an already-open old page, fresh ChatGPT Pro
10x selection and purchase form, Codex 500 points selection and form, automatic
account-delivery form, and the email order-recovery dialog. Forms showed the
expected 1350, 199 and 85 amounts. No real order, payment, CAPTCHA solution,
customer credential entry or email verification message was submitted.

The candidate's 14:50:29 and 14:55:29 UTC five-minute reconciliation invocations
both completed with `outcome=ok` and no queue failures, also confirmed by an
independent reviewer. Observation continued through 14:57:43 UTC (10 minutes
25 seconds after activation): 334 candidate events and 11 scheduled invocations
contained no 5xx, exceptions, resource-limit outcomes or queue failures.
The 14:56:05 UTC aggregate snapshot found no payment/order mismatch, no pending
recharge notification verification, no supplier procurement or delivery backlog,
and no change to the pre-existing waiting-for-customer order. It contained one
`payment-closed` / `cancelled` transition, confirmed by a separate aggregate query
to belong to a pre-release unpaid order, and no new orders or payment receipts.

One homepage GET had a `canceled` outcome without a response status or exception.
Its cause is unknown. The initial broad non-OK-event gate flagged it; it was
retained separately from server errors, and subsequent homepage/catalog probes
both returned 200 with SEO content and checkout enabled. No evidence connected
this canceled request to a checkout or fulfillment failure.

No new paid order, payment notification, verified provider webhook or completed
recharge attempt occurred in the observation window. This validates configuration,
entry points and scheduled execution, but does **not** claim a fresh real-payment
or third-party fulfillment success. No confirmed release regression triggered a
rollback. Tail observation ended after the bounded post-release checks; it is not
an unattended ongoing monitor or an automatic rollback service.

## User-reported first-paint regression and rollback

The public renderer injected a separate product table into `#root`. The unchanged
React entry used `createRoot().render()`, replacing that table only after the
client bundle ran. Consequently the table was visible to ordinary JavaScript
users too; slow loading extends that interval, and a failed script can leave it
visible. The user screenshot demonstrates this presentation, but does not by
itself establish how long it remained visible on that device.

The original 727-test suite and HTTP checks covered document content, routing
and transaction preservation. Browser acceptance checked the final interactive
state, not first-paint appearance with delayed or failed scripts. Those checks
were insufficient for approving this rendering change. The previous description
of the table as a no-JavaScript view was incomplete.

The user had already authorized immediate rollback on regressions. The rollback
restored the compatibility version to 100% traffic; a subsequent active-version
audit preserved all 55 original bindings, and all 14 baseline HTTP checks and
21 old/new static dependencies passed. The database was not restored or reset.
The raw evidence is retained in the main project's ignored
`artifacts/incidents/2026-11-21-seo-first-paint/` directory.

The separate homepage design branch `codex/homepage-guidance` at `0e1b96f` was
never included in the SEO candidate, which was based directly on `d7df5ef`.
Thus the prior homepage design work was not deployed, and this release should
not have been communicated as delivering that visual redesign.

Before another release, remove the mismatching table from the storefront's
initial render or implement initial markup consistent with the actual storefront.
Do not merely switch to `hydrateRoot` over incompatible markup, hide content from
people while showing it to crawlers, or treat final-state screenshots as first-paint
coverage. Validate delayed/failed script loading and desktop/mobile rendering.
No corrected SEO candidate was deployed as part of this incident response.

## Durable private archive and future operations

The main checkout stays on its independent homepage branch. Its original private
`wrangler.production.jsonc` stays byte-identical and is not the SEO deployment
configuration. This avoids silently changing the configuration of another branch.

The durable local archive is `artifacts/releases/2026-11-21-seo-bc68dd48/` beneath
the main project root. It contains both dist directories, full hashed manifests,
private config snapshots and verification evidence. Historical configs containing
temporary source paths are marked `*.evidence-only.json`; do not deploy them.

The archive's `rollback-only.json` has only the Worker name and account identity.
Cloudflare rollback uses the stored cloud version and does not require a local
main file, temporary checkout or asset directory. Run from the main project root:

```sh
node_modules/.bin/wrangler rollback c955856c-9141-4f59-9083-2bc6b744f1ef \
  --config artifacts/releases/2026-11-21-seo-bc68dd48/rollback-only.json \
  --yes --message 'Restore compatible pre-SEO release'
```

Before a future rollback, check that no newer release has superseded this one.
After rollback, verify the active version, preserved settings, both dependency
graphs and business endpoints. A later redeployment requires the recorded source
commit, corresponding archived assets and a fresh audit of production settings.
Do not redeploy from the unrelated homepage branch or from an ordinary single
generation `dist` directory.

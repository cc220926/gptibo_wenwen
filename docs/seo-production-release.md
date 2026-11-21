# SEO production release

**Current status: the merged homepage and first-paint fix was published on
2026-11-21 at 16:30:32 UTC (2026-11-22 00:30:32 Asia/Shanghai).**
Active version: `15a92bbc-5a69-46c3-9ced-e2c894bf5933`.
Current compatible rollback: `5e5085e6-4036-40b1-9088-d5a13e122ba2`, retaining
three asset generations. See the current release record below.
The records under “Previous release procedure and history” are historical.
The earlier `c955856c` rollback
does not contain the merged homepage assets and must not replace the new target.

## 首页与首屏修复正式发布记录

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

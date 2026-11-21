# SEO 隔离预发布与回退演练

日期：2026-11-21。候选业务源码为 `61903a0622f84d64c35df77cdcdbc91f89d1d99f`，生产基线为 `d7df5ef63ba99577048baf2ab28512ee4d51c2df`。本轮只新增验收脚本、回退资源打包方法和记录，没有修改业务实现。正式生产配置、路由、数据库、凭据和部署未修改；不合并，不创建生产发布标签。

用户确认没有预发布域名或支付／供货商沙箱，授权使用隔离测试环境。因此“配置一致”指业务开关、渠道、兼容日期、定时计划和业务限流预算一致；独立资源和测试凭据的差异必须显式列出，不能将本次测试称为真实第三方联调。

## 验收范围和结论

| 要求 | 方法及证据 | 状态 |
| --- | --- | --- |
| 保留生产业务开关和渠道 | 配置检查；27 项公开变量逐项审计，19 项开关／渠道保护；拒绝模拟订单模式、关闭充值、共享生产限流等错误配置 | COMPLETE |
| 生产资源隔离 | 新建临时 Worker 和 D1；无生产自定义域名；使用独立限流 namespace；远端版本绑定核对无生产 secret | COMPLETE |
| 真实业务代码创建订单 | `ORDER_TESTING_ENABLED=false`、`TURNSTILE_ENABLED=true`；正常 API 创建 Plus ¥138、Codex 500 ¥199、成品账号 ¥85 订单；断言 mode=live | COMPLETE：本地协议模拟 |
| 回退后继续进行中订单 | 同一 SQLite、原 Cookie、采购单、凭据和幂等 key，候选切归档基线后验签回调及 cron 完成三单 | COMPLETE：本地协议模拟 |
| 不重复履约、不串买家 | 重复创建／付款回调／供货回调／cron，采购与充值各一次；其他买家 404；交付明文不入事件记录 | COMPLETE：本地协议模拟 |
| 换浏览器找回 | 回退后正常邮箱找回 send/verify/session API；从拦截的邮件捕获验证码，原三单可读、归属不变、验证码重放 401 | COMPLETE：本地协议模拟 |
| SEO 故障不阻断原入口 | 真业务开关下 25 并发公开 HTML 合并为一批 9 次 SELECT，主站 HTML/目录零外部调用；预算拒绝、SQL 失败／悬挂仍可初始化买家、读取指南 | COMPLETE |
| Cloudflare 版本回退确实生效 | 隔离环境实际部署、rollback、读取部署版本及该版本的资源快照；同一测试 D1；回退恢复原三个业务限流绑定 | EXTERNAL_STATE_VERIFIED |
| 回退静态资源可用 | 纯基线失败后，兼容回退包通过 17 项 HTTP 状态、MIME、字节数和 SHA-256 核对 | COMPLETE |
| 已打开页面仍可使用 | 实际浏览器保留候选脚本页面跨回退，订单页面及找回入口正常；无横向溢出、无控制台错误 | COMPLETE：云端无支付／邮件 secret，未验证真实下单 |
| 原业务不变 | 720 项原入口转接回归通过；814 个受保护文件相同，App / useStore 交易相关 AST 相同；独立 review | COMPLETE |
| 生产高峰容量 | 基线／候选各 50 请求、并发 5 的小规模观察；发生 TLS 中断，未取得生产流量模型或完整容量证据 | NOT_VERIFIED |
| 真实支付／供应商／邮件／验证码及生产 WAF | 无供应商沙箱；生产密钥未复制；没有真实收款、交付、邮件或生产验证操作 | OUT_OF_SCOPE / NOT_VERIFIED |

本地协议回归共 3 项场景测试通过。它们在真实业务函数中验证签名、金额、状态、幂等和权限，但外部返回由受控模拟器提供；不等同于 Cloudflare 上的完整交易验收。不存在通过降低断言或关闭生产业务开关来换取通过的情况。

## 隔离配置

云端临时资源名为 `gptibo-seo-rehearsal-20261121`，仅使用其 workers.dev 地址，D1 与生产不同。保留生产兼容日期／flag、每分钟 cron、原三个限流预算和全部业务变量，只有以下隔离差异：

- Worker 名称、域名、D1 ID、限流 namespace 和构建路径；无生产 routes。
- Turnstile 测试 site key 和允许主机；邮件展示品牌、邮件链接来源、支付与充值回调来源。
- 云端不配置第三方密钥，故付款和邮件功能按原代码拒绝启用。浏览器看到停售和邮件未配置，是隔离环境预期结果，不能当成下单全链路已经通过。
- 本地协议模拟保留业务变量，换用随机测试密钥、合成商品数据、内存 SQLite，并拦截全部外部 fetch；未预期的目标或协议会记录并使测试失败。

候选相对隔离基线的配置变化仍仅为新 Worker 入口、`run_worker_first=true`、SEO origin 和独立 SEO limiter。配置检查不从示例覆盖生产设置。生产当前开启充值和自营购买；直接复制默认关闭这些开关的示例配置会阻断下单。

## 演练发现的回退问题

纯基线缺少候选的 4 个 JS 和 1 个 CSS 文件：主入口、Admin、Partner、customer-export 和 public-content。实际 Cloudflare 回退后，这些路径返回 **HTTP 200 + text/html**，内容是 SPA 回退壳，不是可执行脚本／样式。因此仅检查状态码会漏检；候选 HTML 与未加载的模块可能无法使用。

修复发布流程的方法是先构造“兼容基线”：保留旧业务代码、旧 HTML、robots、headers 及全部旧资源，只补入候选依赖的缺失文件。相同路径但内容不同直接拒绝打包。此次保留基线 35 个文件，新增 4 个内容哈希 JS 和一个此前不存在的 public-content.css，两个依赖图均完整。

该包必须部署成**新版本**才能作为回退目标，不会补写原 `ddc27a73-f3ac-4414-a8b6-64653251817d` 的资源清单。Cloudflare 每个版本有独立静态资产映射，参考[官方版本差异说明](https://developers.cloudflare.com/workers/versions-and-deployments/version-skew/)和[回退说明](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。

本次隔离环境实际版本序列：

| 阶段 | 版本 | 结果 |
| --- | --- | --- |
| 纯基线部署 | `3cbf7daf-64dd-4e1e-8d2e-c93ea866a7c8` | 原入口、旧资源 |
| 第一次候选部署 | `61426b16-0f06-4592-b8f0-df5849861d11` | 页面／目录／买家入口通过 |
| 回退纯基线 | `3cbf7daf-64dd-4e1e-8d2e-c93ea866a7c8` | 确认 5 项资源返回 HTML；另有一项字体 TLS 中断单独记录 |
| 兼容基线部署 | `e958818d-56cd-47e3-8989-baa57d9266ed` | 旧代码及两版静态资源 |
| 第二次候选部署 | `541dbae8-3bf1-47bb-9ebb-b8c4a8a2c2b0` | 同一独立 D1 |
| 回退兼容基线 | `e958818d-56cd-47e3-8989-baa57d9266ed` | 实际 100% 生效，17 项依赖全部正确；原页面、目录及买家接口通过 |

上述全部为临时预发布版本，不是生产可用回退 ID。未来正式发布必须针对最终候选构建重新生成兼容基线、校验生产四项补丁，并记录正式环境实际创建的回退版本；不能使用这里的临时 ID。

最终只读核对生产仍为 `ddc27a73-f3ac-4414-a8b6-64653251817d`，生产配置 SHA-256 与演练前一致。演练结束已删除本轮新建的临时 Worker、随附 cron 和测试 D1，重新读取资源列表确认不再存在；正式生产 Worker 保持存在。验收记录留在本地忽略目录，临时地址不再提供预览。

另对生产公开静态文件做只读对照：重建基线首页引用的入口文件名与现网相同，16 项旧依赖内容哈希全部一致（一项 TLS 中断后单独重试，原失败保留）。最终候选重新构建后，也与已演练的兼容资源包逐字节相容。

## 复现入口

所有命令在独立工作目录执行。生产配置仅作为本地只读输入，不写入仓库；基线须从上述发布提交归档，使用相同 lockfile 构建。配置、临时凭据、D1、打包资源和原始验收记录均放在忽略目录。

```sh
node scripts/preprod/verify-config.mjs "$PRODUCTION_CONFIG" "$STAGE_BASELINE_CONFIG" "$STAGE_CANDIDATE_CONFIG"

SEO_BASELINE_ROOT="$ARCHIVED_RELEASE_ROOT" SEO_PREPROD_VARS="$PUBLIC_VARIABLES_JSON" \
  node --test scripts/preprod/live-rollback.test.ts

node scripts/preprod/asset-audit.mjs --candidate dist --baseline "$BASELINE_DIST"
node scripts/preprod/asset-audit.mjs --candidate dist --baseline "$BASELINE_DIST" \
  --build-compatible "$NEW_COMPATIBLE_DIST"
node scripts/preprod/asset-audit.mjs --candidate dist --origin "$ISOLATED_ORIGIN"

node scripts/preprod/http-smoke.mjs "$ISOLATED_ORIGIN" candidate
node scripts/preprod/http-smoke.mjs "$ISOLATED_ORIGIN" baseline --functional-only
node --import ./scripts/seo-regression-loader.mjs --test tests/*.test.ts
node scripts/verify-seo-scope.mjs
```

资产检查在纯基线缺候选资源时应退出 1；输入错误退出 2。兼容包不允许覆盖现有输出目录，避免覆盖既有验收或发布资源。HTTP 检查拒绝重定向、校验响应来源；仅在内存读取资源字节作哈希，不执行远端代码。功能 smoke 只允许指定格式的隔离 workers.dev 主机，不提供生产部署命令。

配置检查通过只证明配置文件没有凭据变量；云端已有 secret 必须另读实际版本的 bindings。此次独立 code review 发现并修复了“配置中原有凭据可能被复制”及“HTTP 默认跟随重定向”的两项验收脚本问题，合成负向测试保留红／绿证据。

## 证据与限制

原始证据保存在忽略的 `artifacts/seo-preprod/`，包括 `baseline.json`、配置负向检查、`live-rollback-final.log`、`regression.log`、`scope-final.json`、两轮部署／回退日志、资产红／绿 JSON、浏览器观察、远端版本绑定及生产未变审计。测试工具的 10 项故障注入和独立审查证据也在该目录。临时环境和私有配置不得加入 Git。

候选和基线的小流量请求各覆盖首页 20 次、静态主入口 20 次、买家目录 10 次，并发为 5；成功批次未观察到应用 5xx。但网络路径发生过 TLS 连接中断，完整回退后负载批次因此未完成，后续独立功能检查通过。浏览器下载耗时、远端 D1 实例和地域分布均不能代表生产峰值；不据此给出生产容量或“零影响”保证。

本轮没有新增业务代码阻断项。正式发布的必要流程变化是先准备兼容回退版本，且关闭 SEO origin 不能撤销 `run_worker_first=true` 的路由开销。真实第三方联调、浏览器验证码与生产 WAF、生产峰值容量仍须由发布决策明确接受或补验。本次未决定或执行正式发布。

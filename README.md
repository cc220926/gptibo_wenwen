# GPTibo

**可自托管的数字商品商城，包含用户前台、管理后台与代理工作台。**

[![CI](https://github.com/CoolkHz/gptibo/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/CoolkHz/gptibo/actions/workflows/verify.yml)
[MIT License](LICENSE) · [快速开始](#快速开始) · [后端文档](services/storefront/README.md) · [安全说明](SECURITY.md)

GPTibo 将商品展示、下单支付、订单交付、售后处理和代理商店管理整合在同一套系统中。前端使用 React 与 TypeScript，后端提供 Go + PostgreSQL 和 Cloudflare Workers + D1 两种实现，便于按部署环境选择和二次开发。

原站点已停止运营，项目现以 MIT 许可证开放源码。支付与供应商接入使用匿名适配器，需要配置自己的服务后使用。

## 功能

| 模块 | 能力 |
| --- | --- |
| 用户商城 | 商品与套餐展示、下单、支付状态、订单查询、售后申请、中英文界面、深浅色主题 |
| 管理后台 | 商品定价、订单与客户管理、退款处理、代理管理、结算与通知配置 |
| 代理工作台 | 独立商店、品牌设置、自定义域名、商品管理、订单统计与下级代理管理 |
| 业务后端 | 身份验证、支付回调、采购适配、异步任务、邮件通知与交易状态管理 |
| 开发与部署 | 数据库迁移、Docker Compose、自动化测试、GitHub Actions 与源码安全扫描 |

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | React 19、TypeScript、Vite、Tailwind CSS |
| Go 后端 | Go、Gin、PostgreSQL，API 与业务 Worker 分进程运行 |
| Cloudflare 后端 | Workers、D1、Wrangler |
| 邮件 | React Email |
| 验证 | Node.js Test Runner、Go Test、Gitleaks |

两套后端均服务于商城。当前公开版本包含商城侧供应商适配器，**不包含独立供货平台及供应商执行系统**。

## 快速开始

### 环境准备

- Node.js 24、npm、Git、Python 3。
- 使用 Go 后端时，准备 Docker Compose；原生开发需要 Go 1.26+ 和 PostgreSQL。
- 使用 Cloudflare 后端时，通过项目内的 Wrangler 运行本地环境。

```sh
git clone https://github.com/CoolkHz/gptibo.git
cd gptibo
npm ci
```

选择下面一种后端方式运行。

### 方式一：Go + PostgreSQL

在仓库根目录执行以下命令，初始化本地秘密、数据库和运行角色：

```sh
cd services/storefront
python3 scripts/init-secrets.py
cp .env.example .env
docker compose config --quiet
docker compose build api
docker compose up -d --wait postgres
docker compose --profile maintenance run --rm maintenance migrate
docker compose --profile maintenance run --rm maintenance grant-runtime
docker compose up -d --wait api worker
```

另开终端，在仓库根目录启动前端：

```sh
npx vite --config services/storefront/vite.config.ts
```

访问 `http://127.0.0.1:5175`。前端会将 `/api` 请求代理到本机 Go API 的 `8093` 端口。

原生启动、管理员登录、邮件服务与接入配置见 [Go 后端文档](services/storefront/README.md)。Windows 用户可使用后端目录中的 `scripts/init-secrets.ps1` 初始化秘密。

### 方式二：Cloudflare Workers + D1

在仓库根目录执行：

```sh
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply gptibo-local --local
npm run preview:worker
```

默认访问 `http://127.0.0.1:8787`。需要前端热更新时，另开终端运行 `npm run dev`，访问 `http://127.0.0.1:5173`；API 请求会转发到本地 Worker。

`.dev.vars` 保存本地配置，不应提交。`wrangler.jsonc` 用于本地环境；正式部署使用独立的 `wrangler.production.jsonc`。

两种后端的功能范围不同。Workers 代理工作台提供单店商品定价、上下架、排序、公告和联系方式；多店、自定义域名、工单及订单通知设置目前仅在 Go 后端提供。前端根据后台能力显示入口。Workers 使用邮箱验证码、TOTP 与限流，验证配置接口会明确返回未启用 Turnstile。

升级现有 Workers 安装时，先备份 D1，再应用全部迁移。`0045` 增加独立的平台充值尝试序号与查询水位，`0046` 增加代理收款账户。绑定账户后，提现按账户版本校验并保存收款人快照，修改账户仅影响后续新申请。

### 正式域名部署

将 `wrangler.production.example.jsonc` 复制为被 Git 忽略的 `wrangler.production.jsonc`，填入自己的正式域名、账户 ID 和独立 D1 数据库 ID。此配置使用单独的 Worker，并每分钟触发后台任务；本地开发继续使用 `wrangler.jsonc`。切换域名前保存当前绑定，保留旧站点及数据库以便回退，不要把本地测试库当作正式业务库。

```sh
cp wrangler.production.example.jsonc wrangler.production.jsonc
# 填写生产配置，并在所属账号创建独立数据库后执行：
npm run build
npx wrangler deploy --dry-run -c wrangler.production.jsonc --outdir artifacts/domain-deploy/bundle
# 数据库名称替换为生产配置中实际的 database_name：
npx wrangler d1 migrations apply gptibo-production --remote -c wrangler.production.jsonc
npx wrangler deploy -c wrangler.production.jsonc
```

生产配置初始关闭模拟下单与全部真实交易，商城展示商品但不开放购买。管理员、邮件和充值密钥通过该 Worker 的 Secrets 单独配置；`.dev.vars` 不会作为生产秘密上传。平台回调使用正式 HTTPS 域名下的 `/api/recharge/webhook`，核验登录、回调与交易流程后再开启所需通道。真实域名、云资源配置及回退记录保存在本地，不随公开源码发布。

### Workers 管理员、邮件与订单找回

在 Node.js 24 环境初始化本机私有管理员配置：

```sh
npm run admin:setup -- --email owner@example.invalid --username store-admin
```

命令把管理员身份、独立 TOTP 密钥和邮箱会话签名密钥保存到被 Git 忽略的 `.secrets/admin-setup/secrets.json`，配对二维码保存在同目录 `totp.png`。用自己的验证器应用扫描二维码；不要公开二维码或密钥。重复执行保留现有凭据，身份不一致时拒绝覆盖。初始化只写本机文件，不自动部署或发送邮件；已有生产安装应保留原凭据，避免使现有会话和验证器失效。

在 Resend 验证自己的发信域名，把 `RESEND_API_KEY` 和 `RESEND_FROM` 放入本机私有配置，再通过目标 Worker 的 Secrets 上传。发送地址必须属于已验证域名，运行时使用受限的发信 Key。`MAIL_PUBLIC_ORIGIN` 设置为自己的 HTTPS 商城 origin；邮件中的订单、后台、邀请和图片地址据此生成，不读取浏览器请求头。可用 `MAIL_BRAND_NAME` 设置邮件显示名称。

```sh
npx wrangler secret bulk .secrets/admin-setup/secrets.json -c wrangler.production.jsonc
# 私有邮件配置文件包含 RESEND_API_KEY 和 RESEND_FROM：
npx wrangler secret bulk .secrets/production-mail.env -c wrangler.production.jsonc
```

管理员在 `/admin` 使用用户名、邮箱验证码和验证器动态码登录。买家在新浏览器的 `/orders` 使用下单邮箱接收验证码，验证后仅找回该邮箱的订单；退出邮箱登录后恢复浏览器原有的订单权限。

关键订单邮件使用独立队列，不影响收款和充值状态。部署前先备份 D1 并应用全部迁移：`0047_order_email_notifications.sql` 创建关键订单邮件队列，`0048_telegram_invitation_mail_payload.sql` 为 Telegram 代理邀请保存冻结的邮件请求。然后设置 `ORDER_EMAIL_NOTIFICATIONS_ENABLED=true` 和明确的 UTC `ORDER_EMAIL_NOTIFICATIONS_SINCE` 上线时间（例如 `2026-11-07T12:00:00.000Z`，请换成自己的实际启用时间）。关键订单邮件要求**订单创建时间和事件创建时间都不早于该时间**，因此历史订单后来发生的新事件也不会补发。通知范围为付款确认、明确充值结果和退款确认；首次尝试前冻结发件人、收件人和完整正文，同事件重试复用幂等键。首次上线应实际验证管理员收信与登录、新浏览器订单找回、通知投递；配置字段非空不代表邮件已送达。

管理员可在目标 D1 数据库控制台只读检查 `order_email_notifications`。这版没有邮件队列管理页面或操作接口。队列状态含义如下：

| 状态 | 含义 |
| --- | --- |
| `pending` | 待发送、等待业务状态核验，或等待失败重试。 |
| `sent` | Resend 已返回有效消息 ID，应用已保存受理结果；**不等于邮件已送达收件箱**。实际投递、退信等结果需到邮件服务商核查。 |
| `cancelled` | 通知已过时或不再满足发送条件，例如付款通知发送前订单已完成、失败任务已被新尝试取代。 |
| `manual_review` | 首次发送尝试已满 23 小时，结果仍未确认；为避免幂等保护窗口失效后重复发送，已停止自动重试。 |

按状态与通知种类统计，以下查询不读取邮件正文、收件人或凭据：

```sql
SELECT status, kind, COUNT(*) AS notification_count,
       MIN(next_attempt_at) AS earliest_next_attempt_at,
       MAX(attempt_count) AS highest_attempt_count
FROM order_email_notifications
GROUP BY status, kind
ORDER BY status, kind;
```

排查指定订单时，将下面的占位订单号替换为实际订单号。时间字段为 Unix 毫秒；`provider_message_id` 可用于核查服务商记录，未确认受理时可能为空。避免查询或导出 `payload_json`，其中包含收件地址和邮件全文。

```sql
SELECT id, order_id, kind, status, event_created_at,
       first_attempt_at, next_attempt_at, attempt_count,
       delivered_at, provider_message_id, closed_reason
FROM order_email_notifications
WHERE order_id = 'REPLACE_WITH_ORDER_ID'
ORDER BY event_created_at, id;
```

`manual_review` 的 `closed_reason` 为 `idempotency_window_expired`。遇到该状态，先根据已保存的消息 ID（如有）、发送时间和对应幂等键核查 Resend 的受理与投递记录，再决定人工处理方式。不要直接把状态改回 `pending`、清空首次尝试时间、删除队列行或更换幂等键；发送请求可能已经成功，只是本地未确认，盲目重置会造成重复通知。上述队列查询只用于诊断，不应据此修改付款、充值或退款状态。

### 下单活动提示（Workers）

ChatGPT 商品页和下单窗口可显示“近 1 分钟有 X 位其他访客在下单”。它统计在下单窗口中近期有操作的浏览器，不是已付款人数或成交量。同一买家 Cookie 的多个标签页去重，排除当前浏览器；不同设备或浏览器无法识别为同一个自然人。

只有正式下单的邮箱填写、未付款阶段参与统计。浏览商品页只读取数量，不增加数量。页面隐藏、失去焦点、关闭下单窗口、付款完成或连续 60 秒没有操作时停止上报；断网或意外关闭造成的残留最多持续到服务器的 60 秒统计窗口过期。真实数量为零时也显示提示；读取失败或响应过期时隐藏，不将未知状态当成零。统计接口异常不阻止下单和支付。

部署前先应用 `migrations/0049_checkout_presence.sql`。`/api/checkout-presence` 只返回按店铺和商品隔离的汇总数量，不返回买家标识、邮箱或账号资料。活动记录使用短期数据库表，现有分钟定时任务负责清理。该功能目前由 Workers 提供；使用尚未提供此接口的 Go 后端时，前端自动隐藏提示。

### 页面入口

| 页面 | 路径 |
| --- | --- |
| 商城 | `/` |
| 管理后台 | `/admin` |
| 代理工作台 | `/partner` |

管理员登录需要配置自己的管理员身份、TOTP 和邮件验证服务。默认配置不提供可直接登录的管理员账号，也不会发起真实支付、采购或通知。

## 项目结构

```text
src/                   商城前台、管理后台与代理工作台
services/storefront/   Go API、业务 Worker、迁移与部署配置
worker/                Cloudflare Workers 后端
migrations/            D1 数据库迁移
emails/                邮件模板
tests/                 前端与 Worker 业务测试
scripts/               构建与源码检查脚本
public/                静态资源
.github/workflows/     持续集成
```

## 配置与接入

| 配置文件 | 用途 |
| --- | --- |
| [services/storefront/.env.example](services/storefront/.env.example) | Go 后端基础运行配置 |
| [services/storefront/.env.integrations.example](services/storefront/.env.integrations.example) | Go 后端支付、采购及通知接入 |
| [.dev.vars.example](.dev.vars.example) | Cloudflare 本地配置 |
| [wrangler.jsonc](wrangler.jsonc) | Worker 与 D1 资源配置 |

供应商适配器使用 `recharge`、`account_supplier`、`delivery_supplier`、`xgift` 等通用名称；`gatewaya`、`gatewayb` 为匿名聚合支付适配器。请依据自己的服务协议核对地址、签名、商品映射、金额和回调，再开启对应功能。

真实商户身份、密钥、账号凭据和生产数据不随源码提供。`example.invalid` 是不可用于真实接入的保留域名，示例商品与金额仅用于演示。请使用新数据库安装；匿名化后的迁移不兼容原生产数据库。

## 开发与验证

在仓库根目录执行：

```sh
npm test                # 前端与 Worker 业务测试
npm run lint            # 静态检查
npm run build           # 类型检查、邮件模板与前端构建
npm run security:scan   # 公开源码检查
```

Go 后端验证：

```sh
cd services/storefront
go test ./...
go vet ./...
```

完整数据库测试需设置 `STOREFRONT_TEST_DATABASE_URL`，连接本机、库名以 `_test` 结尾的专用数据库；未配置时集成测试会跳过。详细要求见[后端测试说明](services/storefront/README.md#测试)。

自动化测试不连接真实支付或供应商服务。生产部署前，需要在自己的环境验证完整交易流程。

## 参与贡献

欢迎通过 [Issues](https://github.com/CoolkHz/gptibo/issues) 反馈问题或提出建议，也欢迎提交 Pull Request。

1. 描述问题、预期行为和复现步骤。
2. 提交范围明确的改动，涉及交易或账务逻辑时补充回归测试。
3. 运行与改动相关的检查，在 PR 中说明验证结果。

请勿提交真实凭据、用户资料、生产日志或数据库。安全问题请按 [SECURITY.md](SECURITY.md) 中的方式报告。

## 许可证

项目代码采用 [MIT License](LICENSE)，允许在保留版权与许可声明的前提下使用、修改和分发。

第三方资源遵循各自许可证，商标及美术作品权利归原权利人所有。详见[品牌资源说明](public/brands/README.md)与[第三方样式说明](src/styles/vendor/README.md)。

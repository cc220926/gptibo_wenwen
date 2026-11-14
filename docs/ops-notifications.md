# 订单推送通知（飞书 / 企业微信 / 微信 / 邮件）

新订单付款确认、客户提交售后申请时，Workers 每分钟把提醒推送到已配置的渠道。需人工交付的订单（如成品号）会在消息中标明「需人工交付」。

## 推送内容

只包含运营需要的订单事实：商品、金额、交付方式、订单号、来源（平台直营或代理）、时间和后台链接。**不包含**客户邮箱、账号资料、交付内容、支付流水或任何凭据。推送只用于提醒，不改变付款、交付或退款状态；渠道故障不影响收款和履约。

## 渠道配置

配置哪个渠道就推送哪个，可以同时配置多个。所有地址和密钥都是 Worker Secret，通过 `npx wrangler secret put 名称 -c wrangler.production.jsonc` 在提示符中输入，不写进源码、配置文件或聊天。

| 渠道 | 配置 | 说明 |
| --- | --- | --- |
| 飞书群机器人 | `FEISHU_WEBHOOK_URL`，建议同时设置 `FEISHU_WEBHOOK_SECRET` | 飞书群 → 设置 → 群机器人 → 添加「自定义机器人」，开启「签名校验」，复制 Webhook 地址和签名密钥。 |
| 飞书应用机器人（已有） | `FEISHU_APP_ID`、`FEISHU_APP_SECRET`，接收人 `FEISHU_ORDER_RECIPIENT` | 复用提现通知所用的自建应用。未设置 `FEISHU_ORDER_RECIPIENT` 时沿用 `FEISHU_PAYOUT_RECIPIENT`。配置了群机器人 Webhook 时优先使用 Webhook。 |
| 企业微信群机器人 | `WECOM_WEBHOOK_URL` | 企业微信群 → 添加群机器人，复制 Webhook 地址。 |
| 个人微信（Server酱） | `SERVERCHAN_SENDKEY` | 第三方服务，经其服务号推送到微信；消息内容会经过该服务。 |
| 管理员邮箱 | 普通变量 `OPS_NOTIFY_EMAIL=true` | 发送到 `ADMIN_EMAIL`，使用现有 Resend 配置。 |

格式不正确的地址或密钥只会停用该渠道，不影响其他渠道。

## 启用

1. 备份 D1 后应用迁移 `0060_ops_notifications.sql`（仅建表，不发送任何消息）。
2. 写入渠道 Secret，部署。
3. 在后台浏览器控制台或接口工具中，以管理员身份 `POST /api/admin/ops-notifications` 发送一条测试消息，返回每个渠道的结果（`sent` 或失败原因）。`GET` 同一路径可查看已启用的渠道。
4. 在 `wrangler.production.jsonc` 的 vars 中设置 `OPS_NOTIFICATIONS_SINCE` 为启用时刻（UTC，例如 `2026-11-15T00:00:00.000Z`）并部署。早于该时间的订单不会推送；任何时候都只扫描最近 24 小时的事件，后来新增的渠道不会补发旧订单。

## 重试与排查

每个渠道单独发送、单独重试：失败后按 1、2、4…分钟退避（最长 1 小时），最多 8 次后标记 `failed`。移除某个渠道后，其待发送记录直接标记 `failed`（`channel disabled`）。日志只记录渠道和固定失败原因。

```sql
SELECT channel, kind, status, COUNT(*) n, MAX(attempt_count) max_attempts
FROM ops_notifications GROUP BY channel, kind, status ORDER BY channel, kind, status;
```

## 后台提醒栏

后台顶部提醒栏约 15 秒检查一次「待处理退款」和「待人工交付」，开启声音后新订单会语音播报「您有一单人工交付待处理」。Workers 后端没有代理工单功能，提醒栏不再显示工单入口。

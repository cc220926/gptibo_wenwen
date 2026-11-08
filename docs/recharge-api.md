# Workers 充值接口接入

本文适用于 `worker/` 的平台代收与自动直充适配器。Go 后端是另一套实现，配置和验证应分别进行。

## 接入与开关

在被 Git 忽略的 `.dev.vars` 中配置独立的 API 地址、代理身份和签名密钥。以供应商当前协议和本账号已授权目录为准；示例配置不包含真实服务凭据。

- `RECHARGE_API_BASE`：HTTPS 地址，路径以 `/v1` 结尾。
- `RECHARGE_PARTNER_ID`、`RECHARGE_KEY_ID`、`RECHARGE_CLIENT_SECRET`：服务端认证。
- `RECHARGE_PRODUCT_MAP`：本站套餐到供应商商品代码的映射。
- `RECHARGE_WEBHOOK_SECRET`：独立回调验签密钥。
- `RECHARGE_NOTIFY_URL`：在供应商处预登记的 HTTPS 地址，路径为 `/api/recharge/webhook`。
- `RECHARGE_PAYMENT_CODE_ENABLED=true`：通过签名的 `POST /v1/orders/{id}/payment-code` 获取支付宝付款码。默认关闭，保留旧收银页桥接方式。

真实购买还需 `ORDER_TESTING_ENABLED=false`、`RECHARGE_CHECKOUT_ENABLED=true` 以及完整有效的回调配置。开发期间保持真实购买关闭。平台代收使用供应商的支付通道，无需配置本站支付宝私钥。

先通过只读接口核对代理状态、自建充值权限、商品授权和支付方式。固定价通道拒绝 `quote_required=true` 的商品，不能用占位供货价创建订单；这类商品需要另行实现付款前预检与报价绑定流程。历史字段 `max_sale_price` 不再作为零售价格上限，供货成本与代理成本校验仍然生效。

## 付款与凭据

签名付款码使用原平台订单生成稳定幂等键，请求正文固定为 `{}`。响应必须与原订单号、商户订单号、人民币金额及有效期一致。只接受官方支付宝二维码地址，不把平台收银链接或供应商图片原样交给浏览器；前端沿用本地绘码。付款码生成成功不代表付款成功，付款状态仍须核对签名查单结果。

充值提交请求体最多 256 KiB，提取后的令牌最多 128 KiB 字符。接受原始令牌或受支持的 JSON 包装，已有完整 Session JSON 继续兼容。前端仍要求核对账号邮箱；提交前的过期检查只作拒绝提示，不能证明账号有效。重传保留原凭据字节及原幂等键；新的合法尝试使用新键。原始凭据不存入数据库、日志或订单元数据。

## 查单与迁移

迁移 `0044_recharge_api_read_backoff.sql` 仅保存账号、资源路径及下次允许查询时间，不缓存供应商响应或凭据。`0045_recharge_remote_attempt.sql` 分别保存本地提交序号与平台任务序号；平台未受理的提交仍保留本地历史，不会消耗平台任务序号。订单与充值任务的通知核对水位也分别持久化，避免两个资源的退避时间错开后一直无法完成同步。升级时先备份数据库并应用迁移，再重启服务：

```sh
npx wrangler d1 migrations apply gptibo-local --local
```

生产数据库需使用自己的资源配置和部署流程。适配器按资源保存 `X-Poll-After` 与 429 的 `Retry-After`/`error.retry_after`；只有停止提示而无时间时使用 300 秒间隔。服务请求在等待期内返回安全重试提示，不向上游重复发送读取。成功的业务写入清除对应资源的本地等待时间，允许重新核对。终态订单仍保留财务核对能力，以发现迟到退款。

前端 `poll` 和 `query` 均查询原订单。并行读取订单与充值任务时，成功返回的状态会单独保存；任何付款、退款和收益冻结条件继续约束本地交付。付款码与有效期未改变时保留已有二维码，刷新暂时失败不会清空仍有效的付款码。

迁移 `0056_recharge_subscription_hint.sql` 为失败任务增加订阅到期提示。只有 `account_has_subscription` 的已失败任务，且原始说明含已识别的 `GPT_PLAN_ALREADY_ACTIVE` 标记及合法日期时，才提取日期数字。原始错误报文不存储、不返回。上游未提供时区的时间仅作提示，不能转换为北京时间、触发自动重试或解除付款及履约限制；是否允许重新提交仍以原任务的重试授权为准。旧失败订单在下一次正常查询原任务后补齐提示。

后台“审批并提交平台退款”使用原退款单和幂等键，平台受理后保持待确认，直到原单查账确认已退。若平台已退款但本地没有售后单，定时任务会重新读取原单，再原子写入售后记录、累计退款和代理收益扣回；也可通过管理员鉴权的同源 `POST /api/admin/refunds/reconcile-external`（JSON 正文 `{}`）触发。这一步只核销已发生的退款，不发起退款。存在未结束售后或待处理提现时保留冻结，需先处理相应记录。

`scheduled()` 必须另行配置定时触发器；服务进程运行本身不代表已启用定时任务。

## 验证边界

相关离线回归测试：

```sh
node --test tests/recharge.test.ts tests/recharge-credential.test.ts tests/checkout-session.test.ts tests/credential-expiry.test.ts
npm test
npm run build
npm run lint
npm run security:scan
```

模拟接口测试不能证明真实支付、充值或退款已通过。开启真实交易前，在隔离环境验证订单、付款码、到账、充值结果、回调重放与乱序、退款、结算及故障恢复。真实付款测试应单独确定账号、金额和范围。

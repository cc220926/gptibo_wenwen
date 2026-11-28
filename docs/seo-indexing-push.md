# 搜索引擎主动推送（IndexNow / 百度）

上线新页面或调整价格后，主动通知搜索引擎重新抓取，不必等它们自己来。

- **IndexNow**：Bing、Yandex、Seznam 等共用的协议。提交给 `api.indexnow.org` 后，参与的搜索引擎会互相共享。ChatGPT 搜索使用 Bing 的索引。
- **百度普通收录推送**：需要在百度站长平台验证网站后获取 token。

推送只由运维机器上的脚本发起，Worker 不会访问这些服务。

## 一次性配置

1. 生成密钥（8–128 位，只能包含字母、数字和 `-`）：

   ```sh
   openssl rand -hex 16
   ```

2. 把密钥写入生产 Worker。用 secret 保存，不写进仓库或配置文件：

   ```sh
   node_modules/.bin/wrangler secret put INDEXNOW_KEY --config <私有生产配置>
   ```

   配置后，主站会在 `/<密钥>.txt` 返回密钥本身，作为站点所有权证明。这个地址带 `noindex`，只在 `STOREFRONT_SEO_ORIGIN` 指定的主站提供，代理分站和自定义域名不会提供。没有配置或格式不合法时，这个地址不存在。

   说明：`wrangler secret put` 会立即生成一个新的 Worker 版本。请在正常发布窗口内执行，并先确认当前线上版本，避免覆盖别的发布。

3. 百度（可选）：在百度站长平台 → 普通收录 → API 提交，复制 token。token 只保存在运维机器上。

## 每次上线或改价后

```sh
INDEXNOW_KEY=<密钥> node scripts/seo/push-indexing.mjs --origin <主站 HTTPS 地址> --dry-run
INDEXNOW_KEY=<密钥> BAIDU_PUSH_TOKEN=<token> node scripts/seo/push-indexing.mjs --origin <主站 HTTPS 地址>
```

`--origin` 必须与生产的 `STOREFRONT_SEO_ORIGIN` 相同。脚本依次执行：

1. 读取线上 `sitemap.xml`，只保留同一主站的 HTTPS 网址。
2. 读取 `/<密钥>.txt`，确认线上返回的就是这个密钥；不一致就停止，不会提交。
3. 向 IndexNow 提交全部网址。返回 200 表示已接收，202 表示已接收、密钥待验证。
4. 如果提供了百度 token，把同一批网址按行提交给百度，并显示当日剩余额度。

`--dry-run` 只做前两步检查，不会提交。日志里不会打印密钥和 token。

## 注意

- 返回 200/202 只表示搜索引擎收到了网址，不代表一定收录，也不影响排名。
- 不要频繁重复提交没有变化的网址：IndexNow 会返回 429，百度会消耗每日额度。上线、改价或新增文章后提交一次即可。
- 更换密钥时，先用 `wrangler secret put` 写入新值，确认新的 `/<密钥>.txt` 可以访问后，再用新密钥推送。

# 主站到教程博客的入口

主站的公开页面可以链接到运营者自己的教程博客。入口只出现在主站，分站（`/r/`、`/s/`）不显示。代码里不写任何博客地址，全部来自部署变量；变量为空时页面与原来完全一致。

## 变量

| 变量 | 说明 |
| --- | --- |
| `STOREFRONT_BLOG_ORIGIN` | 博客的 HTTPS 来源，只含协议和主机，例如 `https://blog.example.com`。为空或格式不对时，不显示任何博客入口。 |
| `STOREFRONT_BLOG_GUIDES` | 可选的 JSON 字符串：帮助文章 slug 对应 `[博客路径, 链接标题]`。例如 `{"plus-vs-pro":["/posts/choose-plan","套餐怎样选"]}`。 |

`STOREFRONT_BLOG_GUIDES` 中，slug 必须是 `shared/public-help.ts` 里已有的帮助文章；路径以 `/` 开头，只含字母、数字、`/`、`_`、`-`；标题不超过 80 字。不符合的条目被忽略，整段 JSON 无法解析时只去掉文章级链接，博客首页入口保留。

## 出现的位置

- 帮助中心底部：「看教程笔记」，指向博客首页。
- 帮助文章右侧栏：「延伸教程」，只在该文章配置了对应教程时出现。
- 价格表底部按钮组：「教程笔记」。
- `/llms.txt` 的常用页面列表。
- 首页 `Organization` 结构化数据的 `sameAs`。

没有改动首页应用、商品页、订单、支付和交付代码，也没有新增样式文件或静态资源；链接复用帮助中心现有样式。

## 验证

```sh
node --test tests/public-seo.test.ts
```

其中「blog links appear only on the main store…」覆盖默认关闭、主站各位置、分站不显示、转义，以及无效来源和无效 JSON。

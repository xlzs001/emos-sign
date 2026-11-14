# emos 自动签到 · Loon 插件

基于 somebyte 公开 API 的每日签到插件。支持多账号、自定义执行时间、多线路自动切换，所有配置都在 Loon 插件面板里点选，不改代码。

## 订阅

Loon → 配置 → 插件 → `+` → **从 URL 添加**，粘贴其中一条：

| 线路 | 地址 |
|---|---|
| **jsDelivr（推荐）** | `https://cdn.jsdelivr.net/gh/xlzs001/emos-sign@main/emos-sign-jsd.plugin` |
| GitHub raw | `https://raw.githubusercontent.com/xlzs001/emos-sign/main/emos-sign.plugin` |

两条线路是配套的：jsDelivr 版插件的 `script-path` 指向 jsDelivr 上的脚本，raw 版指向 raw 上的脚本，不要混用。

## 可用站点

照着 [emos wiki](https://emos.dpdns.org/links) 把每个域名都探过一遍，**真正能签到的只有两个**：

| 站点 | 能否签到 | 说明 |
|---|---|---|
| `emos.best` | ✅ | 主站 |
| `emos.club` | ✅ | 与主站同一后端，响应逐字节相同，token 通用、签到状态互通 |
| `emya.wwzb.de` | ❌ | 纯前端控制台，签到请求最终打主站 |
| `fund / reel / wiki / status / video.emos.best` | ❌ | 静态页或专用服务，无 `/api/sign` |
| `voice.somebyte.org`、`theotherdb.org` | ⚠️ 独立 | 有 `/api/sign`，但走 somebyte OAuth 跳转，凭证是 session 不是 Bearer |

插件默认线路 `https://emos.best|https://emos.club`：主站不通（超时、5xx、DNS 问题）才切到镜像，正常只请求一个域名，不会重复签到。

## 签到奖励规则

基础每次 **+1~5 萝卜**，另按当天签到顺序加减：

| 位次 | 增减 | 位次 | 增减 |
|---|---|---|---|
| 第 3 位 | **+3** | 第 89 位 | **−3** |
| 第 9 位 | **−2** | 第 113 位 | **−2** |
| 第 11 位 | **+2** | 第 199 位 | **−2** |
| 第 26 位 | **−1** | 第 311 位 | **+1** |
| 第 59 位 | **+2** | 第 457 位 | **+2** |

连续一周 +10、一月 +30、一年 +3000。

落在扣分位时通知会标 `⚠ 第 9 位扣 2`。

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| ① 登录凭证 Token | 空 | 必填，多账号用 `;` 分隔 |
| ② 站点地址 | `https://emos.best\|https://emos.club` | 多条线路用 `\|` 分隔，主站不通自动切换 |
| ③ 每日执行时间 | `0 8 * * *` | 5 段 cron（分 时 日 月 周） |
| ④ 签到留言 | `每日签到` | 可为空 |
| ⑤ 签到结果通知 | 开 | 关闭后只写日志 |
| 显示萝卜余额 | 开 | 多 1 个请求 |

Token 获取：登录 emos.best → 开发者工具 Network → 任意 `/api/` 请求 → 请求头 `Authorization: Bearer` 后面那串。

## 运行逻辑

```
GET  /api/user/base        取用户名；401 即 token 失效，此步失败才会切换线路
PUT  /api/user/sign        签到；返回 429「重复签到」即为今日已签
GET  /api/rank/sign        仅已签时调用，反查当日位次
GET  /api/carrot/current   可选，查余额
```

单账号最多 4 个请求，每天只跑一次，不轮询。

> ⚠️ `/api/sign/check` 虽然在 Postman 里叫 sign，但它的真实名称是**「判断是否登录」**，`is_sign` 表示是否已登录，跟今天有没有签到无关。用它判断会导致每次都误判为「已签到」而跳过。

## 更新记录

- **v1.1.1** 修正签到判断：改为直接 `PUT /api/user/sign`，以 429 判定已签；已签时通过 `/api/rank/sign` 反查当日位次
- **v1.1.0** 多线路自动切换（emos.best → emos.club）、位次奖惩提示
- **v1.1.0** 修正 `timeout` 单位（毫秒），此前 20ms 导致全部请求超时

## 注意

- 官方明确 **禁止 0 点签到、禁止接口轮询**，默认 08:00，建议 7–10 点之间错峰。卡点 00:04 容易正好掉进第 26、89、113、199 这些扣分位。
- Token 会过期，失效时通知提示「Token 无效」，重新抓一次即可。
- 改了脚本想立刻生效：jsDelivr 清缓存 `https://purge.jsdelivr.net/gh/xlzs001/emos-sign@main/emos-sign.js`；Loon 端删掉插件重新添加。
- 仅用于自己的账号，请勿批量小号。

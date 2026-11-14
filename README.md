# emos 自动签到 · Loon 插件

基于 `somebyteorg/emos` 公开 API 的每日签到插件，支持多账号、自定义执行时间，所有配置都在 Loon 插件面板里点选。

## 订阅地址

| 线路 | 插件订阅地址 | 适用 |
|---|---|---|
| jsDelivr（推荐） | `https://cdn.jsdelivr.net/gh/xlzs001/emos-sign@main/emos-sign-jsd.plugin` | 国内可直接访问 |
| GitHub raw | `https://raw.githubusercontent.com/xlzs001/emos-sign/main/emos-sign.plugin` | 境外 / 已具备直连 |

脚本本身：

- jsDelivr：`https://cdn.jsdelivr.net/gh/xlzs001/emos-sign@main/emos-sign.js`
- raw：`https://raw.githubusercontent.com/xlzs001/emos-sign/main/emos-sign.js`

> 两条线路是配套的：订阅 jsDelivr 版插件，脚本也走 jsDelivr；订阅 raw 版，脚本也走 raw。不要混用，否则可能插件拉到了、脚本拉不到。

## 安装

1. Loon → 配置 → 插件 → 右上角 `+` → **从 URL 添加**
2. 粘贴上表其中一个地址
3. 进插件设置，填 ① 登录凭证 Token
4. 到 脚本 页面，手动跑一次「emos 立即签到」验证

Token 获取：登录 emos.best → 开发者工具 Network → 任意 `/api/` 请求 → 请求头 `Authorization: Bearer` 后面那串。

## 可配置项

| 参数 | 默认 | 说明 |
|---|---|---|
| ① 登录凭证 Token | 空 | 必填，多账号用 `;` 分隔 |
| ② 站点地址 | `https://emos.best` | 域名变更时改这里 |
| ③ 每日执行时间 | `0 8 * * *` | 5 段 cron（分 时 日 月 周） |
| ④ 签到留言 | `每日签到` | 可为空 |
| ⑤ 签到结果通知 | 开 | 关掉只写日志 |
| 显示萝卜余额 | 开 | 多 1 个请求 |

## 运行逻辑

```
GET  /api/user/base        取用户名（用于通知）
GET  /api/sign/check       今天签过就跳过，不重复提交
PUT  /api/user/sign        真正签到，返回排名 / 萝卜 / 连续天数
GET  /api/carrot/current   可选，查萝卜余额
```

单账号最多 4 个请求，每天只跑一次，不轮询。接口返回 `is_sign: true` 或 429 都判定为「今日已签到」，不报错。

## 注意

- 接口文档明确 **禁止 0 点签到、禁止接口轮询**，默认时间设为 08:00，建议 7–10 点之间错峰
- Token 有过期时间，失效后通知会提示「Token 无效」，重新抓一次即可
- Loon 对远程脚本有缓存：改了脚本想立刻生效，删掉插件重新添加，或把分支 URL 换成某个 commit sha
- 仅用于自己的账号，请勿批量小号

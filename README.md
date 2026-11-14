# emos 自动签到 · Loon 插件

基于 `somebyteorg/emos` 公开 API 的每日签到插件，支持多账号、自定义执行时间。

## 文件

| 文件 | 说明 |
|---|---|
| `emos-sign.js` | 签到脚本（Loon 本地脚本 / 远程脚本） |
| `emos-sign.plugin` | Loon 插件（由 publish-helper 生成后上传，`script-path` 指向本仓库的 raw 地址） |

## 安装

1. Loon → 配置 → 插件 → 右上角 `+` → 从 URL 添加
2. 粘贴本仓库 `emos-sign.plugin` 的 raw 地址
3. 进插件填 Token（登录 emos.best 后从请求头 `Authorization: Bearer` 取）

## 运行逻辑

```
GET  /api/user/base        取用户名
GET  /api/sign/check       今天签过就跳过
PUT  /api/user/sign?content=留言
GET  /api/carrot/current   可选，查萝卜余额
```

单账号最多 4 个请求，每天只跑一次，不轮询。

## 注意

- 接口文档明确禁止 0 点签到与接口轮询，默认时间为 08:00
- Token 过期后需重新获取
- 仅用于自己的账号，请勿批量小号

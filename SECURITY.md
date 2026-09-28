# 安全策略

## 支持的版本

只有最新发布的版本会收到安全修复。请先升级到最新版本再确认问题是否存在。

## 报告漏洞

请**不要**公开提 Issue。通过 GitHub 的
[私下报告漏洞](https://github.com/benis-me/kmoe-sync/security/advisories/new) 提交，写明：

- 受影响的版本和部署方式；
- 复现步骤或概念验证；
- 可能的影响（例如绕过登录、读取他人数据、执行命令）。

收到后会尽快确认，并在修复发布后致谢（如果你愿意）。

## 安全模型

- Kmoe Sync 为**单管理员、局域网内使用**设计。请不要把端口直接暴露到公网；需要远程访问时，请放在 HTTPS 反向代理或 VPN 后面，
  并设置 `KMOESYNC_SECURE_COOKIES=1`。
- 部署后请立即设置管理员密码：在此之前，能访问端口的人都可以抢先设置。忘记密码时用 `kmoesync --reset-admin` 重置。
- Kmoe 会话（以及勾选「记住密码」时的 Kmoe 密码）、WebDAV 密码、Komga 凭据和 AI 的 API Key 用 `data/secret.key`（或 `KMOESYNC_SECRET`）加密保存；请妥善备份并保护 `data/` 目录。
- REST API 与 MCP 使用单独生成的令牌，只能操作漫画、订阅和下载；不需要时请在「设置 → API 与 MCP」撤销。

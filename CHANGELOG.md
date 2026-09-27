# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-09-28

第一个公开版本。

### 功能

- 订阅追更（单行本 / 番外 / 连载话；默认补齐缺失，也可以只追新），定时检查，新章节自动下载并通知。
- 按卷挑选下载；并发可调、断点续传、完整性校验、不覆盖已有文件；额度不足或登录失效时暂停并自动恢复。
- 存储到 NAS 本地目录或 WebDAV；命名规则与浏览器扩展兼容，可导入扩展的配置。
- 书库整理：扫描已有漫画文件夹，按 EPUB 里的 Kmoe 标识或书名关联 Kmoe 漫画。
- Bangumi → Komga 元数据：自动 / 手动匹配，写入系列和单册信息，新下载的卷自动同步；国内网络可用离线数据或代理。
- Bangumi 书单同步。
- AI（OpenAI 兼容接口：DeepSeek、OpenRouter、自建模型）：AI 判定、AI 整理、带工具调用和确认的 AI 助手。
- 通知（Webhook / Bark / Telegram）、REST API 与 MCP。
- 浅色 / 深色主题（跟随系统，可手动切换），适配手机。
- Docker 镜像（linux/amd64、linux/arm64），支持 PUID / PGID；`--reset-admin` 重置管理员密码。

[0.1.0]: https://github.com/benis-me/kmoe-sync/releases/tag/v0.1.0

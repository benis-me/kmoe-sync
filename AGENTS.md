# 给 AI 编程助手的约定

- 用简体中文回复，进度说明也一样；提交信息用英文。
- 开发、测试和代码约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，这里不重复。要点：`bun run check` 必须通过；
  验证用 `bun run dev:fake`（本地假 Kmoe），不要用真实账号触发下载。
- 对 Kmoe 友好：批量请求每 10 秒一个页面，不加并发。请求太快会被限制整个 IP。
- 新的默认值只影响之后，不迁移、不改写用户已有的数据和设置。
- 发版：改 `package.json` 的版本、写 `CHANGELOG.md`（含底部的对比链接）、更新
  `.github/ISSUE_TEMPLATE/bug_report.yml` 里的版本示例；合到 `main` 后打 `vX.Y.Z` 注释标签并推送。
  Release 工作流先跑检查，再构建并推送 GHCR 镜像；NAS 上在 Portainer 里重新拉取镜像部署。
- 这是公开仓库：推送和打标签都会对外发布，先确认再做；不要提交密钥、内网地址或本地评审文件。

# 参与贡献

谢谢你愿意改进 Kmoe Sync！提 Issue 和 Pull Request 前，请先看完这一页。

## 提 Issue

- 先看 README 的「常见问题」，再搜一搜已有的 Issue。
- 问题反馈请用模板，写清版本（「设置 → 关于」）、部署方式、复现步骤和相关日志（`docker logs kmoesync`）。
- **不要**贴出 Kmoe 账号、密码、Cookie、API Key、令牌或内网地址。安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## 开发环境

需要 [Bun](https://bun.sh) 1.3+。

```bash
bun install
bun run dev:fake   # 前端 + 后端 + 本地假 Kmoe（任意邮箱，密码 kmoe-test）
bun run check      # 类型检查 + 测试 + 构建，提交前必须通过
```

- 只改界面时可以用演示模式：`bun run dev:web`，打开 `http://127.0.0.1:5190/?mock`，整套接口在浏览器里模拟（管理员密码 `demo1234`）。
- 开发时请尽量用 `dev:fake`，不要让本地开发频繁访问真实的 Kmoe：请求太快会被限制整个 IP。

## 代码约定

- **接口契约**：所有接口在 [`shared/api.ts`](shared/api.ts) 和 [`shared/model.ts`](shared/model.ts) 里用 zod 定义，前后端共用类型。
  新增接口先改这里，再实现 `server/api/handlers.ts` 和演示模式 `src/mock/server.ts`。
- **测试**：新逻辑要有测试。测试只用 `tests/` 里的假服务（Kmoe、WebDAV、Komga、Bangumi、AI），不访问任何真实网站。
- **依赖**：能用平台能力或已有依赖解决的，就不加新依赖；确实需要时在 PR 里说明理由。
- **界面文案**：简体中文，短句，说清原因和下一步；按钮用动词。遵循 [docs/design.md](docs/design.md) 的「墨与纸」设计：
  朱印色只用于主操作、选中和进度；数字用 `tabular-nums`；照顾浅色 / 深色、手机宽度和键盘操作。
- **注释**：写「为什么」，不写「做了什么」；和周围代码的风格保持一致。
- **对 Kmoe 友好**：对 Kmoe 的请求保持串行和间隔（批量任务每 10 秒一个页面），不要加并发抓取。

## Pull Request

1. 从 `main` 新建分支，一个 PR 只做一件事。
2. 确认 `bun run check` 通过；界面改动附上截图（浅色和深色，必要时加手机宽度）。
3. 写清楚改了什么、为什么；有关联的 Issue 就写上 `Closes #编号`。

提交的代码以本项目的 [MIT 许可证](LICENSE) 发布。

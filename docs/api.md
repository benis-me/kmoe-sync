# REST API 与 MCP

在 **设置 → API 与 MCP** 生成 API 令牌（只显示一次，可随时轮换或撤销）。令牌以 Bearer 方式携带：

```
Authorization: Bearer kms_xxxxxxxx
```

令牌只能调用下列与漫画、订阅、下载相关的接口；管理员密码、Kmoe 登录、存储位置与通知设置等只能在网页中修改。

## REST：`/api/v1/*`

与网页使用同一套接口（请求 / 响应结构见 [`shared/api.ts`](../shared/api.ts) 与 [`shared/model.ts`](../shared/model.ts)），
路径把 `/api/` 换成 `/api/v1/`。错误统一为 `{"error": {"code": "...", "message": "..."}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/status` | 服务状态：Kmoe 登录与额度、队列、下次检查 |
| GET | `/api/v1/search?q=关键词&page=1` | 搜索 Kmoe（需已登录 Kmoe） |
| POST | `/api/v1/resolve` `{"input": "<Kmoe 链接或 key>"}` | 链接 → 漫画 key |
| GET | `/api/v1/comics/:key?targetId=&format=` | 漫画详情、卷 / 话列表、每项状态 |
| POST | `/api/v1/comics/:key/refresh` | 立即从 Kmoe 重新读取 |
| POST | `/api/v1/comics/:key/library-check` `{"targetId", "format"}` | 扫描书库，核对已有文件 |
| PUT | `/api/v1/comics/:key/subscription` | 订阅 / 修改订阅（`SubscriptionInput`） |
| POST | `/api/v1/comics/:key/subscription/preview` | 保存前预览会新增 / 取消多少任务 |
| DELETE | `/api/v1/comics/:key/subscription?cancelPending=true` | 取消订阅 |
| POST | `/api/v1/comics/:key/check` | 立即检查这部漫画的更新 |
| GET | `/api/v1/shelf` | 书架 |
| POST | `/api/v1/checks/run` | 检查全部订阅 |
| GET | `/api/v1/tasks?status=&comicKey=&cursor=&limit=` | 下载任务 |
| POST | `/api/v1/tasks` `{"comicKey", "itemIds", "format", "targetId"}` | 下载指定卷 / 话 |
| POST | `/api/v1/tasks/:id/cancel` · `/retry`，`/api/v1/tasks/retry-failed` · `/cancel-queued` | 任务操作 |
| POST | `/api/v1/queue/pause` · `/api/v1/queue/resume` | 暂停 / 继续队列 |
| GET | `/api/v1/targets` · `/api/v1/activity` · `/api/v1/sources` · `/api/v1/sources/:id/items` | 只读列表 |
| GET | `/api/v1/library?targetId=` | 书库文件夹及其 Kmoe / Bangumi / Komga 状态、后台任务 |
| POST | `/api/v1/library/scan` `{"targetId", "match": true}` | 扫描已有文件夹并匹配 Kmoe（后台任务） |
| POST | `/api/v1/library/match-kmoe` · `/match-bangumi` · `/sync-komga` | 匹配 Kmoe / 匹配 Bangumi / 同步 Komga（后台任务） |
| POST | `/api/v1/library/folders/:id/sync` | 立即把一个文件夹的元数据写入 Komga |
| POST | `/api/v1/library/rename/preview` `{"targetId", "folderIds"?}` | 整理文件名：已关联文件夹里每个文件按命名规则的新名字（只读） |
| POST | `/api/v1/library/rename/ai` `{"folderId"}` | 用设置里的 AI 识别一个文件夹里认不出的文件，返回带 AI 结果的预览（用 AI 额度） |
| POST | `/api/v1/library/rename` `{"targetId", "renames": [{"folderId", "name", "to"}]}` | 按预览改名（后台任务，不覆盖已有文件，改完请求 Komga 扫描） |
| GET | `/api/v1/bangumi/search?q=` | 搜索 Bangumi 条目 |

示例：

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://nas:5663/api/v1/comics/8a3dbd
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"comicKey":"8a3dbd","itemIds":["1001","1002"],"format":"epub","targetId":1}' http://nas:5663/api/v1/tasks
```

## MCP：`POST /mcp`

Streamable HTTP（无状态，JSON 响应），协议版本 2025-06-18 / 2025-03-26 / 2024-11-05。

Claude Code：

```bash
claude mcp add --transport http kmoesync http://nas:5663/mcp --header "Authorization: Bearer $TOKEN"
```

其他客户端（如 Claude Desktop、Cursor）按其 HTTP MCP 配置填写同样的地址与请求头。

| 工具 | 作用 |
| --- | --- |
| `search_comics` | 搜索 Kmoe |
| `get_comic` | 漫画详情与每一卷 / 话的状态 |
| `list_shelf` | 书架 |
| `subscribe` / `unsubscribe` | 订阅追更（新订阅默认单行本、补齐缺失，存储位置和格式跟漫画页一致，已导入的漫画按它的文件夹；修改时没给的参数保持原样）/ 取消 |
| `check_updates` | 检查一部或全部订阅 |
| `download` | 下载指定项，或某类型下全部缺失的项（存储位置和格式同上） |
| `list_downloads` | 下载任务 |
| `library_check` | 扫描书库核对已有文件 |
| `get_status` | 服务状态 |
| `get_diagnostics` | 排查问题用的概况：服务状态、最近动态、失败的下载、书库出错的文件夹、代理和 AI 设置（不含密钥） |
| `set_queue` | 暂停 / 继续队列 |
| `library_status` | 书库概况，可列出待确认 / 未匹配 / 出错的文件夹 |
| `scan_library` | 扫描已有漫画文件夹并匹配 Kmoe |
| `sync_metadata` | 匹配 Bangumi 条目，或把元数据同步到 Komga |

漫画用 key（`/c/<key>.htm` 中的部分）或完整 Kmoe 链接指代。

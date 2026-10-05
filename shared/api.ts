// The HTTP contract: every JSON endpoint of the admin API, keyed by "METHOD /path".
// The server registers exactly these keys; the web client calls them through a typed request().
// Path params use :name. Streams and binaries (not JSON) are listed at the bottom.
import { z } from 'zod';
import {
  About, Activity, AiPolishItem, AiSettings, AiSettingsPatch, AiTestResult, AuthState, BangumiArchiveStatus, BangumiSubject, Channel, ComicDetail, DirEntry, DownloadRequest, DownloadResult, Format, KmoeAccount, KomgaDraft,
  KomgaTestResult, LibraryCheck, LibraryFolder, LibraryJob, LibraryOverview, Line, MetadataSettings, MetadataSettingsPatch, NetworkCheck, PolicyImpact,
  QueueState, Rename, RenameFolder, RenamePreview, SearchResult, Settings, SettingsPatch, ShelfEntry, Source, SourceInput, SourceItem, Status, Subscription, SubscriptionInput,
  Target, TargetInput, TaskList, TaskStatus, TestResult,
} from './model';

export const Ok = z.object({ ok: z.literal(true) });
const Password = z.string().min(8, '密码至少 8 位').max(200);
/** Query-string booleans arrive as "true"/"1". */
const QueryBool = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).transform(value => value === true || value === 'true' || value === '1');

/** Which storage target and format a comic's item states should be computed for. Defaults: subscription, else settings. */
export const ViewQuery = z.object({ targetId: z.coerce.number().int().optional(), format: Format.optional() });
export const TaskQuery = z.object({
  status: TaskStatus.optional(),
  comicKey: z.string().optional(),
  /** Pagination: tasks with id < cursor. */
  cursor: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
/** Either a saved target or an unsaved draft (settings form "test"/"browse" before saving). */
export const TargetRef = z.object({ targetId: z.number().int().optional(), draft: TargetInput.optional() })
  .refine(value => value.targetId !== undefined || value.draft !== undefined, '需要指定存储位置');

export const endpoints = {
  // Admin authentication (single administrator).
  'GET /api/auth/state': { res: AuthState },
  'POST /api/auth/setup': { body: z.object({ password: Password }), res: AuthState },
  'POST /api/auth/login': { body: z.object({ password: z.string().min(1).max(200) }), res: AuthState },
  'POST /api/auth/logout': { res: AuthState },
  'POST /api/auth/password': { body: z.object({ current: z.string().min(1), next: Password }), res: Ok },

  // Global status for the shell (also pushed over SSE).
  'GET /api/status': { res: Status },

  // Kmoe account. The password is used once and never stored; only the encrypted session is kept.
  /** `remember`: keep the password (sealed) to log in again by itself when the session expires; left out, the last choice stands. */
  'POST /api/kmoe/login': { body: z.object({ email: z.string().trim().email('请输入邮箱'), password: z.string().min(1).max(200), mirror: z.string().optional(), remember: z.boolean().optional() }), res: KmoeAccount },
  'POST /api/kmoe/refresh': { res: KmoeAccount },
  'POST /api/kmoe/logout': { res: KmoeAccount },
  /** Forgets the remembered password: no more logging in by itself. */
  'DELETE /api/kmoe/password': { res: KmoeAccount },
  'GET /api/kmoe/mirrors': { res: z.array(z.string()) },

  // Discover.
  'GET /api/search': { query: z.object({ q: z.string().trim().min(1).max(100), page: z.coerce.number().int().min(1).optional() }), res: SearchResult },
  /** Paste a Kmoe URL (any mirror, desktop or mobile) or a bare key; returns the comic key. */
  'POST /api/resolve': { body: z.object({ input: z.string().trim().min(1).max(500) }), res: z.object({ key: z.string() }) },

  // Comic page.
  'GET /api/comics/:key': { query: ViewQuery, res: ComicDetail },
  /** Re-fetch from Kmoe now (otherwise a recent cached copy may be served). */
  'POST /api/comics/:key/refresh': { query: ViewQuery, res: ComicDetail },
  'POST /api/comics/:key/library-check': { body: z.object({ targetId: z.number().int(), format: Format }), res: LibraryCheck },
  'PUT /api/comics/:key/subscription': { body: SubscriptionInput, res: Subscription },
  'POST /api/comics/:key/subscription/preview': { body: SubscriptionInput, res: PolicyImpact },
  'DELETE /api/comics/:key/subscription': { query: z.object({ cancelPending: QueryBool.optional() }), res: Ok },
  /** Check this subscription for new items now. */
  'POST /api/comics/:key/check': { res: Ok },

  // Shelf (home): everything subscribed or downloaded.
  'GET /api/shelf': { res: z.array(ShelfEntry) },
  /** Check all enabled subscriptions now. */
  'POST /api/checks/run': { res: z.object({ queued: z.number() }) },

  // Download queue.
  'GET /api/tasks': { query: TaskQuery, res: TaskList },
  'POST /api/tasks': { body: DownloadRequest, res: DownloadResult },
  'POST /api/tasks/:id/cancel': { res: Ok },
  'POST /api/tasks/:id/retry': { res: Ok },
  'POST /api/tasks/retry-failed': { res: z.object({ retried: z.number() }) },
  'POST /api/tasks/cancel-queued': { res: z.object({ cancelled: z.number() }) },
  'POST /api/tasks/clear-finished': { res: z.object({ removed: z.number() }) },
  'POST /api/queue/pause': { res: QueueState },
  'POST /api/queue/resume': { res: QueueState },

  // Storage targets (local directories under the library root, WebDAV servers).
  'GET /api/targets': { res: z.array(Target) },
  'POST /api/targets': { body: TargetInput, res: Target },
  'PATCH /api/targets/:id': { body: TargetInput.partial(), res: Target },
  'DELETE /api/targets/:id': { res: Ok },
  'POST /api/targets/:id/default': { res: Ok },
  'POST /api/targets/test': { body: TargetRef, res: TestResult },
  /** List directories (and files) at `path` of a target or draft; for local targets `path` is relative to the library root. */
  'POST /api/targets/browse': { body: z.object({ ref: TargetRef, path: z.string().max(1000) }), res: z.object({ path: z.string(), entries: z.array(DirEntry) }) },

  // Settings.
  'GET /api/settings': { res: Settings },
  'GET /api/about': { res: About },
  'PATCH /api/settings': { body: SettingsPatch, res: Settings },
  /** Whether Bangumi, GitHub and (kmoe) Kmoe answer through a draft proxy ('' = direct). */
  'POST /api/network/test': { body: z.object({ proxy: z.string().max(300), kmoe: z.boolean() }), res: z.array(NetworkCheck) },
  'POST /api/notifications/test': { body: Channel, res: TestResult },
  /** Create or rotate the API token (returned once), used by /api/v1 and /mcp. */
  'POST /api/token': { res: z.object({ token: z.string() }) },
  'DELETE /api/token': { res: Ok },
  /** Import a configuration exported by the Kmoe Sync browser extension (WebDAV servers, naming rule). */
  'POST /api/import/extension': { body: z.object({ config: z.unknown() }), res: z.object({ targets: z.number(), rule: z.boolean() }) },

  // Activity feed.
  'GET /api/activity': { query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }), res: z.array(Activity) },

  // Library: series folders on disk ↔ Kmoe comics ↔ Bangumi/Komga metadata. Jobs run one at a time in the background.
  /** Folders of a target (default: the default target) with link/metadata state and the current job. */
  'GET /api/library': { query: z.object({ targetId: z.coerce.number().int().optional() }), res: LibraryOverview },
  /** Scan the target for series folders; then optionally match them on Kmoe (needs a Kmoe login). */
  'POST /api/library/scan': { body: z.object({ targetId: z.number().int(), match: z.boolean().default(true) }), res: LibraryJob },
  /** Match pending (and previously unmatched) folders to Kmoe comics. */
  'POST /api/library/match-kmoe': { body: z.object({ targetId: z.number().int(), retry: z.boolean().default(false) }), res: LibraryJob },
  /** Find Bangumi subjects for folders without one. */
  'POST /api/library/match-bangumi': { body: z.object({ targetId: z.number().int(), retry: z.boolean().default(false) }), res: LibraryJob },
  /** Write metadata to Komga: dirty folders, or every matched folder with all=true. */
  'POST /api/library/sync-komga': { body: z.object({ targetId: z.number().int(), all: z.boolean().default(false) }), res: LibraryJob },
  /** Follow every ongoing comic linked in the target that is not subscribed yet: new items only, in its folder's format. */
  'POST /api/library/follow': { body: z.object({ targetId: z.number().int() }), res: LibraryJob },
  'POST /api/library/cancel': { res: LibraryJob },
  /** AI picks among the candidates of folders awaiting confirmation or not found (Kmoe or Bangumi); confident picks are linked. */
  'POST /api/library/ai-match': { body: z.object({ targetId: z.number().int(), kind: z.enum(['kmoe', 'bangumi']) }), res: LibraryJob },
  /** AI tidies the summary and tags of Bangumi-matched folders (new ones, or all=true), for review before they go to Komga. */
  'POST /api/library/ai-polish': { body: z.object({ targetId: z.number().int(), all: z.boolean().default(false) }), res: LibraryJob },
  'GET /api/library/ai-polish': { query: z.object({ targetId: z.coerce.number().int() }), res: z.array(AiPolishItem) },
  /** Use (accept) or drop the AI version of these folders; accepted ones are written to Komga at the next sync. */
  'POST /api/library/ai-polish/decide': { body: z.object({ folderIds: z.array(z.number().int()).min(1).max(5000), accept: z.boolean() }), res: z.object({ updated: z.number() }) },
  /** 整理文件名: what renaming the book files of linked folders to the naming rule would change. Reads the folders, changes nothing. */
  'POST /api/library/rename/preview': { body: z.object({ targetId: z.number().int(), folderIds: z.array(z.number().int()).max(5000).optional() }), res: RenamePreview },
  /** The AI reads the files of a folder whose names did not say which item they are; returns the folder planned with that. */
  'POST /api/library/rename/ai': { body: z.object({ folderId: z.number().int() }), res: RenameFolder },
  /** Renames the chosen files as a library job: each is checked again first, and nothing is ever overwritten. */
  'POST /api/library/rename': { body: z.object({ targetId: z.number().int(), renames: z.array(Rename).min(1).max(20000) }), res: LibraryJob },
  /** Link every suggested folder whose best Kmoe candidate scores at least minScore. */
  'POST /api/library/accept-suggested': { body: z.object({ targetId: z.number().int(), minScore: z.number().min(0).max(1).default(0.9) }), res: z.object({ linked: z.number() }) },
  /** Link a folder to a Kmoe comic (a candidate, a search result or a pasted link/key); fetches the comic and checks the folder. */
  'POST /api/library/folders/:id/kmoe': { body: z.object({ comic: z.string().trim().min(1).max(500) }), res: LibraryFolder },
  'POST /api/library/folders/:id/ignore': { res: LibraryFolder },
  /** Back to pending: forget the Kmoe link/candidates (files are untouched). */
  'POST /api/library/folders/:id/reset': { res: LibraryFolder },
  /** Choose the Bangumi subject (id or bgm.tv link), or re-run automatic matching with auto=true. */
  'POST /api/library/folders/:id/bangumi': { body: z.object({ subject: z.string().trim().max(200).optional(), auto: z.boolean().optional() }), res: LibraryFolder },
  'DELETE /api/library/folders/:id/bangumi': { res: LibraryFolder },
  /** Write this folder's metadata to Komga now. */
  'POST /api/library/folders/:id/sync': { res: LibraryFolder },
  /** Store (and download into) an existing folder for this comic on a target; runs a library check. */
  'PUT /api/comics/:key/folder': { body: z.object({ targetId: z.number().int(), path: z.string().min(1).max(1000) }), res: ComicDetail },
  /** Back to the naming rule's folder. */
  'DELETE /api/comics/:key/folder': { query: z.object({ targetId: z.coerce.number().int() }), res: ComicDetail },

  // Metadata (Bangumi → Komga).
  'GET /api/metadata/settings': { res: MetadataSettings },
  'PATCH /api/metadata/settings': { body: MetadataSettingsPatch, res: MetadataSettings },
  /** Test a Komga connection (saved settings merged with unsaved edits) and list its libraries. */
  'POST /api/metadata/komga/test': { body: KomgaDraft, res: KomgaTestResult },
  'GET /api/bangumi/search': { query: z.object({ q: z.string().trim().min(1).max(100) }), res: z.array(BangumiSubject) },
  /** Download (if newer) and import the Bangumi Archive dump now; force re-imports the current one. Runs in the background. */
  'POST /api/bangumi/archive/update': { body: z.object({ force: z.boolean().default(false) }), res: BangumiArchiveStatus },
  /** Check now whether the online Bangumi API is reachable (with the saved or draft proxy). */
  'POST /api/bangumi/online/test': { body: z.object({ proxy: z.string().max(300).optional() }), res: z.object({ reachable: z.boolean(), message: z.string() }) },

  // AI (OpenAI-compatible endpoint). The assistant's chat is a stream: POST /api/ai/chat (below).
  'GET /api/ai/settings': { res: AiSettings },
  'PATCH /api/ai/settings': { body: AiSettingsPatch, res: AiSettings },
  /** Try the saved settings merged with unsaved edits (an omitted key means the saved one). */
  'POST /api/ai/test': { body: AiSettingsPatch, res: AiTestResult },

  // Bangumi reading lists.
  'GET /api/sources': { res: z.array(Source) },
  'POST /api/sources': { body: SourceInput, res: Source },
  'PATCH /api/sources/:id': { body: SourceInput.partial(), res: Source },
  'DELETE /api/sources/:id': { res: Ok },
  'POST /api/sources/:id/sync': { res: Source },
  'GET /api/sources/:id/items': { res: z.array(SourceItem) },
  /** Link a Bangumi item to a Kmoe comic (then subscribe on the comic page). */
  'POST /api/source-items/:id/match': { body: z.object({ comicKey: z.string().min(1) }), res: SourceItem },
  'POST /api/source-items/:id/dismiss': { res: SourceItem },
  'POST /api/source-items/:id/restore': { res: SourceItem },
} as const;

export type Endpoints = typeof endpoints;
export type EndpointKey = keyof Endpoints;
type Field<K extends EndpointKey, F extends string> = Endpoints[K] extends Record<F, infer S> ? S : never;
export type ResponseOf<K extends EndpointKey> = z.output<Field<K, 'res'>>;
export type BodyOf<K extends EndpointKey> = Field<K, 'body'> extends z.ZodType ? z.input<Field<K, 'body'>> : undefined;
export type QueryOf<K extends EndpointKey> = Field<K, 'query'> extends z.ZodType ? z.input<Field<K, 'query'>> : undefined;
type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}` ? Name | ParamNames<`/${Rest}`> : P extends `${string}:${infer Name}` ? Name : never;
export type ParamsOf<K extends EndpointKey> = K extends `${string} ${infer Path}` ? [ParamNames<Path>] extends [never] ? undefined : Record<ParamNames<Path>, string | number> : undefined;

/**
 * Non-JSON routes:
 *   GET  /api/events          text/event-stream of ServerEvent (session cookie auth)
 *   GET  /api/covers/:key     cached cover image
 *   GET  /api/health          liveness ({ ok: true }), unauthenticated
 *   *    /api/v1/*            external API (Authorization: Bearer <token>), see docs/api.md
 *   POST /mcp                 MCP Streamable HTTP endpoint (Bearer token)
 *   POST /api/ai/chat         the assistant: ChatRequest in, newline-delimited ChatEvent JSON out (session + CSRF)
 */
export type { Line };

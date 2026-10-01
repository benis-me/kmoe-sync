// Domain model shared by the server and the web app. Timestamps are ISO-8601 strings (UTC).
import { z } from 'zod';

export const ContentType = z.enum(['volume', 'extra', 'serial']);
export type ContentType = z.infer<typeof ContentType>;
export const CONTENT_LABELS: Record<ContentType, string> = { volume: '单行本', extra: '番外', serial: '连载话' };
/** The kinds of items a comic's progress and new items count: its subscription's, else those downloaded, else volumes. */
export const followedTypes = (subscribed: readonly ContentType[] | null | undefined, downloaded: readonly ContentType[]): ContentType[] =>
  subscribed?.length ? [...subscribed] : downloaded.length ? [...new Set(downloaded)] : ['volume'];

export const Format = z.enum(['epub', 'mobi']);
export type Format = z.infer<typeof Format>;

/** Kmoe download line: 0 = 线路一, 1 = 线路二 (VIP only on the site). */
export const Line = z.union([z.literal(0), z.literal(1)]);
export type Line = z.infer<typeof Line>;

/** future = 仅追新 (keep what exists as the baseline), backfill = 补齐缺失 (queue everything missing now). */
export const Strategy = z.enum(['future', 'backfill']);
export type Strategy = z.infer<typeof Strategy>;

const Timestamp = z.string();
const Nullable = <T extends z.ZodType>(schema: T) => schema.nullable();

// ---------- Comics ----------
export const ComicSummary = z.object({
  /** Page key from /c/<key>.htm; the stable identity used everywhere in the app. */
  key: z.string().min(1),
  title: z.string(),
  authors: z.array(z.string()),
  /** Same-origin cover URL (/api/covers/<key>) or null. */
  cover: Nullable(z.string()),
  language: Nullable(z.string()),
  /** Latest volume/chapter label shown by the site's list, if known. */
  latest: Nullable(z.string()),
  updatedAt: Nullable(z.string()),
  /** Subscribed here or has downloads here. */
  tracked: z.boolean(),
});
export type ComicSummary = z.infer<typeof ComicSummary>;

export const Item = z.object({
  /** Kmoe volume id. */
  id: z.string(),
  type: ContentType,
  name: z.string(),
  order: Nullable(z.number().int()),
  pages: Nullable(z.number().int()),
  sizeMB: z.object({ epub: Nullable(z.number()), mobi: Nullable(z.number()) }),
  /** Appeared in the most recent subscription check. */
  isNew: z.boolean(),
});
export type Item = z.infer<typeof Item>;

export const ItemState = z.enum(['missing', 'downloaded', 'unknown', 'queued', 'running', 'failed']);
export type ItemState = z.infer<typeof ItemState>;
export const ItemStateInfo = z.object({
  state: ItemState,
  /** Remote/local paths that matched, when known. */
  paths: z.array(z.string()),
  reason: Nullable(z.string()),
  taskId: Nullable(z.number()),
});
export type ItemStateInfo = z.infer<typeof ItemStateInfo>;

export const LibraryChapter = z.object({ id: z.string(), status: z.enum(['downloaded', 'missing', 'unknown']), paths: z.array(z.string()), reason: z.string() });
export const LibraryCheck = z.object({
  targetId: z.number(),
  format: Format,
  checkedAt: Timestamp,
  directory: z.string(),
  directoryExists: z.boolean(),
  chapters: z.array(LibraryChapter),
  unmatched: z.array(z.string()),
});
export type LibraryCheck = z.infer<typeof LibraryCheck>;

// ---------- Library folders: series folders on disk (one per Komga series) ----------
/** What the AI concluded about a folder's candidates (设置 → AI): the pick (a Kmoe key or Bangumi id), how sure, and why. */
export const AiVerdict = z.object({ pick: Nullable(z.string()), confidence: z.number(), reason: z.string(), at: Timestamp });
export type AiVerdict = z.infer<typeof AiVerdict>;
/** Link from a folder to a Kmoe comic. suggested = candidates await confirmation. */
export const KmoeLinkState = z.enum(['pending', 'suggested', 'matched', 'unmatched', 'ignored']);
export type KmoeLinkState = z.infer<typeof KmoeLinkState>;
export const KmoeCandidate = z.object({
  key: z.string(), title: z.string(), authors: z.array(z.string()), cover: Nullable(z.string()), latest: Nullable(z.string()),
  /** 0–1 title similarity; 1 = same title. */
  score: z.number(),
});
export type KmoeCandidate = z.infer<typeof KmoeCandidate>;

export const BangumiState = z.enum(['none', 'matched', 'suggested', 'unmatched']);
export type BangumiState = z.infer<typeof BangumiState>;
/** disabled = Komga not configured or this target has no Komga library. */
export const KomgaState = z.enum(['disabled', 'pending', 'not_found', 'synced', 'error']);
export type KomgaState = z.infer<typeof KomgaState>;
export const BangumiSubject = z.object({
  id: z.number(),
  name: z.string(),
  nameCn: Nullable(z.string()),
  /** 漫画 / 小说 / 画集 … */
  platform: Nullable(z.string()),
  date: Nullable(z.string()),
  /** Bangumi image URL (external). */
  cover: Nullable(z.string()),
  volumes: Nullable(z.number()),
  authors: z.array(z.string()),
  /** A series entry (not a single volume). */
  series: z.boolean(),
  url: z.string(),
});
export type BangumiSubject = z.infer<typeof BangumiSubject>;
export const BangumiCandidate = BangumiSubject.extend({ score: z.number() });
export type BangumiCandidate = z.infer<typeof BangumiCandidate>;

export const FolderMetadata = z.object({
  bangumi: z.object({
    state: BangumiState,
    subject: Nullable(BangumiSubject),
    /** Best first (by score). */
    candidates: z.array(BangumiCandidate),
    /** auto = matcher, manual = chosen here, komga = taken from the Komga series' Bangumi link, ai = the AI's confident pick. */
    source: Nullable(z.enum(['auto', 'manual', 'komga', 'ai'])),
    checkedAt: Nullable(Timestamp),
    ai: Nullable(AiVerdict),
  }),
  komga: z.object({
    state: KomgaState,
    seriesId: Nullable(z.string()),
    /** Link to the series in the Komga web UI. */
    seriesUrl: Nullable(z.string()),
    syncedAt: Nullable(Timestamp),
    error: Nullable(z.string()),
    /** Waiting to be (re)synced, e.g. after new downloads. */
    dirty: z.boolean(),
  }),
  /** AI-tidied summary and tags: waiting for review, used when syncing, or not wanted. */
  polish: Nullable(z.enum(['pending', 'accepted', 'rejected'])),
});
export type FolderMetadata = z.infer<typeof FolderMetadata>;

export const LibraryFolder = z.object({
  id: z.number(),
  targetId: z.number(),
  /** Relative to the target, e.g. "/GRAND BLUE 碧藍之海". */
  path: z.string(),
  name: z.string(),
  /** Book files directly in the folder. */
  books: z.number(),
  /** Dominant e-book format of the files (epub/mobi), when any. */
  format: Nullable(Format),
  sample: Nullable(z.string()),
  /** Title guessed from file names ("[Kmoe][X]卷01" / "X-卷 01"). */
  hint: Nullable(z.string()),
  kmoe: z.object({
    state: KmoeLinkState,
    comic: Nullable(ComicSummary),
    /** Best first (by score). */
    candidates: z.array(KmoeCandidate),
    score: Nullable(z.number()),
    error: Nullable(z.string()),
    ai: Nullable(AiVerdict),
  }),
  metadata: FolderMetadata,
  scannedAt: Nullable(Timestamp),
});
export type LibraryFolder = z.infer<typeof LibraryFolder>;

/** One background library job at a time: scan folders, match Kmoe, match Bangumi, sync Komga, an AI pass, or follow ongoing comics. */
export const LibraryJobKind = z.enum(['scan', 'kmoe', 'bangumi', 'komga', 'ai', 'follow']);
export type LibraryJobKind = z.infer<typeof LibraryJobKind>;
export const LibraryJob = z.object({
  kind: Nullable(LibraryJobKind),
  running: z.boolean(),
  targetId: Nullable(z.number()),
  done: z.number(),
  total: z.number(),
  /** Path of the folder being processed (scan: the directory being read). */
  current: Nullable(z.string()),
  /** Why the job stopped early; null when it finished or was cancelled. */
  error: Nullable(z.string()),
  /** Stopped by the user (or a restart) before finishing. */
  cancelled: z.boolean(),
  startedAt: Nullable(Timestamp),
  finishedAt: Nullable(Timestamp),
});
export type LibraryJob = z.infer<typeof LibraryJob>;
export const LibraryCounts = z.object({
  folders: z.number(),
  books: z.number(),
  kmoe: z.record(KmoeLinkState, z.number()),
  bangumi: z.record(BangumiState, z.number()),
  komga: z.record(KomgaState, z.number()),
});
export type LibraryCounts = z.infer<typeof LibraryCounts>;
export const LibraryOverview = z.object({
  targetId: z.number(),
  /** Last completed scan of this target; null = never scanned. */
  scannedAt: Nullable(Timestamp),
  job: LibraryJob,
  counts: LibraryCounts,
  folders: z.array(LibraryFolder),
  /** Linked comics still coming out (連載) that are not followed yet: what 追更连载中的 subscribes. */
  follow: z.number(),
});
export type LibraryOverview = z.infer<typeof LibraryOverview>;

/** Where a comic's files live on the viewed target: a mapped existing folder, or the naming rule's folder. */
export const ComicFolder = z.object({ targetId: z.number(), path: z.string(), mapped: z.boolean(), folderId: Nullable(z.number()) });
export type ComicFolder = z.infer<typeof ComicFolder>;

// ---------- Komga metadata settings ----------
export const KomgaLibrary = z.object({ id: z.string(), name: z.string(), root: z.string() });
export type KomgaLibrary = z.infer<typeof KomgaLibrary>;
export const MetadataOptions = z.object({
  /** Series title from Bangumi: Chinese name (fallback original) or original name. */
  titleLanguage: z.enum(['cn', 'original']),
  /** Also write per-volume metadata (number, release date, ISBN, authors). */
  books: z.boolean(),
  /** Replace Komga posters with Bangumi covers. */
  posters: z.enum(['off', 'series', 'all']),
  /** Lock written fields so Komga's own metadata refresh keeps them. */
  lock: z.boolean(),
  /** Match and sync automatically after downloads/imports. */
  autoSync: z.boolean(),
  /** Max Bangumi tags written to Komga. */
  tagLimit: z.number().int().min(0).max(30),
  /** Komga's reading direction for every series; auto: right to left for Japanese manga, the rest untouched; keep: never written. */
  readingDirection: z.enum(['WEBTOON', 'RIGHT_TO_LEFT', 'LEFT_TO_RIGHT', 'VERTICAL', 'auto', 'keep']),
});
export type MetadataOptions = z.infer<typeof MetadataOptions>;
/** Offline copy of Bangumi's book data (weekly Bangumi Archive dump from GitHub), for networks where bgm.tv is blocked. */
export const BangumiArchiveStatus = z.object({
  state: z.enum(['none', 'downloading', 'importing', 'ready', 'error']),
  /** Dump file name, e.g. dump-2026-09-22.210341Z.zip. */
  dump: Nullable(z.string()),
  /** When Bangumi exported that dump. */
  dumpDate: Nullable(Timestamp),
  importedAt: Nullable(Timestamp),
  /** Book subjects available offline. */
  subjects: z.number(),
  /** Bytes while downloading; uncompressed bytes read while importing (use as a percentage). */
  progress: Nullable(z.object({ done: z.number(), total: z.number() })),
  error: Nullable(z.string()),
  /** Last time the newest dump was looked up. */
  checkedAt: Nullable(Timestamp),
});
export type BangumiArchiveStatus = z.infer<typeof BangumiArchiveStatus>;
/** auto = online API when reachable, else the offline archive; online / archive = only that source. */
export const BangumiSource = z.enum(['auto', 'online', 'archive']);
export type BangumiSource = z.infer<typeof BangumiSource>;

export const MetadataSettings = z.object({
  enabled: z.boolean(),
  komga: z.object({
    url: z.string(),
    auth: z.enum(['apiKey', 'basic']),
    username: z.string(),
    /** An API key (apiKey) or password (basic) is stored; never returned. */
    hasSecret: z.boolean(),
    /** Which Komga library shows each storage target (same folder tree). */
    libraries: z.array(z.object({ targetId: z.number(), libraryId: z.string() })),
  }),
  bangumi: z.object({
    hasToken: z.boolean(),
    source: BangumiSource,
    /** Whether the online API answered at the last check (null = not checked yet). */
    online: z.object({ reachable: Nullable(z.boolean()), checkedAt: Nullable(Timestamp), error: Nullable(z.string()) }),
    archive: BangumiArchiveStatus,
  }),
  options: MetadataOptions,
});
export type MetadataSettings = z.infer<typeof MetadataSettings>;
export const KomgaDraft = z.object({
  url: z.string().max(500).optional(),
  auth: z.enum(['apiKey', 'basic']).optional(),
  username: z.string().max(200).optional(),
  /** Omit to keep the stored secret; empty string clears it. */
  secret: z.string().max(500).optional(),
});
export type KomgaDraft = z.infer<typeof KomgaDraft>;
export const MetadataSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  komga: KomgaDraft.extend({ libraries: z.array(z.object({ targetId: z.number().int(), libraryId: z.string().min(1) })).optional() }).optional(),
  /** Bangumi access token (only needed for NSFW entries; omit keeps, '' clears) and data source. */
  bangumi: z.object({ token: z.string().max(500).optional(), source: BangumiSource.optional() }).optional(),
  options: MetadataOptions.partial().optional(),
});
export type MetadataSettingsPatch = z.infer<typeof MetadataSettingsPatch>;
export const KomgaTestResult = z.object({ ok: z.boolean(), message: z.string(), version: Nullable(z.string()), libraries: z.array(KomgaLibrary) });
export type KomgaTestResult = z.infer<typeof KomgaTestResult>;

// ---------- Subscriptions ----------
export const SubscriptionInput = z.object({
  enabled: z.boolean().default(true),
  types: z.array(ContentType).min(1),
  format: Format,
  targetId: z.number().int(),
  strategy: Strategy,
  line: Line.default(0),
});
export type SubscriptionInput = z.infer<typeof SubscriptionInput>;

export const Subscription = z.object({
  id: z.number(),
  comicKey: z.string(),
  enabled: z.boolean(),
  types: z.array(ContentType),
  format: Format,
  targetId: z.number(),
  strategy: Strategy,
  line: Line,
  lastCheckAt: Nullable(Timestamp),
  lastSuccessAt: Nullable(Timestamp),
  nextCheckAt: Nullable(Timestamp),
  error: Nullable(z.string()),
  createdAt: Timestamp,
});
export type Subscription = z.infer<typeof Subscription>;

/** What saving a subscription policy would do right now. `unknown`: wanted items a library check could not confirm (left out). */
export const PolicyImpact = z.object({ queue: z.number(), cancel: z.number(), sizeMB: z.number(), unknown: z.number() });
export type PolicyImpact = z.infer<typeof PolicyImpact>;

export const ComicDetail = z.object({
  comic: ComicSummary.extend({
    /** Numeric id required by the download API. */
    bookId: z.string(),
    description: Nullable(z.string()),
    /** e.g. 連載 / 完結 */
    status: Nullable(z.string()),
    fetchedAt: Timestamp,
  }),
  items: z.array(Item),
  subscription: Nullable(Subscription),
  /** Target + format the item states below refer to. */
  view: z.object({ targetId: Nullable(z.number()), format: Format }),
  states: z.record(z.string(), ItemStateInfo),
  library: Nullable(LibraryCheck),
  /** The comic's folder on the viewed target (null when no target). */
  folder: Nullable(ComicFolder),
  /** Bangumi/Komga metadata of that folder, when it exists on disk. */
  metadata: Nullable(FolderMetadata),
});
export type ComicDetail = z.infer<typeof ComicDetail>;

export const ShelfEntry = z.object({
  comic: ComicSummary,
  subscription: Nullable(Subscription),
  counts: z.object({ items: z.number(), downloaded: z.number(), queued: z.number(), failed: z.number(), new: z.number() }),
  lastActivityAt: Nullable(Timestamp),
  /** Metadata state of the comic's folder on its default target. */
  metadata: Nullable(z.object({ bangumi: BangumiState, komga: KomgaState })),
});
export type ShelfEntry = z.infer<typeof ShelfEntry>;

export const SearchResult = z.object({ query: z.string(), page: z.number(), totalPages: z.number(), results: z.array(ComicSummary) });
export type SearchResult = z.infer<typeof SearchResult>;

// ---------- Tasks ----------
export const TaskStatus = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatus>;
/** Detail of a running task; `waiting` = queued again after a transient failure until retryAt. */
export const TaskPhase = z.enum(['resolving', 'downloading', 'uploading', 'verifying', 'waiting']);
export type TaskPhase = z.infer<typeof TaskPhase>;
export const TaskOrigin = z.enum(['manual', 'subscription', 'api']);

export const Task = z.object({
  id: z.number(),
  comicKey: z.string(),
  comicTitle: z.string(),
  cover: Nullable(z.string()),
  itemId: z.string(),
  itemName: z.string(),
  type: ContentType,
  format: Format,
  targetId: z.number(),
  targetName: z.string(),
  status: TaskStatus,
  phase: Nullable(TaskPhase),
  attempt: z.number(),
  maxAttempts: z.number(),
  retryAt: Nullable(Timestamp),
  loaded: z.number(),
  total: Nullable(z.number()),
  /** Bytes per second, smoothed. */
  speed: z.number(),
  path: Nullable(z.string()),
  error: Nullable(z.string()),
  errorCode: Nullable(z.string()),
  origin: TaskOrigin,
  createdAt: Timestamp,
  startedAt: Nullable(Timestamp),
  finishedAt: Nullable(Timestamp),
});
export type Task = z.infer<typeof Task>;

export const QueueCounts = z.object({ queued: z.number(), running: z.number(), completed: z.number(), failed: z.number(), cancelled: z.number() });
export type QueueCounts = z.infer<typeof QueueCounts>;
export const TaskList = z.object({ tasks: z.array(Task), counts: QueueCounts, nextCursor: Nullable(z.number()) });
export type TaskList = z.infer<typeof TaskList>;

export const DownloadRequest = z.object({
  comicKey: z.string().min(1),
  itemIds: z.array(z.string().min(1)).min(1).max(1000),
  format: Format,
  targetId: z.number().int(),
  line: Line.default(0),
});
export type DownloadRequest = z.infer<typeof DownloadRequest>;
export const DownloadResult = z.object({ created: z.number(), skipped: z.number(), sizeMB: z.number() });
export type DownloadResult = z.infer<typeof DownloadResult>;

// ---------- Storage targets ----------
export const TargetKind = z.enum(['local', 'webdav']);
export type TargetKind = z.infer<typeof TargetKind>;
export const Target = z.object({
  id: z.number(),
  kind: TargetKind,
  name: z.string(),
  /** local: sub-directory under the library root ("/" = root). webdav: base directory on the server. */
  path: z.string(),
  /** WebDAV base URL; null for local targets. */
  url: Nullable(z.string()),
  username: Nullable(z.string()),
  hasPassword: z.boolean(),
  /** Naming rule, same syntax as the browser extension, e.g. {title}/{filename}. */
  rule: z.string(),
  isDefault: z.boolean(),
  createdAt: Timestamp,
});
export type Target = z.infer<typeof Target>;
export const TargetInput = z.object({
  kind: TargetKind,
  name: z.string().trim().min(1).max(60),
  path: z.string().max(500),
  url: z.string().max(500).optional(),
  username: z.string().max(200).optional(),
  /** Omit to keep the stored password; empty string clears it. */
  password: z.string().max(500).optional(),
  rule: z.string().max(500),
});
export type TargetInput = z.infer<typeof TargetInput>;
export const DirEntry = z.object({ name: z.string(), path: z.string(), directory: z.boolean(), size: z.number() });
export type DirEntry = z.infer<typeof DirEntry>;
export const TestResult = z.object({ ok: z.boolean(), message: z.string() });
export type TestResult = z.infer<typeof TestResult>;

// ---------- Kmoe account & status ----------
export const Quota = z.object({ totalMB: Nullable(z.number()), usedMB: Nullable(z.number()), resetDay: Nullable(z.number()) });
export type Quota = z.infer<typeof Quota>;
export const KmoeAccount = z.object({
  state: z.enum(['none', 'active', 'expired']),
  email: Nullable(z.string()),
  mirror: Nullable(z.string()),
  level: Nullable(z.number()),
  vip: Nullable(z.boolean()),
  free: Nullable(Quota),
  vipQuota: Nullable(Quota),
  /** free + vip remaining, when known. */
  remainingMB: Nullable(z.number()),
  checkedAt: Nullable(Timestamp),
  error: Nullable(z.string()),
  /** Kmoe is limiting this service's request rate (it redirects to a search engine); all Kmoe requests pause until then. */
  throttledUntil: Nullable(Timestamp),
  /** The user wants the password kept (sealed) to log in again by itself when the session expires. */
  remember: z.boolean(),
});
export type KmoeAccount = z.infer<typeof KmoeAccount>;

/** network = connection lost after retries; throttled = Kmoe limits the request rate. Both resume by themselves. */
export const PauseReason = z.enum(['manual', 'quota', 'auth', 'network', 'throttled']);
export type PauseReason = z.infer<typeof PauseReason>;
export const QueueState = z.object({ paused: z.boolean(), reason: Nullable(PauseReason), counts: QueueCounts, speed: z.number() });
export type QueueState = z.infer<typeof QueueState>;

export const Status = z.object({
  version: z.string(),
  kmoe: KmoeAccount,
  queue: QueueState,
  nextCheckAt: Nullable(Timestamp),
  checking: z.boolean(),
  /** Absolute library root inside the container, for display. */
  libraryRoot: z.string(),
  targets: z.number(),
});
export type Status = z.infer<typeof Status>;

// ---------- Settings & notifications ----------
export const NotifyEvent = z.enum(['new_items', 'download_done', 'download_failed', 'session_expired', 'quota_low']);
export type NotifyEvent = z.infer<typeof NotifyEvent>;
export const NOTIFY_LABELS: Record<NotifyEvent, string> = {
  new_items: '发现新章节', download_done: '下载完成', download_failed: '下载失败', session_expired: 'Kmoe 登录失效', quota_low: '额度不足',
};
const ChannelBase = { id: z.string().min(1), name: z.string().trim().min(1).max(40), events: z.array(NotifyEvent), enabled: z.boolean() };
export const Channel = z.discriminatedUnion('kind', [
  z.object({ ...ChannelBase, kind: z.literal('webhook'), url: z.string().url() }),
  z.object({ ...ChannelBase, kind: z.literal('bark'), server: z.string().url(), key: z.string().min(1) }),
  z.object({ ...ChannelBase, kind: z.literal('telegram'), token: z.string().min(1), chatId: z.string().min(1) }),
]);
export type Channel = z.infer<typeof Channel>;

export const Settings = z.object({
  checkIntervalHours: z.number().int().min(1).max(168),
  concurrency: z.number().int().min(1).max(4),
  autoRetry: z.boolean(),
  maxRetries: z.number().int().min(1).max(10),
  /** Pause the queue before remaining quota drops below this. */
  quotaReserveMB: z.number().min(0).max(1_000_000),
  defaultFormat: Format,
  defaultLine: Line,
  defaultTargetId: Nullable(z.number()),
  preferredMirror: z.string(),
  notifications: z.array(Channel),
  /** HTTP proxy for connections that leave the LAN (Bangumi, GitHub, notifications), e.g. http://192.168.1.2:7890; '' = direct. */
  proxy: z.string().max(300),
  /** Kmoe (pages and downloads) through the proxy too; off = Kmoe is reached directly. */
  proxyKmoe: z.boolean(),
  /** Read-only: whether an API token exists. */
  apiToken: z.boolean(),
});
export type Settings = z.infer<typeof Settings>;
export const SettingsPatch = Settings.omit({ apiToken: true }).partial();
export type SettingsPatch = z.infer<typeof SettingsPatch>;
/** 设置 → 关于: the version, where the server runs, and what it holds. */
export const About = z.object({
  version: z.string(),
  runtime: z.object({ bun: z.string(), platform: z.string(), arch: z.string(), timezone: z.string() }),
  startedAt: Timestamp,
  paths: z.object({ data: z.string(), library: z.string() }),
  /** The user the server runs as (Docker PUID/PGID: who owns what it writes); null where the OS has none. */
  user: Nullable(z.object({ uid: z.number(), gid: z.number() })),
  databaseBytes: z.number(),
  counts: z.object({ comics: z.number(), subscriptions: z.number(), folders: z.number(), tasks: z.number() }),
});
export type About = z.infer<typeof About>;

/** One destination of 设置 → 网络代理 → 测试. */
export const NetworkCheck = z.object({ name: z.string(), ok: z.boolean(), message: z.string() });
export type NetworkCheck = z.infer<typeof NetworkCheck>;

// ---------- AI (an OpenAI-compatible chat endpoint: DeepSeek, OpenRouter, a local server…) ----------
export const AiProvider = z.enum(['deepseek', 'openrouter', 'custom']);
export type AiProvider = z.infer<typeof AiProvider>;
export const AiSettings = z.object({
  provider: AiProvider,
  /** e.g. https://api.deepseek.com — `/chat/completions` and `/models` live under it. */
  baseUrl: z.string(),
  model: z.string(),
  /** A key is stored (it is never returned). */
  hasKey: z.boolean(),
  /** Through 设置 → 网络代理. */
  useProxy: z.boolean(),
  /** Tokens per calendar month; 0 = no limit. */
  monthlyTokens: z.number().int().min(0),
  /** This month's usage (month = "2026-09"). */
  usage: z.object({ month: z.string(), tokens: z.number() }),
  /** Address, model and key are set: the AI features can run. */
  ready: z.boolean(),
});
export type AiSettings = z.infer<typeof AiSettings>;
export const AiSettingsPatch = z.object({
  provider: AiProvider.optional(),
  baseUrl: z.string().max(300).optional(),
  model: z.string().max(200).optional(),
  /** Omit to keep the stored key; '' clears it. */
  apiKey: z.string().max(500).optional(),
  useProxy: z.boolean().optional(),
  monthlyTokens: z.number().int().min(0).max(1_000_000_000).optional(),
});
export type AiSettingsPatch = z.infer<typeof AiSettingsPatch>;
/** 设置 → AI → 测试: reachable, the models the endpoint lists, and whether it honours JSON mode (null = unknown). */
export const AiTestResult = z.object({ ok: z.boolean(), message: z.string(), models: z.array(z.string()), json: Nullable(z.boolean()) });
export type AiTestResult = z.infer<typeof AiTestResult>;
export const MetadataText = z.object({ summary: z.string(), genres: z.array(z.string()), tags: z.array(z.string()) });
export type MetadataText = z.infer<typeof MetadataText>;
/** A folder's Bangumi summary and tags next to the AI-tidied version, for review before they go to Komga. */
export const AiPolishItem = z.object({
  folderId: z.number(), path: z.string(), title: z.string(),
  original: MetadataText, polished: MetadataText,
  status: z.enum(['pending', 'accepted', 'rejected']),
  at: Timestamp,
});
export type AiPolishItem = z.infer<typeof AiPolishItem>;

/** A turn of the assistant conversation in the OpenAI chat format; the browser keeps it and sends it back each time. */
export const ChatToolCall = z.object({ id: z.string().max(200), type: z.literal('function'), function: z.object({ name: z.string().max(100), arguments: z.string().max(100_000) }) });
export type ChatToolCall = z.infer<typeof ChatToolCall>;
export const ChatMessage = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string().max(200_000).nullable(),
  tool_calls: z.array(ChatToolCall).max(20).optional(),
  tool_call_id: z.string().max(200).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;
/** POST /api/ai/chat: the conversation so far, plus the user's answers (tool call id → approved) to actions awaiting confirmation. */
export const ChatRequest = z.object({
  messages: z.array(ChatMessage).min(1).max(300), decisions: z.record(z.string(), z.boolean()).optional(),
  /** The page the user is looking at ("/comics/c9d0e1", "/library?filter=pending"): context for "这部" and "这里". */
  page: z.string().max(300).regex(/^\//).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;
/** The chat response is a stream of these, one JSON object per line. */
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; label: string; status: 'running' | 'done' | 'error' | 'rejected' }
  | { type: 'confirm'; calls: { id: string; name: string; label: string }[] }
  | { type: 'messages'; messages: ChatMessage[] }
  | { type: 'error'; message: string }
  | { type: 'done' };

// ---------- Activity ----------
export const ActivityKind = z.enum([
  'new_items', 'download_done', 'download_failed', 'check_failed', 'session_expired', 'session_restored',
  'quota_low', 'queue_paused', 'queue_resumed', 'source_synced', 'info',
]);
export const Activity = z.object({
  id: z.number(),
  kind: ActivityKind,
  level: z.enum(['info', 'success', 'warning', 'error']),
  title: z.string(),
  detail: Nullable(z.string()),
  comicKey: Nullable(z.string()),
  createdAt: Timestamp,
});
export type Activity = z.infer<typeof Activity>;

// ---------- Bangumi sources ----------
export const BangumiType = z.enum(['wish', 'collect', 'doing', 'on_hold', 'dropped']);
export type BangumiType = z.infer<typeof BangumiType>;
export const BANGUMI_LABELS: Record<BangumiType, string> = { wish: '想看', collect: '看过', doing: '在看', on_hold: '搁置', dropped: '抛弃' };
export const SourceInput = z.object({
  name: z.string().trim().min(1).max(40),
  username: z.string().trim().min(1).max(60),
  types: z.array(BangumiType).min(1),
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(720),
});
export type SourceInput = z.infer<typeof SourceInput>;
export const Source = SourceInput.extend({ id: z.number(), itemCount: z.number(), pendingCount: z.number(), lastSyncAt: Nullable(Timestamp), error: Nullable(z.string()) });
export type Source = z.infer<typeof Source>;
export const SourceItem = z.object({
  id: z.number(),
  sourceId: z.number(),
  externalId: z.string(),
  title: z.string(),
  originalTitle: Nullable(z.string()),
  status: BangumiType,
  cover: Nullable(z.string()),
  url: z.string(),
  match: z.object({ state: z.enum(['pending', 'matched', 'dismissed']), comicKey: Nullable(z.string()), comicTitle: Nullable(z.string()) }),
  firstSeenAt: Timestamp,
});
export type SourceItem = z.infer<typeof SourceItem>;

// ---------- Auth ----------
export const AuthState = z.object({ setupRequired: z.boolean(), authenticated: z.boolean(), csrf: Nullable(z.string()) });
export type AuthState = z.infer<typeof AuthState>;

// ---------- Server-sent events (/api/events) ----------
export type ServerEvent =
  | { type: 'task'; task: Task }
  | { type: 'status'; status: Status }
  | { type: 'activity'; activity: Activity }
  /** Comic data or its item states changed: refetch it. */
  | { type: 'comic'; key: string }
  | { type: 'shelf' }
  /** Background library job progress (throttled). */
  | { type: 'library'; job: LibraryJob }
  /** Folders of a target changed: refetch the library overview. */
  | { type: 'folders'; targetId: number }
  /** Offline Bangumi data download/import progress (throttled). */
  | { type: 'bangumi-archive'; archive: BangumiArchiveStatus };

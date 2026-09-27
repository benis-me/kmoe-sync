// Bangumi → Komga metadata for library folders: settings (secrets sealed), matching folders to Bangumi subjects, writing
// series/book metadata to Komga, background jobs and the per-minute scheduler hook. Replaces a separate BangumiKomga.
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  BangumiArchiveStatus, BangumiCandidate, BangumiSource, BangumiState, BangumiSubject, FolderMetadata, KomgaDraft, KomgaState, KomgaTestResult,
  AiPolishItem, AiVerdict, LibraryCheck, LibraryJob, MetadataOptions, MetadataSettings, MetadataSettingsPatch, MetadataText, NetworkCheck,
} from '@shared/model';
import { AI_CONFIDENT, type AiService, type FolderFacts } from '../ai/service';
import { json, now, type DB } from '../db';
import type { EventHub } from '../events';
import { AppError } from '../http/errors';
import type { Sealer } from '../lib/crypto';
import { errorMessage, isRetryable, transient } from '../lib/retry';
import type { ActivityLog } from '../services/activity';
import type { ComicService, ItemRow } from '../services/comics';
import type { JobRunner } from '../services/jobs';
import type { KmoeService } from '../services/kmoe';
import { folderKeywords, type FolderRow } from '../services/library';
import type { SettingsStore } from '../services/settings';
import type { TargetService } from '../services/targets';
import { VERSION } from '../config';
import { proxied, proxyUrl } from '../lib/proxy';
import {
  BangumiClient, CACHE_DAYS, connectionProblem, creators, probeOnline, subjectDto, subjectIdOf, type BangumiApi, type BgmSubject,
} from './bangumi';
import { LATEST_URL } from './dump';
import { below, KomgaClient, komgaUrl, plainPath, type KomgaConfig, type KomgaLink, type KomgaSeries } from './komga';
import { findSubject, type MatchInput } from './match';
import { OfflineData, type OfflineState } from './offline';
import { seriesText, syncSeries } from './sync';
import { fold } from './text';

export interface MetadataDeps {
  db: DB; hub: EventHub; sealer: Sealer; settings: SettingsStore; activity: ActivityLog; comics: ComicService; targets: TargetService;
  kmoe: KmoeService; jobs: JobRunner; fetch?: typeof fetch;
  /** DATA_DIR; the offline Bangumi data goes to DATA_DIR/bangumi (default: next to the database file). */
  dataDir?: string;
}

export const DISABLED_METADATA: FolderMetadata = {
  bangumi: { state: 'none', subject: null, candidates: [], source: null, checkedAt: null, ai: null },
  komga: { state: 'disabled', seriesId: null, seriesUrl: null, syncedAt: null, error: null, dirty: false },
  polish: null,
};

const KEY = 'metadata', SECRET = 'metadata.komgaSecret', TOKEN = 'metadata.bangumiToken', ONLINE = 'metadata.bangumiOnline', ARCHIVE = 'metadata.archive';
interface Stored {
  enabled: boolean;
  komga: { url: string; auth: 'apiKey' | 'basic'; username: string; libraries: { targetId: number; libraryId: string }[] };
  bangumi: { source: BangumiSource };
  options: MetadataOptions;
}
const DEFAULTS: Stored = {
  enabled: false,
  komga: { url: '', auth: 'apiKey', username: '', libraries: [] },
  bangumi: { source: 'auto' },
  options: { titleLanguage: 'cn', books: true, posters: 'off', lock: true, autoSync: true, tagLimit: 10 },
};
type OnlineState = MetadataSettings['bangumi']['online'];
/** How long a reachability probe counts: a working API is re-checked hourly, a blocked one every 15 minutes. */
const ONLINE_TTL_MS = 3_600_000, BLOCKED_TTL_MS = 15 * 60_000;
const offlinePending = (error: unknown) => error instanceof AppError && (error.code === 'bangumi_offline_pending' || error.code === 'bangumi_unreachable');
/** Retry a folder Komga does not show yet (or that failed) after 2, 5, 15 and 60 minutes, then wait for the next change. */
const BACKOFF_MINUTES = [2, 5, 15, 60];
const SCAN_INTERVAL_MS = 10 * 60_000;
const TICK_BATCH = 3;
/** A tick starts no further folder after this long (first syncs can be slow under Bangumi's rate limit). */
const TICK_BUDGET_MS = 40_000;

type Source = 'auto' | 'manual' | 'komga' | 'ai';
interface MetaRow {
  folder_id: number; bangumi_id: number | null; bangumi_state: BangumiState; bangumi_subject: string | null; bangumi_candidates: string;
  bangumi_source: Source | null; bangumi_checked_at: string | null; komga_series_id: string | null; komga_state: KomgaState;
  komga_synced_at: string | null; komga_error: string | null; dirty: number; attempts: number; next_attempt_at: string | null; updated_at: string;
  bangumi_ai: string | null; ai_polish: string | null;
}
/** An AI-tidied summary + tags for one Bangumi subject, next to what syncing would write without it. */
interface StoredPolish { subjectId: number; original: MetadataText; polished: MetadataText; status: 'pending' | 'accepted' | 'rejected'; at: string }
const bangumiLine = (c: BangumiCandidate) => [
  c.nameCn && c.nameCn !== c.name ? `${c.nameCn}（${c.name}）` : c.name, c.platform ?? '类型未知', c.date ?? '日期未知',
  `作者：${c.authors.join('、') || '未知'}`, c.volumes ? `共 ${c.volumes} 卷` : '', c.series ? '系列' : '单册',
].filter(Boolean).join('｜');
/** One pass over Komga (a job, a tick or a single sync): libraries and each library's series are listed once. */
interface Run {
  komga: KomgaClient; signal?: AbortSignal;
  roots?: Promise<Map<string, string>>;
  index: Map<string, Promise<Map<string, KomgaSeries>>>;
  scanned: Set<string>;
}

/** The Bangumi subject a Komga series links to: a "cbl" link first, then a "Bangumi" one, then any other bgm.tv subject link. */
export function linkedSubject(links: KomgaLink[]): number | null {
  const ranked = links.flatMap(link => {
    const label = link.label.trim(), id = /(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/\d+/i.test(link.url ?? '') ? subjectIdOf(link.url) : null;
    // "动画：…" / "书籍：…" links (BangumiKomga adaptations) point at other works.
    if (id === null || /[：:]/.test(label)) return [];
    return [{ id, rank: /^cbl$/i.test(label) ? 0 : /^bangumi$/i.test(label) ? 1 : 2 }];
  });
  return ranked.sort((a, b) => a.rank - b.rank)[0]?.id ?? null;
}

export class MetadataService {
  /** fetch for Bangumi, its images and GitHub: through the proxy (设置 → 网络代理) when one is set. */
  private readonly net: typeof fetch;
  private readonly online: BangumiClient;
  private readonly offline: OfflineData;
  private ticking = false;
  /** Last Komga library scan we asked for, per library id. */
  private readonly scans = new Map<string, number>();
  private cacheCleanedAt = 0;
  private probing: Promise<boolean> | null = null;
  /** A job that stopped because no Bangumi source could answer: restarted once the offline data is ready. */
  private resumeJob: (() => void) | null = null;

  /** Bangumi for matching and syncing: the online API or the offline archive, chosen per call (see viaSource). */
  private readonly bangumi: BangumiApi = {
    search: (keyword, signal) => this.viaSource(api => api.search(keyword, signal), signal),
    subject: (id, signal) => this.viaSource(api => api.subject(id, signal), signal),
    persons: (id, signal) => this.viaSource(api => api.persons(id, signal), signal),
    related: (id, signal) => this.viaSource(api => api.related(id, signal), signal),
  };

  constructor(private readonly deps: MetadataDeps) {
    // The proxy used to be a Bangumi setting; it is the app-wide one now (settings.proxy).
    const legacy = this.read<{ bangumi?: { proxy?: string } }>(KEY);
    if (legacy?.bangumi?.proxy !== undefined) {
      if (legacy.bangumi.proxy && !deps.settings.get().proxy) deps.settings.patch({ proxy: legacy.bangumi.proxy });
      delete legacy.bangumi.proxy;
      this.write(KEY, legacy);
    }
    this.net = proxied(deps.fetch ?? fetch, () => deps.settings.get().proxy);
    this.online = new BangumiClient({ db: deps.db, fetch: this.net, token: () => this.secret(TOKEN) });
    const file = deps.db.filename;
    const dataDir = deps.dataDir ?? (file && file !== ':memory:' ? dirname(file) : join(tmpdir(), 'kmoesync'));
    this.offline = new OfflineData(join(dataDir, 'bangumi'), {
      fetch: () => this.net,
      load: () => this.read<Partial<OfflineState>>(ARCHIVE),
      save: state => this.write(ARCHIVE, state),
      status: archive => this.deps.hub.emit({ type: 'bangumi-archive', archive }),
      finished: result => this.archiveFinished(result),
    });
  }

  /** Stops a running offline-data download/import (it resumes later). */
  dispose(): Promise<void> { return this.offline.stop(); }

  // ---------- Settings ----------
  private read<T>(key: string): T | null {
    const row = this.deps.db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? json<T | null>(row.value, null) : null;
  }
  private write(key: string, value: unknown) {
    this.deps.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
  }
  private stored(): Stored {
    const value = this.read<Partial<Stored>>(KEY) ?? {};
    return {
      enabled: value.enabled ?? false, komga: { ...DEFAULTS.komga, ...value.komga }, bangumi: { ...DEFAULTS.bangumi, ...value.bangumi },
      options: { ...DEFAULTS.options, ...value.options },
    };
  }
  private secret(key: string): string | null {
    const sealed = this.read<string>(key);
    return sealed ? this.deps.sealer.open(Buffer.from(sealed, 'base64')) : null;
  }
  private setSecret(key: string, value: string) {
    if (value) this.write(key, Buffer.from(this.deps.sealer.seal(value)).toString('base64'));
    else this.deps.db.run('DELETE FROM settings WHERE key = ?', [key]);
  }

  settings(): MetadataSettings {
    const { enabled, komga, bangumi, options } = this.stored();
    return {
      enabled,
      komga: { url: komga.url, auth: komga.auth, username: komga.username, hasSecret: this.secret(SECRET) !== null, libraries: komga.libraries },
      bangumi: { hasToken: this.secret(TOKEN) !== null, source: bangumi.source, online: this.onlineState(), archive: this.offline.status() },
      options,
    };
  }

  patchSettings(patch: MetadataSettingsPatch): MetadataSettings {
    const current = this.stored();
    const next: Stored = { enabled: patch.enabled ?? current.enabled, komga: { ...current.komga }, bangumi: { ...current.bangumi }, options: { ...current.options } };
    const komga = patch.komga;
    if (komga?.url !== undefined) next.komga.url = komgaUrl(komga.url);
    if (komga?.auth !== undefined) next.komga.auth = komga.auth;
    if (komga?.username !== undefined) next.komga.username = komga.username.trim();
    if (komga?.libraries !== undefined) {
      const byTarget = new Map<number, string>();
      for (const entry of komga.libraries) {
        if (!this.deps.targets.exists(entry.targetId)) throw new AppError(400, 'invalid_settings', `存储位置 ${entry.targetId} 不存在`);
        byTarget.set(entry.targetId, entry.libraryId.trim());
      }
      next.komga.libraries = [...byTarget].map(([targetId, libraryId]) => ({ targetId, libraryId }));
    }
    if (patch.bangumi?.source !== undefined) next.bangumi.source = patch.bangumi.source;
    for (const [key, value] of Object.entries(patch.options ?? {})) if (value !== undefined) Object.assign(next.options, { [key]: value });
    this.write(KEY, next);
    if (next.bangumi.source === 'archive' && current.bangumi.source !== 'archive' && !this.offline.reader.ready) this.offline.autoStart();
    if (komga?.secret !== undefined) this.setSecret(SECRET, komga.secret);
    if (patch.bangumi?.token !== undefined) {
      this.setSecret(TOKEN, patch.bangumi.token.trim());
      // Searches differ with a token (R18 entries): forget the cached ones.
      this.deps.db.run("DELETE FROM bangumi_cache WHERE url LIKE 'https://api.bgm.tv/v0/search/%'");
    }
    // Another server or library: every folder has to be found (and written) again.
    if (next.komga.url !== current.komga.url || JSON.stringify(next.komga.libraries) !== JSON.stringify(current.komga.libraries)) {
      this.deps.db.run("UPDATE folder_metadata SET komga_state = 'pending', komga_series_id = NULL, komga_error = NULL, dirty = 1, attempts = 0, next_attempt_at = NULL");
    }
    for (const target of this.deps.targets.list()) this.deps.hub.emit({ type: 'folders', targetId: target.id });
    return this.settings();
  }

  /** Tests a Komga connection: saved settings merged with unsaved edits (an omitted secret means the saved one). */
  async testKomga(draft: KomgaDraft): Promise<KomgaTestResult> {
    const fail = (message: string): KomgaTestResult => ({ ok: false, message, version: null, libraries: [] });
    const saved = this.stored().komga;
    let url: string;
    try { url = draft.url !== undefined ? komgaUrl(draft.url) : saved.url; } catch (error) { return fail(errorMessage(error)); }
    const auth = draft.auth ?? saved.auth, username = draft.username?.trim() ?? saved.username;
    const secret = draft.secret !== undefined ? draft.secret : this.secret(SECRET) ?? '';
    if (!url) return fail('请填写 Komga 地址');
    if (auth === 'basic' && !username) return fail('请填写 Komga 用户名（邮箱）');
    if (!secret) return fail(auth === 'apiKey' ? '请填写 Komga API Key' : '请填写 Komga 密码');
    const client = new KomgaClient({ url, auth, username, secret }, this.deps.fetch);
    try {
      const libraries = await client.libraries();
      const roles = await client.roles().catch(() => null);
      const version = await client.version().catch(() => null);
      if (roles && !roles.includes('ADMIN')) return { ok: false, message: '已连接 Komga，但这个账号不是管理员：写入元数据需要 ADMIN 权限', version, libraries };
      return { ok: true, message: `已连接 Komga${version ? ` ${version}` : ''}，共 ${libraries.length} 个书库`, version, libraries };
    } catch (error) {
      return fail(errorMessage(error));
    }
  }

  // ---------- Bangumi source: online API, or the offline archive where bgm.tv is blocked ----------
  private onlineState(): OnlineState {
    return { reachable: null, checkedAt: null, error: null, ...this.read<Partial<OnlineState>>(ONLINE) };
  }
  private setOnline(error: string | null) {
    this.write(ONLINE, { reachable: error === null, checkedAt: now(), error } satisfies OnlineState);
  }

  /** Whether api.bgm.tv answers, from a probe cached for an hour (15 minutes while blocked); concurrent callers share one probe. */
  private async onlineUsable(): Promise<boolean> {
    const state = this.onlineState();
    const age = state.checkedAt ? Date.now() - Date.parse(state.checkedAt) : Infinity;
    if (state.reachable === true && age < ONLINE_TTL_MS) return true;
    if (state.reachable === false && age < BLOCKED_TTL_MS) return false;
    this.probing ??= probeOnline(this.net).then(error => { this.setOnline(error); return error === null; }).finally(() => { this.probing = null; });
    return this.probing;
  }

  /** The imported archive; else its download starts (once) and the caller fails with a message saying so. */
  private archiveOrWait(): BangumiApi {
    if (this.offline.reader.ready) return this.offline.reader;
    const downloading = this.offline.autoStart(), status = this.offline.status();
    const lead = this.stored().bangumi.source === 'archive' ? 'Bangumi 离线数据尚未就绪' : 'Bangumi 在当前网络无法直接访问';
    const percent = status.progress?.total ? `，已完成 ${Math.floor(status.progress.done / status.progress.total * 100)}%` : '';
    throw transient(new AppError(503, 'bangumi_offline_pending', downloading
      ? `${lead}，正在${status.state === 'importing' ? '导入' : '下载'}离线数据（Bangumi Archive${percent}），完成后自动继续`
      : `${lead}，离线数据下载失败：${status.error ?? '未知错误'}。请在设置中填写代理，或稍后重新下载离线数据`));
  }

  /**
   * auto: the online API while it answers, else the archive (an online call failing to connect switches over at once);
   * online / archive: only that one.
   */
  private async viaSource<T>(call: (api: BangumiApi) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const { source } = this.stored().bangumi;
    signal?.throwIfAborted();
    if (source === 'online' || (source === 'auto' && await this.onlineUsable())) {
      try { return await call(this.online); } catch (error) {
        if (source === 'online' || !(error instanceof AppError && error.code === 'bangumi_unreachable')) throw error;
        this.setOnline(error.message);
      }
    }
    return call(this.archiveOrWait());
  }

  /** Before a job: fail at once when no source can answer, and restart the job when the offline data arrives. */
  private async requireSource(resume: () => void) {
    const { source } = this.stored().bangumi;
    if (source === 'online' || (source === 'auto' && await this.onlineUsable())) return;
    try { this.archiveOrWait(); } catch (error) {
      this.resumeJob = resume;
      throw error;
    }
  }

  private archiveFinished(result: { ok: true; dump: string; subjects: number } | { ok: false; error: string }) {
    if (!result.ok) {
      this.deps.activity.add({ kind: 'info', level: 'warning', title: 'Bangumi 离线数据更新失败', detail: result.error });
      return;
    }
    this.deps.activity.add({ kind: 'info', level: 'success', title: `Bangumi 离线数据已更新：${result.subjects} 部书籍条目`, detail: result.dump });
    const resume = this.resumeJob;
    this.resumeJob = null;
    if (resume && !this.deps.jobs.busy) {
      try { resume(); } catch (error) { console.warn(`[metadata] resume job: ${errorMessage(error)}`); }
    }
  }

  /** The proxy changed (设置 → 网络代理): whether bgm.tv answers has to be checked again. */
  networkChanged() { this.deps.db.run('DELETE FROM settings WHERE key = ?', [ONLINE]); }

  /** 网络代理 → 测试: whether Bangumi, GitHub (offline data) and, when asked, Kmoe answer through a draft proxy. */
  async testNetwork(proxy: string, kmoeOrigin: string | null): Promise<NetworkCheck[]> {
    const via = proxyUrl(proxy);
    const net = proxied(this.deps.fetch ?? fetch, () => via);
    const reach = async (what: string, url: string) => {
      try {
        const response = await net(url, { redirect: 'manual', headers: { 'User-Agent': `kmoesync/${VERSION}` }, signal: AbortSignal.timeout(8_000) });
        await response.body?.cancel().catch(() => {});
        return response.status < 500 ? null : `${what} 暂时不可用（HTTP ${response.status}）`;
      } catch (error) { return `无法访问 ${what}（${connectionProblem(error)}）`; }
    };
    const checks: [string, Promise<string | null>][] = [['Bangumi', probeOnline(net)], ['GitHub（离线数据）', reach('GitHub', LATEST_URL)]];
    if (kmoeOrigin) checks.push(['Kmoe', reach('Kmoe', kmoeOrigin)]);
    const errors = await Promise.all(checks.map(([, check]) => check));
    if (via === this.deps.settings.get().proxy) this.setOnline(errors[0]!);
    return checks.map(([name], index) => ({ name, ok: errors[index] === null, message: errors[index] ?? (via ? '通过代理可以访问' : '可以直接访问') }));
  }

  /** Checks whether the online API answers, with a draft proxy or the saved one. */
  async testOnline(proxy?: string): Promise<{ reachable: boolean; message: string }> {
    const saved = this.deps.settings.get().proxy;
    let via: string;
    try { via = proxy === undefined ? saved : proxyUrl(proxy); } catch (error) { return { reachable: false, message: errorMessage(error) }; }
    const base = this.deps.fetch ?? fetch;
    const error = await probeOnline(via ? proxied(base, () => via) : base);
    if (via === saved) this.setOnline(error);
    if (error !== null) return { reachable: false, message: error };
    return { reachable: true, message: via ? `通过代理 ${via} 可以访问 Bangumi API` : '可以直接访问 Bangumi API' };
  }

  /** Download (when newer, or always with force) and import the Bangumi Archive dump in the background. */
  updateArchive(force: boolean): BangumiArchiveStatus {
    return this.offline.start(force);
  }

  private komgaConfig(): KomgaConfig | null {
    const { komga } = this.stored();
    const secret = this.secret(SECRET);
    if (!komga.url || !secret || (komga.auth === 'basic' && !komga.username)) return null;
    return { url: komga.url, auth: komga.auth, username: komga.username, secret };
  }
  private newRun(signal?: AbortSignal): Run | null {
    const config = this.komgaConfig();
    return config ? { komga: new KomgaClient(config, this.deps.fetch), signal, index: new Map(), scanned: new Set() } : null;
  }
  private libraryOf(targetId: number, stored = this.stored()): string | null {
    return stored.komga.libraries.find(entry => entry.targetId === targetId)?.libraryId ?? null;
  }
  private requireKomga(targetId: number): Stored {
    const stored = this.stored();
    if (!stored.enabled) throw new AppError(409, 'metadata_disabled', '请先在设置中启用 Komga 元数据');
    if (!this.komgaConfig()) throw new AppError(409, 'komga_not_configured', '请先在设置中填写 Komga 地址和凭据');
    if (!this.libraryOf(targetId, stored)) throw new AppError(409, 'komga_library_unmapped', '这个存储位置还没有对应的 Komga 书库，请先在设置中选择');
    return stored;
  }

  /** The Komga series showing a folder: the library's series are listed once per run and matched by path below its root. */
  private async locate(run: Run, libraryId: string, path: string): Promise<{ root: string; series: KomgaSeries | undefined }> {
    run.roots ??= run.komga.libraries(run.signal).then(list => new Map(list.map(library => [library.id, library.root])))
      .catch(error => { run.roots = undefined; throw error; });
    const root = (await run.roots).get(libraryId);
    if (root === undefined) throw new AppError(404, 'komga_library_missing', `Komga 中找不到对应的书库（${libraryId}），请在设置中重新选择`);
    let index = run.index.get(libraryId);
    if (!index) {
      index = run.komga.seriesIn(libraryId, run.signal)
        .then(list => new Map(list.flatMap(series => { const relative = below(root, series.url); return relative ? [[relative, series] as const] : []; })))
        .catch(error => { run.index.delete(libraryId); throw error; });
      run.index.set(libraryId, index);
    }
    return { root, series: (await index).get(plainPath(path)) };
  }

  // ---------- Folder state ----------
  private folder(folderId: number): FolderRow {
    const row = this.deps.db.query<FolderRow, [number]>('SELECT * FROM library_folders WHERE id = ?').get(folderId);
    if (!row) throw new AppError(404, 'folder_not_found', '找不到该文件夹');
    return row;
  }
  private meta(folderId: number): MetaRow | null {
    return this.deps.db.query<MetaRow, [number]>('SELECT * FROM folder_metadata WHERE folder_id = ?').get(folderId);
  }
  private touched(row: FolderRow) {
    this.deps.hub.emit({ type: 'folders', targetId: row.target_id });
    if (row.comic_id) this.deps.hub.emit({ type: 'comic', key: this.deps.comics.byId(row.comic_id).key });
  }

  /** Metadata state per folder id (defaults for folders without a row). */
  forFolders(ids: number[]): Map<number, FolderMetadata> {
    const result = new Map<number, FolderMetadata>();
    if (!ids.length) return result;
    const stored = this.stored();
    const configured = stored.enabled && this.komgaConfig() !== null;
    type Joined = { id: number; target_id: number } & { [K in keyof MetaRow]: MetaRow[K] | null };
    const rows = this.deps.db.query<Joined, [string]>(`SELECT m.*, f.id, f.target_id FROM library_folders f LEFT JOIN folder_metadata m ON m.folder_id = f.id
      WHERE f.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
    for (const row of rows) {
      const bangumi: FolderMetadata['bangumi'] = {
        state: row.bangumi_state ?? 'none', subject: json<BangumiSubject | null>(row.bangumi_subject, null),
        candidates: json<BangumiCandidate[]>(row.bangumi_candidates, []), source: row.bangumi_source, checkedAt: row.bangumi_checked_at,
        ai: json<AiVerdict | null>(row.bangumi_ai, null),
      };
      const polish = json<StoredPolish | null>(row.ai_polish, null);
      const komga: FolderMetadata['komga'] = configured && this.libraryOf(row.target_id, stored) ? {
        state: row.komga_state ?? 'pending', seriesId: row.komga_series_id, seriesUrl: row.komga_series_id ? `${stored.komga.url}/series/${row.komga_series_id}` : null,
        syncedAt: row.komga_synced_at, error: row.komga_error, dirty: row.dirty === 1,
      } : DISABLED_METADATA.komga;
      result.set(row.id, { bangumi, komga, polish: polish && polish.subjectId === row.bangumi_id ? polish.status : null });
    }
    for (const id of ids) if (!result.has(id)) result.set(id, DISABLED_METADATA);
    return result;
  }

  /** A folder's content or Kmoe link changed (new downloads, import, relink): sync it again when possible. */
  markDirty(folderId: number): void {
    this.deps.db.run(`INSERT INTO folder_metadata (folder_id, dirty, updated_at) VALUES (?, 1, ?)
      ON CONFLICT (folder_id) DO UPDATE SET dirty = 1, attempts = 0, next_attempt_at = NULL, updated_at = excluded.updated_at`, [folderId, now()]);
  }

  // ---------- Matching ----------
  private matchInput(row: FolderRow): MatchInput {
    const comic = row.comic_id ? this.deps.comics.byId(row.comic_id) : null;
    const keywords: string[] = [];
    for (const word of [comic?.title ?? '', ...folderKeywords(row.name, row.hint)].map(value => value.trim())) {
      if (word && !keywords.some(other => fold(other) === fold(word))) keywords.push(word);
    }
    const volumes = comic ? this.deps.comics.items(comic.id).filter(item => item.type === 'volume').length : null;
    return { keywords, authors: comic ? json<string[]>(comic.authors, []) : [], localVolumes: comic ? volumes || null : row.books || null };
  }

  private saveMatch(folderId: number, state: BangumiState, subject: BgmSubject | null, candidates: BangumiCandidate[] | null, source: Source | null) {
    this.deps.db.run('INSERT OR IGNORE INTO folder_metadata (folder_id, updated_at) VALUES (?, ?)', [folderId, now()]);
    const previous = this.meta(folderId)!;
    const changed = state === 'matched' && subject !== null && (previous.bangumi_state !== 'matched' || previous.bangumi_id !== subject.id);
    // bangumi_id keeps the last matched subject after an unmatch: its Komga link is ours (or rejected) and is not reused.
    this.deps.db.query(`UPDATE folder_metadata SET bangumi_state = $state, bangumi_id = COALESCE($id, bangumi_id), bangumi_subject = $subject,
      bangumi_candidates = COALESCE($candidates, bangumi_candidates), bangumi_source = $source, bangumi_checked_at = $now, updated_at = $now,
      dirty = CASE WHEN $changed THEN 1 ELSE dirty END, attempts = CASE WHEN $changed THEN 0 ELSE attempts END,
      next_attempt_at = CASE WHEN $changed THEN NULL ELSE next_attempt_at END WHERE folder_id = $folder`).run({
      state, id: subject?.id ?? null, subject: state === 'matched' && subject ? JSON.stringify(subjectDto(subject)) : null,
      candidates: candidates ? JSON.stringify(candidates) : null, source: state === 'matched' ? source : null, now: now(), changed: changed ? 1 : 0, folder: folderId,
    });
  }

  /** Komga link first (a certain match, unless it is the one we wrote or the user rejected), then a Bangumi search. */
  private async autoMatch(row: FolderRow, run: Run | null, signal?: AbortSignal): Promise<BangumiState> {
    const previous = this.meta(row.id);
    const ignored = previous?.bangumi_source === 'komga' ? null : previous?.bangumi_id ?? null;
    const libraryId = this.libraryOf(row.target_id);
    let linked: number | null = null;
    if (run && libraryId) {
      try { linked = linkedSubject((await this.locate(run, libraryId, row.path)).series?.metadata.links ?? []); } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    if (linked !== null && linked !== ignored) {
      const subject = await this.bangumi.subject(linked, signal);
      if (subject && (subject.type ?? 1) === 1) {
        this.saveMatch(row.id, 'matched', subject, [], 'komga');
        return 'matched';
      }
    }
    const outcome = await findSubject(this.bangumi, this.matchInput(row), signal);
    this.saveMatch(row.id, outcome.state, outcome.subject, outcome.candidates, 'auto');
    return outcome.state;
  }

  private async bangumiCall<T>(work: Promise<T>): Promise<T> {
    try { return await work; } catch (error) { throw error instanceof AppError ? error : new AppError(502, 'bangumi_failed', errorMessage(error)); }
  }

  async matchFolder(folderId: number, input: { subject?: string; auto?: boolean }): Promise<void> {
    const row = this.folder(folderId);
    if (input.subject?.trim()) {
      const id = subjectIdOf(input.subject);
      if (!id) throw new AppError(400, 'invalid_subject', '无法识别 Bangumi 条目：请输入条目 ID 或 bgm.tv / bangumi.tv 链接');
      const subject = await this.bangumiCall(this.bangumi.subject(id));
      if (!subject) throw new AppError(404, 'subject_not_found', `Bangumi 上找不到条目 ${id}（R18 条目需要在设置中填写 Access Token）`);
      this.saveMatch(row.id, 'matched', subject, null, 'manual');
    } else if (input.auto) {
      await this.bangumiCall(this.autoMatch(row, this.newRun()));
    } else {
      throw new AppError(400, 'invalid_request', '请选择 Bangumi 条目，或使用自动匹配');
    }
    this.touched(row);
  }

  unmatchFolder(folderId: number): void {
    const row = this.folder(folderId);
    const time = now();
    this.deps.db.run('INSERT OR IGNORE INTO folder_metadata (folder_id, updated_at) VALUES (?, ?)', [row.id, time]);
    // checked_at stays set, so the scheduler does not quietly match it again; the match job or "auto" does.
    this.deps.db.run(`UPDATE folder_metadata SET bangumi_state = 'none', bangumi_subject = NULL, bangumi_candidates = '[]', bangumi_source = NULL,
      bangumi_ai = NULL, bangumi_checked_at = ?, updated_at = ? WHERE folder_id = ?`, [time, time, row.id]);
    this.touched(row);
  }

  async searchBangumi(query: string): Promise<BangumiSubject[]> {
    return (await this.bangumiCall(this.bangumi.search(query))).map(hit => subjectDto(hit));
  }

  // ---------- Writing to Komga ----------
  /** Kmoe items by file path (relative to the target, NFC): delivery records and library-check results of the linked comic. */
  private kmoeFiles(row: FolderRow): Map<string, ItemRow> {
    const files = new Map<string, ItemRow>();
    if (!row.comic_id) return files;
    const { db } = this.deps;
    const items = new Map(this.deps.comics.items(row.comic_id).map(item => [item.remote_id, item]));
    for (const { result } of db.query<{ result: string }, [number, number]>('SELECT result FROM library_checks WHERE comic_id = ? AND target_id = ?').all(row.comic_id, row.target_id)) {
      for (const chapter of json<LibraryCheck | null>(result, null)?.chapters ?? []) {
        const item = items.get(chapter.id);
        if (item && chapter.status === 'downloaded') for (const path of chapter.paths) files.set(plainPath(path), item);
      }
    }
    for (const delivery of db.query<ItemRow & { path: string }, [number, number]>(
      'SELECT i.*, d.path FROM deliveries d JOIN items i ON i.id = d.item_id WHERE d.target_id = ? AND i.comic_id = ?').all(row.target_id, row.comic_id)) {
      files.set(plainPath(delivery.path), delivery);
    }
    return files;
  }

  /** Files this service delivered into the folder during the last day (relative to the target, NFC). */
  private recentFiles(row: FolderRow): string[] {
    if (!row.comic_id) return [];
    const inside = `${plainPath(row.path)}/`;
    return this.deps.db.query<{ path: string }, [number, number, string]>(`SELECT d.path FROM deliveries d JOIN items i ON i.id = d.item_id
      WHERE d.target_id = ? AND i.comic_id = ? AND d.delivered_at > ?`).all(row.target_id, row.comic_id, new Date(Date.now() - 86_400_000).toISOString())
      .map(delivery => plainPath(delivery.path)).filter(path => path.startsWith(inside));
  }

  /** New files show in Komga after its next scan: ask for one (recently changed folders, at most once per library every 10 minutes). */
  private async requestScan(run: Run, libraryId: string, row: FolderRow) {
    if (Date.now() - Date.parse(row.updated_at) >= 86_400_000 || run.scanned.has(libraryId) || Date.now() - (this.scans.get(libraryId) ?? 0) < SCAN_INTERVAL_MS) return;
    run.scanned.add(libraryId);
    this.scans.set(libraryId, Date.now());
    await run.komga.scan(libraryId, run.signal).catch(error => console.warn(`[metadata] Komga scan ${libraryId}: ${errorMessage(error)}`));
  }

  private retryLater(folderId: number, attempts: number, state: 'not_found' | 'error', error: string) {
    const attempt = attempts + 1, delay = BACKOFF_MINUTES[attempt - 1];
    this.deps.db.query(`UPDATE folder_metadata SET komga_state = $state, komga_error = $error, attempts = $attempt, next_attempt_at = $next, dirty = $dirty,
      komga_series_id = CASE WHEN $state = 'not_found' THEN NULL ELSE komga_series_id END, updated_at = $now WHERE folder_id = $folder`).run({
      state, error, attempt, next: delay ? new Date(Date.now() + delay * 60_000).toISOString() : null, dirty: delay ? 1 : 0, now: now(), folder: folderId,
    });
  }

  private async syncOne(row: FolderRow, run: Run, stored = this.stored()): Promise<'synced' | 'not_found' | 'error' | 'skipped'> {
    const meta = this.meta(row.id);
    const libraryId = this.libraryOf(row.target_id, stored);
    if (!meta || meta.bangumi_state !== 'matched' || meta.bangumi_id === null || !libraryId) return 'skipped';
    const started = now();
    try {
      const { root, series } = await this.locate(run, libraryId, row.path);
      if (!series) {
        await this.requestScan(run, libraryId, row);
        this.retryLater(row.id, meta.attempts, 'not_found', 'Komga 书库里还没有这个文件夹：已请求 Komga 扫描，稍后自动重试');
        return 'not_found';
      }
      const comic = row.comic_id ? this.deps.comics.byId(row.comic_id) : null;
      const polish = json<StoredPolish | null>(meta.ai_polish, null);
      const { subject, volumes, books } = await syncSeries({
        seriesId: series.id, subjectId: meta.bangumi_id, root, files: this.kmoeFiles(row), fileTitle: row.hint ?? comic?.title ?? null,
        polish: polish?.status === 'accepted' && polish.subjectId === meta.bangumi_id ? polish.polished : null,
        comic: comic ? { title: comic.title, status: comic.status, language: comic.language, volumes: this.deps.comics.items(comic.id).filter(item => item.type === 'volume').length } : null,
        kmoeUrl: comic ? `${this.deps.kmoe.origin()}/c/${comic.key}.htm` : null,
      }, { komga: run.komga, bangumi: this.bangumi, fetch: this.net, options: stored.options, signal: run.signal });
      // A volume downloaded minutes ago is usually not in Komga yet: ask for a scan and come back (after 2, 5, 15, 60 minutes)
      // to write its book. Changes that arrived while this ran (markDirty) also keep the folder dirty.
      const delay = books && this.recentFiles(row).some(path => !books.has(path)) ? BACKOFF_MINUTES[meta.attempts] : undefined;
      if (delay) await this.requestScan(run, libraryId, row);
      this.deps.db.query(`UPDATE folder_metadata SET komga_state = 'synced', komga_series_id = $series, komga_synced_at = $now, komga_error = NULL,
        attempts = $attempts, next_attempt_at = $next, dirty = CASE WHEN $waiting OR updated_at > $started THEN 1 ELSE 0 END,
        bangumi_subject = CASE WHEN bangumi_id = $id AND bangumi_state = 'matched' THEN $subject ELSE bangumi_subject END, updated_at = $now WHERE folder_id = $folder`)
        .run({ series: series.id, now: now(), started, id: subject.id, subject: JSON.stringify(subjectDto(subject, volumes)), folder: row.id,
          attempts: delay ? meta.attempts + 1 : 0, next: delay ? new Date(Date.now() + delay * 60_000).toISOString() : null, waiting: delay ? 1 : 0 });
      return 'synced';
    } catch (error) {
      // No Bangumi source at all is not this folder's fault: the caller stops (and the folder stays dirty).
      if (run.signal?.aborted || offlinePending(error)) throw error;
      this.retryLater(row.id, meta.attempts, 'error', errorMessage(error));
      return 'error';
    }
  }

  async syncFolder(folderId: number): Promise<void> {
    const row = this.folder(folderId);
    const stored = this.requireKomga(row.target_id);
    if (this.meta(row.id)?.bangumi_state !== 'matched') throw new AppError(409, 'bangumi_unmatched', '请先为这个文件夹匹配 Bangumi 条目');
    await this.syncOne(row, this.newRun()!, stored);
    this.touched(row);
  }

  // ---------- Jobs ----------
  startMatchJob(targetId: number, retry: boolean): LibraryJob {
    this.deps.targets.get(targetId);
    // retry: also suggested/unmatched folders and automatic matches (Komga-linked ones find their link again); manual choices stay.
    const rows = this.deps.db.query<FolderRow, [number]>(`SELECT f.* FROM library_folders f LEFT JOIN folder_metadata m ON m.folder_id = f.id
      WHERE f.target_id = ? AND (m.folder_id IS NULL OR m.bangumi_state = 'none'${retry ? " OR m.bangumi_state IN ('suggested', 'unmatched') OR (m.bangumi_state = 'matched' AND m.bangumi_source IS NOT 'manual')" : ''})
      ORDER BY f.path COLLATE NOCASE`).all(targetId);
    const again = () => { this.startMatchJob(targetId, retry); };
    return this.deps.jobs.start('bangumi', targetId, async context => {
      await this.requireSource(again);
      const run = this.newRun(context.signal);
      const counts: Record<BangumiState | 'failed', number> = { none: 0, matched: 0, suggested: 0, unmatched: 0, failed: 0 };
      let firstError: string | null = null;
      context.progress({ total: rows.length, done: 0 });
      for (const [index, row] of rows.entries()) {
        context.signal.throwIfAborted();
        context.progress({ done: index, current: row.path });
        try { counts[await this.autoMatch(row, run, context.signal)]++; } catch (error) {
          if (context.signal.aborted) throw error;
          if (offlinePending(error)) { this.resumeJob = again; throw error; }
          counts.failed++;
          firstError ??= `${row.name}：${errorMessage(error)}`;
        }
        this.touched(row);
      }
      context.progress({ done: rows.length, current: null });
      this.deps.activity.add({
        kind: 'info', level: counts.failed ? 'warning' : 'success', detail: firstError,
        title: `Bangumi 匹配：自动匹配 ${counts.matched} 部，待确认 ${counts.suggested} 部，未找到 ${counts.unmatched} 部${counts.failed ? `，失败 ${counts.failed} 部` : ''}`,
      });
    });
  }

  startSyncJob(targetId: number, all: boolean): LibraryJob {
    this.deps.targets.get(targetId);
    const stored = this.requireKomga(targetId);
    const rows = this.deps.db.query<FolderRow, [number]>(`SELECT f.* FROM library_folders f JOIN folder_metadata m ON m.folder_id = f.id
      WHERE f.target_id = ? AND m.bangumi_state = 'matched'${all ? '' : ' AND m.dirty = 1'} ORDER BY f.path COLLATE NOCASE`).all(targetId);
    const again = () => { this.startSyncJob(targetId, all); };
    return this.deps.jobs.start('komga', targetId, async context => {
      await this.requireSource(again);
      const run = this.newRun(context.signal)!;
      const counts = { synced: 0, not_found: 0, error: 0, skipped: 0 };
      let firstError: string | null = null;
      context.progress({ total: rows.length, done: 0 });
      for (const [index, row] of rows.entries()) {
        context.signal.throwIfAborted();
        context.progress({ done: index, current: row.path });
        const result = await this.syncOne(row, run, stored).catch(error => {
          if (offlinePending(error)) this.resumeJob = again;
          throw error;
        });
        counts[result]++;
        if (result === 'error') firstError ??= `${row.name}：${this.meta(row.id)?.komga_error ?? ''}`;
        this.touched(row);
      }
      context.progress({ done: rows.length, current: null });
      this.deps.activity.add({
        kind: 'info', level: counts.error || counts.not_found ? 'warning' : 'success', detail: firstError,
        title: `Komga 元数据：同步 ${counts.synced} 部${counts.not_found ? `，Komga 中未找到 ${counts.not_found} 部` : ''}${counts.error ? `，失败 ${counts.error} 部` : ''}`,
      });
    });
  }

  // ---------- AI ----------
  /** What the AI is told when choosing a folder's Bangumi subject: the folder and the Kmoe comic linked to it. */
  private aiFacts(row: FolderRow): FolderFacts {
    const comic = row.comic_id ? this.deps.comics.byId(row.comic_id) : null;
    return {
      path: row.path, name: row.name, hint: row.hint, books: row.books, files: row.sample ? [row.sample] : [], fileTitle: null, fileAuthor: null,
      comic: comic ? {
        title: comic.title, authors: json<string[]>(comic.authors, []), status: comic.status, description: comic.description,
        volumes: this.deps.comics.items(comic.id).filter(item => item.type === 'volume').length,
      } : null,
    };
  }

  /**
   * AI pass over folders whose Bangumi subject awaits confirmation or was not found: without candidates it searches with the
   * AI's other spellings, then lets it pick. A confident pick is matched; otherwise it goes first among the candidates.
   */
  startAiMatch(targetId: number, ai: AiService): LibraryJob {
    this.deps.targets.get(targetId);
    ai.client();
    const rows = this.deps.db.query<FolderRow, [number]>(`SELECT f.* FROM library_folders f JOIN folder_metadata m ON m.folder_id = f.id
      WHERE f.target_id = ? AND m.bangumi_state IN ('suggested', 'unmatched') ORDER BY f.path COLLATE NOCASE`).all(targetId);
    const again = () => { this.startAiMatch(targetId, ai); };
    return this.deps.jobs.start('ai', targetId, async context => {
      await this.requireSource(again);
      const counts = { matched: 0, left: 0, failed: 0 };
      context.progress({ total: rows.length, done: 0 });
      for (const [index, row] of rows.entries()) {
        context.signal.throwIfAborted();
        context.progress({ done: index, current: row.path });
        try {
          const facts = this.aiFacts(row);
          let candidates = json<BangumiCandidate[]>(this.meta(row.id)?.bangumi_candidates, []);
          if (!candidates.length) {
            const found = new Map<number, BangumiCandidate>();
            for (const word of await ai.keywords('bangumi', facts, context.signal)) {
              for (const hit of await this.bangumi.search(word, context.signal)) if ((hit.type ?? 1) === 1 && !found.has(hit.id)) found.set(hit.id, { ...subjectDto(hit), score: 0 });
            }
            candidates = [...found.values()].slice(0, 8);
          }
          const verdict: AiVerdict = candidates.length
            ? await ai.judge('bangumi', facts, candidates.map(c => ({ id: String(c.id), line: bangumiLine(c) })), context.signal)
            : { pick: null, confidence: 0, reason: '换了几种写法搜索，Bangumi 上都没有找到', at: now() };
          const pick = candidates.find(c => String(c.id) === verdict.pick);
          const ordered = pick ? [pick, ...candidates.filter(c => c !== pick)] : candidates;
          const subject = pick && verdict.confidence >= AI_CONFIDENT ? await this.bangumi.subject(pick.id, context.signal) : null;
          if (subject) this.saveMatch(row.id, 'matched', subject, ordered, 'ai');
          else this.saveMatch(row.id, ordered.length ? 'suggested' : 'unmatched', null, ordered, null);
          this.deps.db.run('UPDATE folder_metadata SET bangumi_ai = ? WHERE folder_id = ?', [JSON.stringify(verdict), row.id]);
          counts[subject ? 'matched' : 'left']++;
        } catch (error) {
          if (context.signal.aborted) throw error;
          if (offlinePending(error)) { this.resumeJob = again; throw error; }
          if (error instanceof AppError && error.code.startsWith('ai_')) throw error;
          counts.failed++;
          console.warn(`[ai] ${row.path}: ${errorMessage(error)}`);
        }
        this.touched(row);
      }
      context.progress({ done: rows.length, current: null });
      this.deps.activity.add({
        kind: 'info', level: counts.failed ? 'warning' : 'success',
        title: `AI 判定 Bangumi：匹配 ${counts.matched} 部，仍需确认 ${counts.left} 部${counts.failed ? `，失败 ${counts.failed} 部` : ''}`,
      });
    });
  }

  /** AI versions of the summary and tags of matched folders (new ones, or all again), kept for review: nothing is written yet. */
  startAiPolish(targetId: number, all: boolean, ai: AiService): LibraryJob {
    this.deps.targets.get(targetId);
    ai.client();
    const rows = this.deps.db.query<FolderRow & { bangumi_id: number; ai_polish: string | null }, [number]>(`SELECT f.*, m.bangumi_id, m.ai_polish FROM library_folders f
      JOIN folder_metadata m ON m.folder_id = f.id WHERE f.target_id = ? AND m.bangumi_state = 'matched' AND m.bangumi_id IS NOT NULL ORDER BY f.path COLLATE NOCASE`)
      .all(targetId).filter(row => all || json<StoredPolish | null>(row.ai_polish, null)?.subjectId !== row.bangumi_id);
    const again = () => { this.startAiPolish(targetId, all, ai); };
    return this.deps.jobs.start('ai', targetId, async context => {
      await this.requireSource(again);
      const { tagLimit } = this.stored().options;
      const counts = { done: 0, failed: 0 };
      context.progress({ total: rows.length, done: 0 });
      for (const [index, row] of rows.entries()) {
        context.signal.throwIfAborted();
        context.progress({ done: index, current: row.path });
        try {
          const subject = await this.bangumi.subject(row.bangumi_id, context.signal);
          if (!subject) throw new Error(`Bangumi 条目 ${row.bangumi_id} 读不到`);
          const persons = await this.bangumi.persons(subject.id, context.signal);
          const original = seriesText(subject, persons, tagLimit);
          const comic = row.comic_id ? this.deps.comics.byId(row.comic_id) : null;
          const polished = await ai.polish({
            title: subject.name_cn || subject.name, original, description: comic?.description ?? null, tagLimit,
            tags: [...subject.tags ?? []].sort((a, b) => b.count - a.count).slice(0, 30).map(tag => tag.name),
            authors: [...new Set([...creators(subject), ...persons.filter(person => person.type === 1).map(person => person.name)])],
          }, context.signal);
          const stored: StoredPolish = { subjectId: subject.id, original, polished, status: 'pending', at: now() };
          this.deps.db.run('UPDATE folder_metadata SET ai_polish = ? WHERE folder_id = ?', [JSON.stringify(stored), row.id]);
          counts.done++;
        } catch (error) {
          if (context.signal.aborted) throw error;
          if (offlinePending(error)) { this.resumeJob = again; throw error; }
          if (error instanceof AppError && error.code.startsWith('ai_')) throw error;
          counts.failed++;
          console.warn(`[ai] ${row.path}: ${errorMessage(error)}`);
        }
        this.touched(row);
      }
      context.progress({ done: rows.length, current: null });
      this.deps.activity.add({
        kind: 'info', level: counts.failed ? 'warning' : 'success', detail: counts.done ? '在书库里查看，确认后才会写入 Komga' : null,
        title: `AI 整理了 ${counts.done} 部的简介和标签${counts.failed ? `，失败 ${counts.failed} 部` : ''}`,
      });
    });
  }

  /** The AI versions of a target's folders, for review. */
  polishList(targetId: number): AiPolishItem[] {
    this.deps.targets.get(targetId);
    return this.deps.db.query<{ id: number; name: string; path: string; ai_polish: string; bangumi_id: number | null; bangumi_subject: string | null }, [number]>(
      `SELECT f.id, f.name, f.path, m.ai_polish, m.bangumi_id, m.bangumi_subject FROM library_folders f JOIN folder_metadata m ON m.folder_id = f.id
       WHERE f.target_id = ? AND m.ai_polish IS NOT NULL ORDER BY f.path COLLATE NOCASE`).all(targetId).flatMap(row => {
      const stored = json<StoredPolish | null>(row.ai_polish, null);
      if (!stored || stored.subjectId !== row.bangumi_id) return [];
      const subject = json<BangumiSubject | null>(row.bangumi_subject, null);
      return [{ folderId: row.id, path: row.path, title: subject?.nameCn || subject?.name || row.name, original: stored.original, polished: stored.polished, status: stored.status, at: stored.at }];
    });
  }

  /** Use (or drop) the AI version: Komga is written again whenever what it should show changes. */
  decidePolish(folderIds: number[], accept: boolean): { updated: number } {
    const status = accept ? 'accepted' : 'rejected';
    const targets = new Set<number>();
    let updated = 0;
    for (const id of new Set(folderIds)) {
      const row = this.deps.db.query<{ ai_polish: string | null; target_id: number }, [number]>(
        'SELECT m.ai_polish, f.target_id FROM folder_metadata m JOIN library_folders f ON f.id = m.folder_id WHERE m.folder_id = ?').get(id);
      const stored = json<StoredPolish | null>(row?.ai_polish, null);
      if (!row || !stored || stored.status === status) continue;
      this.deps.db.run('UPDATE folder_metadata SET ai_polish = ? WHERE folder_id = ?', [JSON.stringify({ ...stored, status }), id]);
      if (accept || stored.status === 'accepted') this.markDirty(id);
      targets.add(row.target_id);
      updated++;
    }
    for (const targetId of targets) this.deps.hub.emit({ type: 'folders', targetId });
    return { updated };
  }

  /** Scheduler hook (every minute): auto-match new folders and sync dirty ones when enabled and idle. */
  async tick(): Promise<void> {
    const stored = this.stored();
    if (!stored.enabled) return;
    // Offline data: fetched when it is the only way to reach Bangumi, then kept current (a newer weekly dump, checked daily).
    const { source } = stored.bangumi;
    this.offline.maintain(source === 'archive' || (source === 'auto' && !await this.onlineUsable()));
    if (this.ticking || !stored.options.autoSync || this.deps.jobs.busy) return;
    this.ticking = true;
    const deadline = Date.now() + TICK_BUDGET_MS;
    const idle = () => !this.deps.jobs.busy && Date.now() < deadline;
    try {
      if (Date.now() - this.cacheCleanedAt > 6 * 3_600_000) {
        this.cacheCleanedAt = Date.now();
        this.deps.db.run('DELETE FROM bangumi_cache WHERE fetched_at < ?', [new Date(Date.now() - (CACHE_DAYS + 1) * 86_400_000).toISOString()]);
      }
      const run = this.newRun();
      const fresh = this.deps.db.query<FolderRow, [number]>(`SELECT f.* FROM library_folders f LEFT JOIN folder_metadata m ON m.folder_id = f.id
        WHERE m.folder_id IS NULL OR (m.bangumi_state = 'none' AND m.bangumi_checked_at IS NULL) ORDER BY f.id LIMIT ?`).all(TICK_BATCH);
      for (const row of fresh) {
        if (!idle()) return;
        try { await this.autoMatch(row, run); } catch (error) {
          console.warn(`[metadata] match ${row.path}: ${errorMessage(error)}`);
          if (isRetryable(error)) break; // Bangumi unreachable: the same folders go first next minute.
          // Anything else would fail again: leave the folder to the match job instead of blocking the queue.
          this.deps.db.run(`INSERT INTO folder_metadata (folder_id, bangumi_checked_at, updated_at) VALUES (?1, ?2, ?2)
            ON CONFLICT (folder_id) DO UPDATE SET bangumi_checked_at = ?2, updated_at = ?2`, [row.id, now()]);
        }
        this.touched(row);
      }
      if (!run) return;
      const due = this.deps.db.query<FolderRow, [string, string, number]>(`SELECT f.* FROM library_folders f JOIN folder_metadata m ON m.folder_id = f.id
        WHERE m.bangumi_state = 'matched' AND m.dirty = 1 AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= ?)
          AND f.target_id IN (SELECT value FROM json_each(?)) ORDER BY m.updated_at LIMIT ?`)
        .all(now(), JSON.stringify(stored.komga.libraries.map(entry => entry.targetId)), TICK_BATCH);
      for (const row of due) {
        if (!idle()) return;
        try { await this.syncOne(row, run, stored); } catch (error) {
          if (offlinePending(error)) return; // no Bangumi source yet: the folders stay dirty
          throw error;
        }
        this.touched(row);
      }
    } catch (error) {
      console.error('[metadata] tick', error);
    } finally {
      this.ticking = false;
    }
  }
}

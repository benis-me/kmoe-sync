// Bangumi API v0 client (https://bangumi.github.io/api/): one process-wide rate limit, retries, and responses cached in
// bangumi_cache (subjects/persons/relations 7 days, searches 1 day). Plus helpers to read Bangumi subjects and the
// reachability probe. The offline archive (archive.ts) answers the same BangumiApi.
import type { BangumiSubject } from '@shared/model';
import { VERSION } from '../config';
import { now, type DB } from '../db';
import { AppError } from '../http/errors';
import { connectionProblem, isRetryable, transient, transientStatus } from '../lib/retry';

export interface BgmInfobox { key: string; value: string | { k?: string; v?: string }[] }
export interface BgmSubject {
  id: number; type?: number; name: string; name_cn?: string; summary?: string; series?: boolean; platform?: string | null; date?: string | null;
  images?: Partial<Record<'large' | 'common' | 'medium' | 'small' | 'grid', string>> | null; infobox?: BgmInfobox[] | null; volumes?: number;
  tags?: { name: string; count: number }[]; meta_tags?: string[]; nsfw?: boolean;
  /** Offline archive only: Chinese names (简体中文名) of the credited creators, extra evidence for author matching. */
  credits_cn?: string[];
}
export interface BgmPerson { id: number; name: string; relation: string; type?: number }
export interface BgmRelated { id: number; type?: number; name: string; name_cn?: string; relation: string }

/** What matching and syncing need from Bangumi: the online API (BangumiClient) or the offline archive (ArchiveReader). */
export interface BangumiApi {
  search(keyword: string, signal?: AbortSignal): Promise<BgmSubject[]>;
  /** null when the subject does not exist (or is R18 and no access token is set). */
  subject(id: number, signal?: AbortSignal): Promise<BgmSubject | null>;
  persons(id: number, signal?: AbortSignal): Promise<BgmPerson[]>;
  related(id: number, signal?: AbortSignal): Promise<BgmRelated[]>;
}

const BASE = 'https://api.bgm.tv';
const USER_AGENT = `kmoesync/${VERSION} (self-hosted; https://github.com/)`;
const DAY = 86_400_000;
export const CACHE_DAYS = 7;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Sliding window: at most `max` request starts per `windowMs`. Callers queue in order; nothing is ever dropped. */
export class SlidingWindow {
  private starts: number[] = [];
  private queue: Promise<void> = Promise.resolve();
  constructor(public max: number, public windowMs: number) {}

  take(signal?: AbortSignal): Promise<void> {
    const turn = this.queue.then(async () => {
      for (;;) {
        signal?.throwIfAborted();
        const time = Date.now();
        while (this.starts.length && time - this.starts[0]! >= this.windowMs) this.starts.shift();
        if (this.starts.length < this.max) { this.starts.push(time); return; }
        await sleep(this.starts[0]! + this.windowMs - time, signal);
      }
    });
    this.queue = turn.catch(() => {});
    return turn;
  }
}

/** The single limiter every Bangumi client shares (Bangumi asks API users to stay well below their limits). */
export const bangumiLimiter = new SlidingWindow(60, 60_000);

export interface BangumiOptions { db: DB; fetch?: typeof fetch; token?: () => string | null }

export class BangumiClient implements BangumiApi {
  /** Pauses before the 2nd and 3rd attempt of a request that failed transiently (tests shorten them). */
  static retryDelays = [2_000, 5_000];

  constructor(private readonly options: BangumiOptions) {}

  async search(keyword: string, signal?: AbortSignal): Promise<BgmSubject[]> {
    const body = await this.request<{ data?: BgmSubject[] }>('POST', '/v0/search/subjects?limit=10', { keyword, filter: { type: [1] } }, DAY, signal);
    return body?.data ?? [];
  }
  subject(id: number, signal?: AbortSignal): Promise<BgmSubject | null> {
    return this.request<BgmSubject>('GET', `/v0/subjects/${id}`, undefined, CACHE_DAYS * DAY, signal);
  }
  async persons(id: number, signal?: AbortSignal): Promise<BgmPerson[]> {
    return await this.request<BgmPerson[]>('GET', `/v0/subjects/${id}/persons`, undefined, CACHE_DAYS * DAY, signal) ?? [];
  }
  async related(id: number, signal?: AbortSignal): Promise<BgmRelated[]> {
    return await this.request<BgmRelated[]>('GET', `/v0/subjects/${id}/subjects`, undefined, CACHE_DAYS * DAY, signal) ?? [];
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body: unknown, ttl: number, signal?: AbortSignal): Promise<T | null> {
    const { db } = this.options;
    const key = body === undefined ? `${BASE}${path}` : `${BASE}${path} ${JSON.stringify(body)}`;
    const cached = db.query<{ body: string; fetched_at: string }, [string]>('SELECT body, fetched_at FROM bangumi_cache WHERE url = ?').get(key);
    if (cached && Date.now() - Date.parse(cached.fetched_at) < ttl) return JSON.parse(cached.body) as T;
    const token = this.options.token?.();
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const delays = BangumiClient.retryDelays;
    for (let attempt = 0; ; attempt++) {
      await bangumiLimiter.take(signal);
      const timeout = AbortSignal.timeout(20_000);
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(`${BASE}${path}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (attempt < delays.length && isRetryable(error)) { await sleep(delays[attempt]!, signal); continue; }
        throw unreachable(error);
      }
      if (response.status === 404) return null;
      if (response.ok) {
        const text = await response.text();
        db.run('INSERT INTO bangumi_cache (url, body, fetched_at) VALUES (?, ?, ?) ON CONFLICT (url) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at', [key, text, now()]);
        return JSON.parse(text) as T;
      }
      if (attempt < delays.length && transientStatus(response.status)) {
        const wait = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait * 1000, 30_000) : delays[attempt]!, signal);
        continue;
      }
      const message = response.status === 401 ? 'Bangumi Access Token 无效，请在设置中更新或清除' : `Bangumi 返回 HTTP ${response.status}`;
      throw transient(new AppError(502, 'bangumi_failed', message), transientStatus(response.status));
    }
  }
}

// ---------- Network ----------
/** A failed connection to Bangumi: transient, never the raw "Unable to connect…". */
export function unreachable(error: unknown): AppError {
  return transient(new AppError(502, 'bangumi_unreachable',
    `无法访问 Bangumi（${connectionProblem(error)}）：当前网络可能屏蔽了 bgm.tv。可以在设置中填写代理，或改用离线数据（Bangumi Archive）`));
}

/** Whether the online API answers (any HTTP status below 500); null when it does, else the reason. */
export async function probeOnline(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string | null> {
  const timeout = AbortSignal.timeout(6_000);
  try {
    const response = await fetchImpl(`${BASE}/v0/subjects/1`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    await response.body?.cancel().catch(() => {});
    return response.status < 500 ? null : `Bangumi 暂时不可用（HTTP ${response.status}）`;
  } catch (error) {
    if (signal?.aborted) throw error;
    return unreachable(error).message;
  }
}

// ---------- Reading subjects ----------
export const subjectUrl = (id: number) => `https://bgm.tv/subject/${id}`;

/** A subject id from "118165" or a bgm.tv / bangumi.tv / chii.in subject link. */
export function subjectIdOf(input: string): number | null {
  const text = input.trim();
  const raw = /^\d+$/.test(text) ? text : /(?:^|[/.])(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/(\d+)/i.exec(text)?.[1];
  const id = Number(raw);
  return raw && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Values of an infobox field: the plain string, or each `v` of a list. */
export function infobox(subject: BgmSubject, key: string): string[] {
  const values: string[] = [];
  for (const entry of subject.infobox ?? []) {
    if (entry.key !== key) continue;
    if (typeof entry.value === 'string') values.push(entry.value);
    else for (const item of entry.value) if (item.v) values.push(item.v);
  }
  return values.map(value => value.trim()).filter(Boolean);
}

/** Other editions ("版本:东立版" → { 版本名, 出版社, 发售日, ISBN, 语言 … }). */
export function editions(subject: BgmSubject): { key: string; fields: Record<string, string> }[] {
  return (subject.infobox ?? []).filter(entry => entry.key.startsWith('版本:') && Array.isArray(entry.value)).map(entry => ({
    key: entry.key,
    fields: Object.fromEntries((entry.value as { k?: string; v?: string }[]).filter(item => item.k && item.v).map(item => [item.k!, item.v!.trim()])),
  }));
}

const TRADITIONAL_PUBLISHER = /東立|东立|尖端|青文|長鴻|长鸿|東販|东贩|[台臺]灣角川|台湾角川|玉皇朝|天下出版|文傳|文传|時報|时报|尚禾|全力|未來數位|未来数位|[台臺]灣|台湾|香港/;
/** "版本:东立版" with 语言 繁体中文, or a Taiwan/Hong Kong publisher. */
export function isTraditionalEdition(key: string, fields: Record<string, string>): boolean {
  const language = fields['语言'];
  return language ? /繁/.test(language) : TRADITIONAL_PUBLISHER.test(`${key} ${fields['出版社'] ?? ''}`);
}
/** The Traditional Chinese (Taiwan/Hong Kong) edition, which is what Kmoe files are. */
export function traditionalEdition(subject: BgmSubject): Record<string, string> | null {
  return editions(subject).find(({ key, fields }) => isTraditionalEdition(key, fields))?.fields ?? null;
}

const CREATOR_KEYS = ['作者', '原作', '作画', '脚本', '原案', '人物原案'];
/** Credited creators from the infobox; "天王寺キツネ(天王寺きつね)" and "A、B" give each name. */
export function creators(subject: BgmSubject): string[] {
  const names = CREATOR_KEYS.flatMap(key => infobox(subject, key)).flatMap(value => value.split(/[、,，/／&＆;；]|\s*[（(]|[)）]/));
  return [...new Set(names.map(name => name.trim()).filter(Boolean))];
}

export function subjectDto(subject: BgmSubject, volumes?: number | null): BangumiSubject {
  return {
    id: subject.id, name: subject.name, nameCn: subject.name_cn || null, platform: subject.platform || null, date: subject.date || null,
    cover: subject.images?.common || subject.images?.large || null, volumes: subject.volumes && subject.volumes > 0 ? subject.volumes : volumes || null,
    authors: creators(subject).slice(0, 4), series: Boolean(subject.series), url: subjectUrl(subject.id),
  };
}

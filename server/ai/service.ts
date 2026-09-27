// AI settings (endpoint, sealed key, model, proxy, monthly token budget), usage accounting, and the prompts the library
// features use: judging candidates, suggesting search words, tidying metadata. All model calls go through client().
import type { AiSettings, AiSettingsPatch, AiTestResult, AiVerdict, MetadataText } from '@shared/model';
import { now, json, type DB } from '../db';
import { AppError } from '../http/errors';
import type { Sealer } from '../lib/crypto';
import { proxied } from '../lib/proxy';
import { errorMessage } from '../lib/retry';
import type { SettingsStore } from '../services/settings';
import { AiClient, parseJson, type Message } from './client';

const KEY = 'ai', SECRET = 'ai.apiKey', USAGE = 'ai.usage';
interface Stored { provider: AiSettings['provider']; baseUrl: string; model: string; useProxy: boolean; monthlyTokens: number }
const DEFAULTS: Stored = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', useProxy: false, monthlyTokens: 0 };
/** A pick at least this sure is applied without asking. */
export const AI_CONFIDENT = 0.85;

/** What the AI is told about a folder (or the Kmoe comic linked to it). */
export interface FolderFacts {
  path: string; name: string; hint: string | null; books: number; files: string[];
  /** Title and author written inside the files (EPUB metadata). */
  fileTitle: string | null; fileAuthor: string | null;
  comic?: { title: string; authors: string[]; status: string | null; volumes: number; description: string | null } | null;
}
export interface Candidate { id: string; line: string }

const month = () => new Date().toISOString().slice(0, 7);
const clean = (text: unknown, max: number) => typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : '';
/** Keeps paragraph breaks (Komga shows them), drops runs of blank lines. */
const paragraphs = (text: unknown, max: number) => typeof text === 'string' ? text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*\n\s*/g, '\n\n').trim().slice(0, max) : '';
const words = (value: unknown, max: number, each = 20) => Array.isArray(value)
  ? [...new Set(value.map(item => clean(item, each)).filter(Boolean))].slice(0, max) : [];

function describe(facts: FolderFacts): string {
  const lines = [`书库文件夹：${facts.path}（${facts.books} 个文件）`];
  if (facts.files.length) lines.push(`文件名示例：${facts.files.join('；')}`);
  if (facts.hint && facts.hint !== facts.name) lines.push(`文件名里的书名：${facts.hint}`);
  if (facts.fileTitle || facts.fileAuthor) lines.push(`电子书元数据：书名「${facts.fileTitle ?? '无'}」，作者「${facts.fileAuthor ?? '无'}」`);
  if (facts.comic) {
    const { title, authors, status, volumes, description } = facts.comic;
    lines.push(`已关联的 Kmoe 漫画：${title}｜作者：${authors.join('、') || '未知'}｜${status ?? '状态未知'}｜单行本 ${volumes} 卷`);
    if (description) lines.push(`Kmoe 简介：${clean(description, 300)}`);
  }
  return lines.join('\n');
}

export class AiService {
  constructor(private readonly deps: { db: DB; sealer: Sealer; settings: SettingsStore; fetch?: typeof fetch }) {}

  // ---------- Settings ----------
  private read<T>(key: string): T | null {
    const row = this.deps.db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? json<T | null>(row.value, null) : null;
  }
  private write(key: string, value: unknown) {
    this.deps.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
  }
  private stored(): Stored { return { ...DEFAULTS, ...this.read<Partial<Stored>>(KEY) }; }
  private key(): string | null {
    const sealed = this.read<string>(SECRET);
    return sealed ? this.deps.sealer.open(Buffer.from(sealed, 'base64')) : null;
  }
  private usage(): { month: string; tokens: number } {
    const usage = this.read<{ month: string; tokens: number }>(USAGE);
    return usage?.month === month() ? usage : { month: month(), tokens: 0 };
  }
  /** Tokens spent by one call (in-flight calls may pass the budget a little: it is checked before each call). */
  private count(tokens: number) {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const usage = this.usage();
    this.write(USAGE, { month: usage.month, tokens: usage.tokens + Math.round(tokens) });
  }

  settings(): AiSettings {
    const stored = this.stored(), hasKey = this.key() !== null;
    return { ...stored, hasKey, usage: this.usage(), ready: hasKey && Boolean(stored.baseUrl.trim() && stored.model.trim()) };
  }

  private merged(patch: AiSettingsPatch, current = this.stored()): Stored {
    const next = { ...current };
    if (patch.provider !== undefined) next.provider = patch.provider;
    if (patch.baseUrl !== undefined) {
      const url = patch.baseUrl.trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw new AppError(400, 'invalid_settings', '接口地址需要以 http:// 或 https:// 开头，例如 https://api.deepseek.com');
      next.baseUrl = url;
    }
    if (patch.model !== undefined) next.model = patch.model.trim();
    if (patch.useProxy !== undefined) next.useProxy = patch.useProxy;
    if (patch.monthlyTokens !== undefined) next.monthlyTokens = patch.monthlyTokens;
    return next;
  }

  patch(patch: AiSettingsPatch): AiSettings {
    this.write(KEY, this.merged(patch));
    if (patch.apiKey !== undefined) {
      const key = patch.apiKey.trim();
      if (key) this.write(SECRET, Buffer.from(this.deps.sealer.seal(key)).toString('base64'));
      else this.deps.db.run('DELETE FROM settings WHERE key = ?', [SECRET]);
    }
    return this.settings();
  }

  private clientFor(stored: Stored, apiKey: string): AiClient {
    const proxy = () => stored.useProxy ? this.deps.settings.get().proxy : '';
    return new AiClient({ baseUrl: stored.baseUrl, apiKey, model: stored.model }, proxied(this.deps.fetch ?? fetch, proxy), tokens => this.count(tokens));
  }

  /** The configured client; refuses when AI is not set up or this month's budget is spent. */
  client(): AiClient {
    const stored = this.stored(), apiKey = this.key();
    if (!apiKey || !stored.baseUrl || !stored.model) throw new AppError(409, 'ai_not_configured', '请先在「设置 → AI」中填写接口地址、模型和 API Key');
    const { tokens } = this.usage();
    if (stored.monthlyTokens > 0 && tokens >= stored.monthlyTokens) {
      throw new AppError(429, 'ai_budget', `本月 AI 用量已达上限（${stored.monthlyTokens.toLocaleString('zh-CN')} token），可以在「设置 → AI」中调高`);
    }
    return this.clientFor(stored, apiKey);
  }

  /** Saved settings merged with unsaved edits: the model list, a one-line reply, and whether JSON mode works. */
  async test(draft: AiSettingsPatch): Promise<AiTestResult> {
    let stored: Stored;
    try { stored = this.merged(draft); } catch (error) { return { ok: false, message: errorMessage(error), models: [], json: null }; }
    const apiKey = draft.apiKey?.trim() || this.key();
    if (!stored.baseUrl) return { ok: false, message: '请填写接口地址', models: [], json: null };
    if (!apiKey) return { ok: false, message: '请填写 API Key', models: [], json: null };
    const client = this.clientFor(stored, apiKey);
    const models = await client.models(AbortSignal.timeout(20_000)).catch(() => [] as string[]);
    if (!stored.model) {
      return { ok: models.length > 0, message: models.length ? `可以连接，这个接口提供 ${models.length} 个模型，请选择一个` : '请填写模型名', models, json: null };
    }
    try {
      const reply = await client.complete([{ role: 'user', content: '只输出这个 JSON：{"ok": true}' }], { json: true, maxTokens: 200, signal: AbortSignal.timeout(60_000) });
      let json = false;
      try { json = parseJson(reply).ok === true; } catch { /* answered, but not as JSON */ }
      return { ok: true, message: json ? `可以使用 ${stored.model}` : `可以连接 ${stored.model}，但它没有按要求返回 JSON，匹配判定可能不稳定`, models, json };
    } catch (error) {
      return { ok: false, message: errorMessage(error), models, json: null };
    }
  }

  // ---------- Prompts ----------
  private async ask(system: string, user: string, signal?: AbortSignal, maxTokens = 600): Promise<Record<string, unknown>> {
    const messages: Message[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
    return parseJson(await this.client().complete(messages, { json: true, maxTokens, signal }));
  }

  /**
   * Which candidate a folder is (Kmoe comics or Bangumi subjects). Candidates are numbered for the model; pick 0 = none.
   * Returns the chosen candidate's id (null for none), a 0–1 confidence and a one-sentence reason.
   */
  async judge(kind: 'kmoe' | 'bangumi', facts: FolderFacts, candidates: Candidate[], signal?: AbortSignal): Promise<AiVerdict> {
    const what = kind === 'kmoe' ? 'Kmoe 上的漫画' : 'Bangumi 条目';
    const system = `你负责把 NAS 书库里的漫画文件夹对应到${what}。根据文件夹名、文件名、电子书元数据${kind === 'bangumi' ? '和已关联的 Kmoe 漫画' : ''}判断它是哪个候选。
注意繁体/简体、日文原名、不同译名都可能指同一部作品；但全彩版与黑白版、完全版与普通版、外传/番外与本篇、小说/画集与漫画、不同的「部」是不同的候选，要选对。
只输出 JSON：{"pick": 候选序号（整数，都不对时为 0）, "confidence": 0 到 1 的小数, "reason": "一句简体中文理由，40 字以内"}`;
    const list = candidates.map((candidate, index) => `${index + 1}. ${candidate.line}`).join('\n');
    const answer = await this.ask(system, `${describe(facts)}\n\n候选：\n${list}`, signal);
    const index = Number(answer.pick);
    const pick = Number.isInteger(index) && index >= 1 && index <= candidates.length ? candidates[index - 1]!.id : null;
    const confidence = Math.min(1, Math.max(0, Number(answer.confidence) || 0));
    return { pick, confidence, reason: clean(answer.reason, 80) || (pick ? '与文件信息一致' : '候选都对不上'), at: now() };
  }

  /** Other ways to write the title for a search that found nothing (original name, simplified/traditional, known translations). */
  async keywords(kind: 'kmoe' | 'bangumi', facts: FolderFacts, signal?: AbortSignal): Promise<string[]> {
    const where = kind === 'kmoe' ? 'Kmoe（繁体中文漫画站，书名多为台湾译名）' : 'Bangumi（书名多为日文原名，中文名为简体）';
    const system = `按书名在 ${where} 上搜索这部漫画没有找到。给出最多 3 个更可能搜到的书名写法：日文原名、简体或繁体写法、常见译名、去掉副标题的短书名。不要编造你不确定的书名。
只输出 JSON：{"keywords": ["写法1", "写法2"]}`;
    const answer = await this.ask(system, describe(facts), signal, 300);
    return words(answer.keywords, 3, 60);
  }

  /** A tidied summary and tags for Komga (simplified Chinese, no promotion, genres from a common vocabulary). */
  async polish(input: { title: string; original: MetadataText; tags: string[]; description: string | null; authors: string[]; tagLimit: number }, signal?: AbortSignal): Promise<MetadataText> {
    const system = `你在整理漫画的元数据，结果会写入 Komga 书库。要求：
- summary：简体中文的剧情简介，150–400 字，只保留故事与人物介绍，去掉宣传语、获奖/销量信息、出版信息和多余换行；原简介为空时根据 Kmoe 简介改写；都没有就留空字符串。
- genres：最多 5 个类型，优先从这些里选：恋爱、校园、奇幻、科幻、冒险、战斗、悬疑、推理、恐怖、搞笑、日常、治愈、运动、美食、音乐、职场、历史、战争、后宫、异世界、转生、百合、耽美、成人、萌系、热血、剧情、社会。
- tags：最多 ${input.tagLimit} 个简体中文标签，从原标签里挑有信息量的（题材、设定、风格），合并同义词，去掉作者名、出版社、年份、「漫画」「日本」「单行本」这类没用的词。
只输出 JSON：{"summary": "…", "genres": ["…"], "tags": ["…"]}`;
    const user = [
      `书名：${input.title}`, `作者：${input.authors.join('、') || '未知'}`,
      `原简介：${clean(input.original.summary, 1500) || '（无）'}`,
      `Kmoe 简介：${clean(input.description, 800) || '（无）'}`,
      `原类型：${input.original.genres.join('、') || '（无）'}`,
      `Bangumi 标签（按标注人数排序）：${input.tags.join('、') || '（无）'}`,
    ].join('\n');
    const answer = await this.ask(system, user, signal, 1500);
    return { summary: paragraphs(answer.summary, 1200), genres: words(answer.genres, 5), tags: words(answer.tags, input.tagLimit) };
  }
}

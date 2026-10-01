// Naming rules and path helpers. The rule syntax is the solywsh/kmoe-sync browser extension's, so its exported rule imports
// as is; unlike the extension, every name is cut to 200 UTF-8 bytes. Pure functions: used by server and web app.
import type { Format } from './model';

export const DEFAULT_RULE = '{title}/{filename}';
export const RULE_TOKENS = ['title', 'filename', 'bookname', 'author', 'year', 'month', 'day', 'hour', 'min', 'ext'] as const;

export class NamingError extends Error {}

/** "/a/b" style path; rejects "..", control characters and encoded separators. */
export function normalizePath(raw = '/'): string {
  const parts = raw.trim().replace(/\\/g, '/').split('/').filter(Boolean);
  for (const part of parts) {
    let decoded: string;
    try { decoded = decodeURIComponent(part); } catch { decoded = part; }
    if (decoded === '.' || decoded === '..' || /[\x00-\x1f\x7f/\\]/.test(decoded)) throw new NamingError('目录不能包含 ..、控制字符或编码的分隔符');
  }
  return `/${parts.join('/')}`;
}

export function joinPath(base: string, relative: string): string {
  return normalizePath(`${normalizePath(base)}/${relative}`);
}

/** Longest name component in UTF-8 bytes: file systems allow 255, and the extension is appended later. */
const MAX_SEGMENT_BYTES = 200;
const encoder = new TextEncoder();

/** Cuts at a character boundary so the UTF-8 form fits (CJK titles are 3 bytes per character). */
function fitBytes(value: string, limit: number): string {
  if (encoder.encode(value).length <= limit) return value;
  let result = '', size = 0;
  for (const char of value) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > limit) break;
    result += char;
    size += bytes;
  }
  return result.replace(/[. ]+$/g, '');
}

/** One file/folder name component that is safe on Windows, macOS, Linux and WebDAV servers. */
export function safeSegment(value: string): string {
  return fitBytes(value.normalize('NFC').replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, ''), MAX_SEGMENT_BYTES) || '_';
}

const TOKENS = new Set<string>(RULE_TOKENS);
export function validateRule(rule: string): string {
  const text = rule.trim() || DEFAULT_RULE;
  if (text.length > 500) throw new NamingError('命名规则过长');
  for (const token of text.matchAll(/\{([^}]+)\}/g)) {
    if (!TOKENS.has(token[1]!) && !/^author\$\d+$/.test(token[1]!)) throw new NamingError(`不支持的变量：${token[0]}`);
  }
  normalizePath(text);
  if (/[{}]/.test(text.replace(/\{[^}]+\}/g, ''))) throw new NamingError('规则中的大括号不完整');
  return text;
}

/** Original file name from Content-Disposition or the site's link name, with the right extension. */
export function fileInfo(name: string, header: string | null, title: string, chapter: string, format: Format) {
  let fromHeader = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (fromHeader) { try { fromHeader = decodeURIComponent(fromHeader); } catch { fromHeader = undefined; } }
  fromHeader ||= header?.match(/filename="([^"]+)"|filename=([^;]+)/i)?.slice(1).find(Boolean);
  const ext = format;
  const original = safeSegment(fromHeader || name || `${title}-${chapter}.${ext}`);
  const suffix = original.match(/\.(epub|mobi)$/i)?.[0];
  const stem = suffix ? original.slice(0, -suffix.length) : original;
  return { stem, ext, name: `${stem}.${ext}` };
}

export interface RuleContext { title: string; filename: string; bookname: string; author: string[]; ext: string; date?: Date }

/** Relative path (no leading slash) for one file. Adds the extension unless the file segment uses {ext}. */
export function renderRule(rule: string, context: RuleContext): string {
  const date = context.date ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const tokens: Record<string, string> = {
    title: context.title, filename: context.filename, bookname: context.bookname, ext: context.ext, author: context.author.join('-'),
    year: String(date.getFullYear()), month: pad(date.getMonth() + 1), day: pad(date.getDate()), hour: pad(date.getHours()), min: pad(date.getMinutes()),
  };
  const template = validateRule(rule);
  let path = template.split('/').filter(Boolean).map(part => safeSegment(part.replace(/\{([\w]+)(?:\$(\d+))?\}/g, (_, key: string, index: string | undefined) => {
    const value = key === 'author' && index !== undefined ? context.author[Number(index)] ?? '' : tokens[key] ?? '';
    return value ? safeSegment(value) : '';
  }))).join('/');
  if (!path) path = safeSegment(context.filename);
  if (!template.split('/').filter(Boolean).at(-1)?.includes('{ext}')) path += `.${context.ext}`;
  return path;
}

/** Example used by rule previews: 《渣女沒渣報》卷 01. */
export const RULE_SAMPLE: RuleContext = { title: '渣女沒渣報', filename: '[Kmoe][渣女沒渣報]卷01', bookname: '卷 01', author: ['岸川瑞樹'], ext: 'epub' };

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const index = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][index]}`;
}

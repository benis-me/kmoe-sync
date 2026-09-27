// Parsers for Kmoe pages and JSON. Strict: anything unexpected is `site_changed`, never silently empty.
// Ported from kmoeshelf (MIT, see THIRD_PARTY_NOTICES.md) with fixes: the page key (/c/<key>.htm) and the numeric
// book id are different things on current mirrors, and HTML is read with Bun's HTMLRewriter instead of a DOM.
import type { ContentType } from '@shared/model';
import { KmoeError, siteChanged } from './errors';

// ---------- JavaScript call arguments embedded in pages: disp_divinfo("…", "…"), data_book("hash") ----------
const JS_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };

function readString(source: string, start: number): [string, number] {
  const quote = source[start];
  let position = start + 1, result = '';
  while (position < source.length) {
    const char = source[position++]!;
    if (char === quote) return [result, position];
    if (char !== '\\') { result += char; continue; }
    const escaped = source[position++];
    if (escaped === undefined) break;
    if (escaped === 'u' || escaped === 'x') {
      const length = escaped === 'u' ? 4 : 2, digits = source.slice(position, position + length);
      if (!/^[0-9a-f]+$/i.test(digits) || digits.length !== length) throw siteChanged('脚本字符串转义');
      result += String.fromCharCode(Number.parseInt(digits, 16));
      position += length;
    } else result += JS_ESCAPES[escaped] ?? escaped;
  }
  throw siteChanged('脚本字符串未结束');
}

function readArguments(source: string, start: number): [string[], number] {
  const args: string[] = [];
  let position = start;
  const skip = () => { while (position < source.length && /\s/.test(source[position]!)) position++; };
  while (position < source.length) {
    skip();
    if (source[position] === ')') return [args, position + 1];
    let value: string;
    if (source[position] === '"' || source[position] === "'") {
      [value, position] = readString(source, position);
      for (skip(); source[position] === '+'; skip()) {
        position++; skip();
        if (source[position] !== '"' && source[position] !== "'") throw siteChanged('脚本字符串拼接');
        const [part, next] = readString(source, position);
        value += part; position = next;
      }
    } else {
      const from = position;
      while (position < source.length && source[position] !== ',' && source[position] !== ')') position++;
      value = source.slice(from, position).trim();
    }
    args.push(value);
    skip();
    if (source[position] === ',') { position++; continue; }
    if (source[position] === ')') return [args, position + 1];
    break;
  }
  throw siteChanged('脚本调用格式');
}

/** Every call `name(...)` in the page, skipping `function name(` declarations. */
export function javascriptCalls(source: string, name: string): string[][] {
  const calls: string[][] = [];
  const marker = `${name}(`;
  let position = 0;
  for (;;) {
    const start = source.indexOf(marker, position);
    if (start < 0) return calls;
    const before = source.slice(Math.max(0, start - 64), start);
    const previous = source[start - 1];
    if (/\bfunction\s*$/.test(before) || (previous !== undefined && /[\w$.]/.test(previous))) { position = start + marker.length; continue; }
    const [args, next] = readArguments(source, start + marker.length);
    calls.push(args);
    position = next;
  }
}

// ---------- Small HTML helpers ----------
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}
/** Visible text of an HTML fragment, whitespace collapsed. */
export function plainText(value: string): string {
  return decodeEntities(value.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function httpsUrl(value: string | null | undefined, origin: string): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(decodeEntities(value.trim()), origin);
    return url.protocol === 'https:' || url.origin === new URL(origin).origin ? url.href : null;
  } catch { return null; }
}

// ---------- Comic identity ----------
const DETAIL_PATH = /^\/(?:m\/)?c\/([A-Za-z0-9]+)\.htm$/;
export const COMIC_KEY = /^[A-Za-z0-9]{1,32}$/;

/** Page key from a detail URL/path of any mirror (desktop or /m/ mobile), or null. */
export function keyFromUrl(value: string, trustedHosts: readonly string[]): string | null {
  const input = value.trim();
  if (COMIC_KEY.test(input)) return input;
  let url: URL;
  try { url = new URL(input, 'https://kmoe.invalid'); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.hostname !== 'kmoe.invalid' && !trustedHosts.some(trusted => host === trusted || host.endsWith(`.${trusted}`))) return null;
  return DETAIL_PATH.exec(url.pathname)?.[1] ?? null;
}

// ---------- Search results ----------
export interface SearchHit { key: string; title: string; authors: string[]; cover: string | null; language: string | null; latest: string | null; updatedAt: string | null }
export interface SearchPage { page: number; totalPages: number; hits: SearchHit[] }

const splitAuthors = (value: string) => [...new Set(value.split(/[,，、/]| {2,}/).map(part => part.trim()).filter(Boolean))];

export function parseSearchPage(html: string, requestedPage: number, origin: string, trustedHosts: readonly string[]): SearchPage {
  if (/<form[^>]+action=["'][^"']*login/i.test(html) && !html.includes('disp_divinfo')) throw new KmoeError('login_required', '搜索需要登录 Kmoe');
  const results = javascriptCalls(html, 'disp_divinfo').filter(args => args.length);
  const pages = javascriptCalls(html, 'disp_divpage').filter(args => args.length);
  const pageNow = /\bvar\s+page_now\s*=\s*(['"])(\d+)\1/.exec(html);
  if (!results.length && !pages.length) throw siteChanged('搜索结果');
  if (!pageNow) throw siteChanged('搜索页码');
  const current = Number(pageNow[2]);
  let totalPages = 1;
  if (pages[0]) {
    if (pages[0].length < 3) throw siteChanged('搜索分页');
    totalPages = Math.max(1, Number(pages[0][2]) || 0);
  }
  if (current !== requestedPage && !(results.length === 0 && requestedPage === 1)) throw siteChanged('搜索页码与请求不符');
  const hits: SearchHit[] = [], seen = new Set<string>();
  for (const [index, args] of results.entries()) {
    if (args.length < 11) throw siteChanged(`搜索结果 ${index + 1}`);
    const key = keyFromUrl(decodeEntities(args[1]!), trustedHosts);
    if (!key) throw siteChanged(`搜索结果链接 ${index + 1}`);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = plainText(args[9]!);
    if (!title) throw siteChanged(`搜索结果标题 ${index + 1}`);
    hits.push({
      key, title, authors: splitAuthors(plainText(args[10]!)), cover: httpsUrl(args[2], origin),
      // The four tag arguments are inverted: '' means the tag is active.
      language: args[4] === '' ? '日文' : args[5] === '' ? '英文' : null,
      latest: args[11] ? plainText(args[11]) || null : null,
      updatedAt: args[12] ? plainText(args[12]) || null : null,
    });
  }
  return { page: Math.max(1, current || requestedPage), totalPages: Math.max(totalPages, current || 1), hits };
}

// ---------- Detail page ----------
export interface DetailPage {
  key: string; bookId: string; title: string; authors: string[]; cover: string | null;
  status: string | null; language: string | null; description: string | null; dataHash: string;
}

export async function parseDetailPage(html: string, key: string, origin: string): Promise<DetailPage> {
  const found = { bookIds: [] as string[], ogImage: '', imgBook: '', title: '', docTitle: '', authorCell: '', authorLinks: [] as string[] };
  let inAuthorLink = false;
  await new HTMLRewriter()
    .on('input[name="bookid"]', { element(el) { const value = el.getAttribute('value')?.trim(); if (value) found.bookIds.push(value); } })
    .on('meta[property="og:image"], meta[name="og:image"]', { element(el) { found.ogImage ||= el.getAttribute('content') ?? ''; } })
    .on('img.img_book', { element(el) { found.imgBook ||= el.getAttribute('src') ?? ''; } })
    .on('font.text_bglight_big', { text(chunk) { found.title += chunk.text; } })
    .on('title', { text(chunk) { found.docTitle += chunk.text; } })
    .on('td.author', { text(chunk) { found.authorCell += chunk.text; } })
    .on('td.author a[href*="list.php?s="]', {
      element(el) { inAuthorLink = true; found.authorLinks.push(''); el.onEndTag(() => { inAuthorLink = false; }); },
      text(chunk) { if (inAuthorLink) found.authorLinks[found.authorLinks.length - 1] += chunk.text; },
    })
    .transform(new Response(html)).text();

  const scriptBookId = /\bvar\s+bookid\s*=\s*["']?(\d+)["']?\s*;/.exec(html)?.[1];
  const bookId = found.bookIds.find(value => /^\d+$/.test(value)) ?? scriptBookId;
  if (!bookId) throw siteChanged('漫画编号');
  const title = plainText(found.title) || plainText(found.docTitle).split(/\s*[:：]\s*/)[0] || '';
  if (!title) throw siteChanged('漫画标题');
  const hashes = javascriptCalls(html, 'data_book').filter(args => args.length);
  const dataHash = hashes[0]?.[0]?.trim() ?? '';
  if (hashes[0]?.length !== 1 || !/^[0-9a-z]{8,512}$/i.test(dataHash)) throw siteChanged('章节数据标识');
  const cell = plainText(found.authorCell);
  const status = /\bvar\s+bookstatus\s*=\s*"([^"]*)"/.exec(html)?.[1]?.trim() || /狀態\s*[：:]\s*(\S+)/.exec(cell)?.[1] || null;
  return {
    key, bookId, title,
    authors: [...new Set(found.authorLinks.map(plainText).filter(Boolean))],
    cover: httpsUrl(found.ogImage || found.imgBook, origin),
    status,
    language: /語言\s*[：:]\s*([^\s|/]+)/.exec(cell)?.[1] ?? null,
    description: extractDescription(html),
    dataHash,
  };
}

function extractDescription(html: string): string | null {
  const match = /div_desc_content[^;]*?\.innerHTML\s*=\s*/i.exec(html);
  if (!match) return null;
  let position = match.index + match[0].length;
  while (/\s/.test(html[position] ?? '')) position++;
  if (html[position] !== '"' && html[position] !== "'") return null;
  const [value] = readString(html, position);
  return plainText(value) || null;
}

// ---------- Volume data (/data_book.php) ----------
export interface RemoteItem { id: string; type: ContentType; name: string; order: number | null; pages: number | null; epubMB: number | null; mobiMB: number | null }
const TYPES: Record<string, ContentType> = { 單行本: 'volume', 单行本: 'volume', 番外篇: 'extra', 番外: 'extra', 話: 'serial', 话: 'serial' };

const count = (value: unknown) => { const n = Number(value); return Number.isInteger(n) && n >= 0 ? n : null; };
const megabytes = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; };

export function parseVolumeData(payload: unknown): RemoteItem[] {
  if (!payload || typeof payload !== 'object') throw siteChanged('章节数据');
  const data = payload as Record<string, unknown>;
  const rows = data.voldata;
  if (!Array.isArray(rows)) throw siteChanged('章节列表');
  if (Number(data.volcount) !== rows.length) throw siteChanged('章节数量');
  // An empty list with a blank identity is what the site returns when the page session does not match.
  if (!rows.length && !String(data.bookname ?? '').trim()) throw new KmoeError('login_required', 'Kmoe 没有返回章节数据，请重试或重新登录');
  return rows.map((row, index) => {
    if (!Array.isArray(row) || row.length < 12) throw siteChanged(`第 ${index + 1} 条章节数据`);
    // Names come HTML-escaped (「娜娜&amp;小八」).
    const id = String(row[0]).trim(), name = decodeEntities(String(row[5])).trim();
    const type = TYPES[String(row[3]).trim()];
    if (!id || !name) throw siteChanged(`第 ${index + 1} 条章节标识`);
    if (!type) throw siteChanged(`未知章节类型「${String(row[3])}」`);
    // [7] is the e-book page count; [9] MOBI MB, [11] EPUB MB (see kmoeshelf research notes).
    return { id, type, name, order: count(row[4]), pages: count(row[7]) ?? count(row[6]), mobiMB: megabytes(row[9]), epubMB: megabytes(row[11]) };
  });
}

// ---------- Account (/my.php) ----------
export interface QuotaInfo { totalMB: number | null; usedMB: number | null; resetDay: number | null }
export interface AccountInfo { level: number | null; vip: boolean | null; free: QuotaInfo | null; vipQuota: QuotaInfo | null }
const firstNumber = (pattern: RegExp, text: string) => { const value = pattern.exec(text)?.[1]; return value === undefined ? null : Number(value); };

export function parseAccount(html: string): AccountInfo {
  const text = plainText(html);
  const variable = (name: string) => { const value = new RegExp(`\\bvar\\s+${name}\\s*=\\s*(?:parseInt\\(\\s*)?['"]?(\\d+)`, 'i').exec(html)?.[1]; return value === undefined ? null : Number(value); };
  const quota = (total: RegExp, used: RegExp, reset: RegExp): QuotaInfo | null => {
    const result = { totalMB: firstNumber(total, text), usedMB: firstNumber(used, text), resetDay: firstNumber(reset, text) };
    return Object.values(result).some(value => value !== null) ? result : null;
  };
  const free = quota(/Lv\d+\s*每月額度\s*[:：]\s*([\d.]+)\s*M/i, /本月已用免費額度\s*[:：]\s*([\d.]+)\s*M/i, /Lv\d+\s*額度\s*[:：]\s*每月\s*(\d+)\s*日/i);
  const vipQuota = quota(/VIP\s*每月額度\s*[:：]\s*([\d.]+)\s*M/i, /本月已經用VIP額度\s*[:：]\s*([\d.]+)\s*M/i, /VIP\s*額度\s*[:：]\s*每月\s*(\d+)\s*日/i);
  const isVip = variable('is_vip');
  return { level: variable('user_level'), vip: isVip !== null ? isVip > 0 : vipQuota !== null, free, vipQuota };
}

export const PROFILE_SENTINELS = ['/logout.php', '登出', '退出登入', '退出登錄'];

// ---------- Download link (/getdownurl.php) ----------
const QUOTA_MARKERS = ['額度不足', '達到下載額度限制', '额度不足'];
export function parseDownloadLink(payload: unknown): { url: string; name: string } {
  if (!payload || typeof payload !== 'object') throw siteChanged('下载链接');
  const data = payload as Record<string, unknown>;
  const message = ['msg', 'message', 'msgid'].map(key => String(data[key] ?? '')).join(' ');
  if (String(data.code) === 'e403' || QUOTA_MARKERS.some(marker => message.includes(marker))) throw new KmoeError('quota_exhausted', 'Kmoe 下载额度不足');
  if (String(data.code) !== '200' || typeof data.url !== 'string') {
    const text = plainText(String(data.msg ?? data.message ?? '')).slice(0, 200);
    if (/登[錄录入]/.test(text)) throw new KmoeError('login_required', 'Kmoe 登录已失效，请重新登录');
    throw new KmoeError('refused', text || 'Kmoe 拒绝了下载请求，请在网站确认账号状态');
  }
  let url: URL;
  try { url = new URL(data.url); } catch { throw new KmoeError('refused', 'Kmoe 返回了无效的下载地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new KmoeError('refused', 'Kmoe 返回了不安全的下载地址');
  return { url: url.href, name: typeof data.name === 'string' ? data.name.slice(0, 300) : '' };
}

// Text helpers for matching titles on Kmoe and Bangumi: fold Traditional/Japanese character forms to Simplified, compare titles,
// and read volume numbers from Komga file names, Kmoe item names and Bangumi volume names.
import { JAPANESE, TRADITIONAL } from './chars';

/** Comparable form of a title: width/case folded, spaces/punctuation/symbols dropped, common variant characters unified. */
export const canonicalTitle = (text: string) => text.normalize('NFKC').toLowerCase()
  .replace(/[\s\p{P}\p{S}]/gu, '').replace(/[話话]/g, '话').replace(/[巻卷]/g, '卷');

/** Levenshtein similarity of two canonical titles, 0–1. */
export function similarity(a: string, b: string): number {
  const x = [...canonicalTitle(a)], y = [...canonicalTitle(b)];
  if (!x.length || !y.length) return 0;
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    previous = current;
  }
  return 1 - previous[y.length]! / Math.max(x.length, y.length);
}

const FOLD = new Map<string, string>();
for (const table of [TRADITIONAL, JAPANESE]) {
  const chars = Array.from(table);
  for (let i = 0; i + 1 < chars.length; i += 2) FOLD.set(chars[i]!, chars[i + 1]!);
}

/** Comparable form: width/case/punctuation folded (canonicalTitle), Traditional and Japanese forms mapped to Simplified. */
export function fold(text: string): string {
  let out = '';
  for (const char of canonicalTitle(text)) out += FOLD.get(char) ?? char;
  return out;
}

const length = (text: string) => Array.from(text).length;

/** First two Han characters of a folded name (the surname of most CJK names), or null. */
export const surname = (folded: string) => /^\p{Script=Han}{2}/u.test(folded) ? Array.from(folded).slice(0, 2).join('') : null;

/** 0–1 similarity of two titles after folding. Containment counts, but never enough to auto-accept on its own (≤ 0.8). */
export function titleSimilarity(a: string, b: string): number {
  const x = fold(a), y = fold(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [short, long] = length(x) <= length(y) ? [x, y] : [y, x];
  const contained = length(short) >= 2 && long.includes(short) ? 0.5 + 0.3 * length(short) / length(long) : 0;
  return Math.max(similarity(x, y), contained);
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** "ONE PIECE 航海王" → ["ONE PIECE", "航海王"]: Taiwan editions often pair a Latin title with a Chinese one. */
export function titleParts(text: string): string[] {
  const words = text.trim().split(/\s+/), cjk = words.map(word => CJK.test(word));
  const split = cjk.findIndex((value, index) => index > 0 && value !== cjk[index - 1]);
  if (split < 0 || cjk.slice(split).some(value => value !== cjk[split])) return [];
  return [words.slice(0, split).join(' '), words.slice(split).join(' ')].filter(part => length(fold(part)) >= 2);
}

/** The title before a subtitle or reading: "NANA -ナナ-" → "NANA", "葬送のフリーレン (1)" → "葬送のフリーレン". */
export function mainTitle(text: string): string | null {
  const main = /^(.+?)\s*(?:[-‐–—~～〜:：|｜/]|[(（【[「『])/.exec(text.trim())?.[1]?.trim();
  return main && length(fold(main)) >= 2 ? main : null;
}

// ---------- Volume numbers ----------
export interface BookNumber {
  kind: 'volume' | 'chapter' | 'extra' | 'unknown';
  /** First volume number (numberSort); null unless kind is volume. */
  number: number | null;
  /** Komga "number": "3", "10.5" or a range like "1-3". */
  label: string | null;
  range: boolean;
}

const NUM = String.raw`(\d+(?:\.\d+)?)(?:\s*[-~～－]\s*(\d+(?:\.\d+)?))?`;
/** Explicit volume markers: 卷 01, 第1卷, 1-3巻, Vol.01, v01. */
const STRONG = [
  new RegExp(String.raw`[卷巻册冊]\s*${NUM}`),
  new RegExp(String.raw`${NUM}\s*[卷巻册冊]`),
  new RegExp(String.raw`(?:^|[^a-z])vol(?:ume)?\.?\s*${NUM}`, 'i'),
  new RegExp(String.raw`(?:^|[^a-z])v${NUM}(?![a-z])`, 'i'),
];
/** Weak markers, only after chapter/extra checks: the last "(3)" (not a year), or a trailing number. */
const WEAK = [/[(（]\s*(\d{1,3}(?:\.\d+)?)\s*[)）][^(（]*$/, /(?:^|[\s_\-－])(\d{1,3}(?:\.\d+)?)\s*$/];
const CHAPTER = /[話话]\s*\d|\d\s*[話话回]|(?:^|[^a-z])ch(?:ap(?:ter)?)?\.?\s*\d/i;
const EXTRA = /番外|特典|外[傳传]|短篇|[畫画]集|公式|設定集|设定集|fanbook|artbook/i;

const volume = (match: RegExpExecArray): BookNumber => {
  const first = Number(match[1]), last = match[2] === undefined ? first : Number(match[2]);
  const range = last > first;
  return { kind: 'volume', number: first, label: range ? `${first}-${last}` : String(first), range };
};
const kind = (value: BookNumber['kind']): BookNumber => ({ kind: value, number: null, label: null, range: false });

/**
 * What a book file (or Kmoe item / Bangumi volume name) is. `title` (the series title the files are named after) is removed
 * first, so digits in titles like "20世紀少年" are not read as volume numbers. No Roman numerals, ranges stay ranges.
 */
export function bookNumber(name: string, title?: string | null): BookNumber {
  let stem = name.normalize('NFKC').replace(/\.(k?epub|mobi|azw3?|pdf|cbz|cbr|cb7|zip|rar|7z)$/i, '').trim();
  stem = stem.replace(/^\[(?:kmoe|mox|kox|koz|kzo|kxo|kxx|kzz|vol\.moe)[^\]]*\]\[[^\]]*\]/i, '');
  const prefix = title?.normalize('NFKC').trim();
  if (prefix && stem.startsWith(prefix)) stem = stem.slice(prefix.length);
  for (const pattern of STRONG) { const match = pattern.exec(stem); if (match) return volume(match); }
  if (CHAPTER.test(stem)) return kind('chapter');
  if (EXTRA.test(stem)) return kind('extra');
  for (const pattern of WEAK) { const match = pattern.exec(stem); if (match) return volume(match); }
  return kind('unknown');
}

/** A Bangumi single-volume subject name: "NANA -ナナ- (11)", "ワンピース 3", "X 第3巻", "X Vol.3". */
const VOLUME_SUFFIX = /\s*(?:[(（]\s*\d{1,3}\s*[)）]|第?\s*\d{1,3}\s*[巻卷册冊]|vol\.?\s*\d{1,3}|\s\d{1,3})\s*$/i;
export const isVolumeName = (name: string) => VOLUME_SUFFIX.test(name.normalize('NFKC'));
export const volumeBase = (name: string) => name.normalize('NFKC').replace(VOLUME_SUFFIX, '').trim();

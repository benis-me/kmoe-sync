// What a book file is, from its name: the volume number Komga sorts by (bookNumber), and which of a comic's Kmoe items it
// holds, for 整理文件名 (planRename). Pure functions: used by the server and the demo mode.
import type { ContentType, RenameFile } from './model';
import { chapterKey, kmoeFilename, renderRule, safeSegment } from './naming';

/** E-books and comic archives: a folder that holds them is a series folder. */
export const BOOK_FILE = /\.(epub|kepub|mobi|azw3?|pdf|cbz|cbr|cb7|zip|rar|7z)$/i;
/** "[Kmoe][書名]" in front of Kmoe's own file names (any mirror's brand). */
const BRANDED = /^\[(?:kmoe|mox|kox|koz|kzo|kxo|kxx|kzz|vol\.moe)[^\]]*\]\[[^\]]*\]/i;

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
  stem = stem.replace(BRANDED, '');
  const prefix = title?.normalize('NFKC').trim();
  if (prefix && stem.startsWith(prefix)) stem = stem.slice(prefix.length);
  for (const pattern of STRONG) { const match = pattern.exec(stem); if (match) return volume(match); }
  if (CHAPTER.test(stem)) return kind('chapter');
  if (EXTRA.test(stem)) return kind('extra');
  for (const pattern of WEAK) { const match = pattern.exec(stem); if (match) return volume(match); }
  return kind('unknown');
}

/** Chapter numbers a name states: 話 076-080, 第76-80話, 076話, Ch.12 (a pack of chapters is a range). */
const CHAPTERS = [String.raw`[話话]\s*R`, String.raw`第\s*R\s*[話话回]`, String.raw`R\s*[話话回]`, String.raw`(?:^|[^a-z])ch(?:ap(?:ter)?)?\.?\s*R`]
  .map(pattern => new RegExp(pattern.replace('R', String.raw`(\d+(?:\.\d+)?)(?:\s*[-~～－–—]\s*(\d+(?:\.\d+)?))?`), 'i'));
export function chapterRange(name: string): { first: number; last: number } | null {
  const text = name.normalize('NFKC');
  for (const pattern of CHAPTERS) {
    const match = pattern.exec(text);
    if (match) return { first: Number(match[1]), last: Number(match[2] ?? match[1]) };
  }
  return null;
}

/** What a Kmoe item is: 卷 NN volumes (else their order), 話 chapter packs, 番外 extras. */
export function itemNumber(item: { type: ContentType; name: string; sort_order: number | null }): BookNumber {
  if (item.type !== 'volume') return { kind: item.type === 'serial' ? 'chapter' : 'extra', number: null, label: null, range: false };
  const parsed = bookNumber(item.name);
  if (parsed.kind === 'volume' || item.sort_order === null) return parsed;
  return { kind: 'volume', number: item.sort_order, label: String(item.sort_order), range: false };
}

// ---------- 整理文件名 ----------
export interface RenameItem { id: string; type: ContentType; name: string; sort_order: number | null }
export interface RenameInput {
  /** The comic's Kmoe title and authors ({title}, {author}). */
  title: string;
  authors: string[];
  /** The title the files were named after, when it is another one ("GRAND BLUE 碧藍之海-卷 01" for 碧藍之海). */
  hint?: string | null;
  /** The naming rule's file-name part: files keep their folder. */
  rule: string;
  items: RenameItem[];
  /** Everything in the folder: its book files are renamed, and nothing is ever renamed onto any entry. */
  entries: { name: string; directory: boolean }[];
  /** Files this service downloaded here: file name (NFC) → item id. */
  records?: ReadonlyMap<string, string>;
  /** What the AI read files to be that their names did not settle: file name (NFC) → item id and how sure. */
  ai?: ReadonlyMap<string, { item: string; confidence: number }>;
  /** For {year}…{min} in the rule (default now). */
  date?: Date;
}

const nfc = (text: string) => text.normalize('NFC');
/** One entry's name as file systems compare it: macOS and SMB shares take "Vol" and "vol" for one name. */
const same = (text: string) => nfc(text).toLowerCase();
const extOf = (name: string) => /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARK = 'KMOESYNCMARK';
const DATES = ['year', 'month', 'day', 'hour', 'min'];

type Planned = RenameFile & { named: boolean };

/**
 * What renaming a series folder's book files to the rule would do. A file is recognised by its download record, else by its
 * name (an item name like "話 005-015" after the title, a volume number or chapter range in any notation, or a volume or
 * chapter pack Kmoe no longer lists), else by the AI's reading.
 * Files already named as the rule says count in `named`; the rest come back with their new name, or with `to` null and why:
 * not recognised, two files of one item, the name taken by another entry, or names that would have to be swapped.
 */
export function planRename(input: RenameInput): { named: number; files: RenameFile[] } {
  const items = new Map(input.items.map(item => [item.id, item]));
  const byKey = new Map<string, RenameItem[]>(), byVolume = new Map<number, RenameItem[]>(), byChapters = new Map<string, RenameItem[]>();
  const add = <K>(map: Map<K, RenameItem[]>, key: K, item: RenameItem) => map.set(key, [...map.get(key) ?? [], item]);
  for (const item of input.items) {
    add(byKey, chapterKey(item.name), item);
    const number = itemNumber(item), chapters = item.type === 'serial' ? chapterRange(item.name) : null;
    if (number.kind === 'volume' && number.number !== null && !number.range) add(byVolume, number.number, item);
    if (chapters) add(byChapters, `${chapters.first}-${chapters.last}`, item);
  }
  const titles = [input.title, input.hint ?? ''].map(title => nfc(title).trim()).filter(Boolean);

  /** A file name (without extension) after Kmoe's brand and the title: "[Kmoe][鏈鋸人]卷01" → "卷01". */
  function afterTitle(stem: string): string {
    const rest = nfc(stem).trim().replace(BRANDED, '');
    const title = titles.flatMap(title => [title, safeSegment(title)]).find(title => rest.startsWith(title));
    return title ? rest.slice(title.length) : rest;
  }

  /** The item a file name (without extension) names; 'ambiguous' when it fits several. */
  function recognise(stem: string): RenameItem | 'ambiguous' | null {
    const rest = afterTitle(stem);
    // The whole rest, then what follows each separator: "鏈鋸人 - 話 005-015", "Chainsaw Man 卷 01".
    const tails = [rest, ...[...rest.matchAll(/[\s\-_·.]+/g)].map(match => rest.slice(match.index + match[0].length))];
    for (const tail of tails) {
      const hits = byKey.get(chapterKey(tail.replace(/^[\s\-_·.]+/, '')));
      if (hits) return hits.length === 1 ? hits[0]! : 'ambiguous';
    }
    const number = bookNumber(rest), chapters = number.kind === 'chapter' ? chapterRange(rest) : null;
    const hits = number.kind === 'volume' && !number.range && number.number !== null ? byVolume.get(number.number)
      : chapters ? byChapters.get(`${chapters.first}-${chapters.last}`) : undefined;
    return hits ? hits.length === 1 ? hits[0]! : 'ambiguous' : null;
  }

  /**
   * A volume or chapter pack the name states plainly but Kmoe no longer lists (chapters gathered into a volume, a volume
   * not listed yet), named the way Kmoe names its items: "話 076-080", "卷 17".
   */
  function stated(stem: string): RenameItem | null {
    const rest = afterTitle(stem), number = bookNumber(rest), pad = (value: number, width: number) => String(value).replace(/^\d+/, digits => digits.padStart(width, '0'));
    if (number.kind === 'chapter') {
      const chapters = chapterRange(rest);
      if (!chapters) return null;
      const name = `話 ${pad(chapters.first, 3)}${chapters.last > chapters.first ? `-${pad(chapters.last, 3)}` : ''}`;
      return { id: `~${name}`, type: 'serial', name, sort_order: chapters.first };
    }
    // Only an explicit volume marker: a bare trailing number is too weak a hint to name a file after.
    if (number.kind !== 'volume' || number.range || number.number === null || !STRONG.some(pattern => pattern.test(rest.normalize('NFKC')))) return null;
    const name = `卷 ${pad(number.number, 2)}`;
    return { id: `~${name}`, type: 'volume', name, sort_order: number.number };
  }

  /** Named as the rule says: {filename} is Kmoe's name for the file ("[Kmoe][鏈鋸人]卷01", any mirror or title), dates any date. */
  function follows(name: string, item: RenameItem): boolean {
    const template = input.rule.replace(/\{(year|month|day|hour|min)\}/g, (_, key: string) => `${MARK}${key}`);
    let pattern = escape(renderRule(template, { title: input.title, author: input.authors, filename: `${MARK}filename`, bookname: item.name, ext: extOf(name) }))
      .replaceAll(`${MARK}filename`, '(.+)');
    for (const key of DATES) pattern = pattern.replaceAll(`${MARK}${key}`, key === 'year' ? '\\d{4}' : '\\d{2}');
    const match = new RegExp(`^${pattern}$`, 'u').exec(nfc(name));
    if (!match) return false;
    if (match[1] === undefined) return true;
    const found = BRANDED.test(match[1]) ? recognise(match[1]) : 'ambiguous';
    return found === item || (found === null && stated(match[1])?.name === item.name);
  }

  const plans: Planned[] = [];
  for (const { name } of input.entries.filter(entry => !entry.directory && BOOK_FILE.test(entry.name))) {
    const recorded = input.records?.get(nfc(name)), reading = input.ai?.get(nfc(name));
    let item = recorded === undefined ? undefined : items.get(recorded);
    let source: RenameFile['source'] = item ? 'record' : null, note: string | null = null;
    if (!item) {
      const stem = name.replace(/\.[^.]+$/, ''), found = recognise(stem);
      if (found === 'ambiguous') note = '文件名对应多个章节';
      else if (found) { item = found; source = 'name'; }
      else if ((item = stated(stem) ?? undefined)) {
        source = 'name';
        note = `Kmoe 上已经没有「${item.name}」这一项，按文件名命名`;
      }
    }
    if (!item && reading && items.has(reading.item)) { item = items.get(reading.item); source = 'ai'; }
    const confidence = source === 'ai' ? reading!.confidence : null;
    if (!item) { plans.push({ name, to: null, item: null, source: null, confidence: null, note: note ?? '认不出是哪一卷或哪一话', named: false }); continue; }
    const to = renderRule(input.rule, { title: input.title, author: input.authors, filename: kmoeFilename(input.title, item.name), bookname: item.name, ext: extOf(name), date: input.date });
    const named = nfc(to) === nfc(name) || follows(name, item);
    plans.push({ name, to: named ? name : to, item: item.name, source, confidence, note, named });
  }

  const groups = (key: (plan: Planned) => string | null) => {
    const found = new Map<string, Planned[]>();
    for (const plan of plans) { const value = key(plan); if (value !== null) found.set(value, [...found.get(value) ?? [], plan]); }
    return [...found.values()].filter(group => group.length > 1);
  };
  // Two files of one item and format: one already named keeps its name, the others stay as they are.
  for (const group of groups(plan => plan.item === null ? null : `${plan.item}\n${extOf(plan.name)}`)) {
    const keeper = group.find(plan => plan.named);
    for (const plan of group) if (plan !== keeper) {
      plan.to = null;
      plan.note = keeper ? `和「${keeper.name}」是同一项，可能是重复的文件` : `有 ${group.length} 个文件都是「${plan.item}」，请先处理重复的文件`;
    }
  }
  // Different items the rule names alike (a rule without {bookname} or {filename}): none of them is renamed.
  for (const group of groups(plan => plan.to && !plan.named ? same(plan.to) : null)) {
    for (const plan of group) { plan.to = null; plan.note = `命名规则会给 ${group.length} 个文件同一个名字`; }
  }
  // A name another entry has is free only once that entry moves away first; names that would have to be swapped are left alone.
  const taken = new Map(input.entries.map(entry => [same(entry.name), entry.name]));
  for (let changed = true; changed;) {
    changed = false;
    const moving = new Map(plans.filter(plan => plan.to && !plan.named).map(plan => [same(plan.name), plan]));
    for (const plan of moving.values()) {
      // Left alone earlier in this pass (the next pass sees it as staying).
      if (!plan.to) continue;
      const target = same(plan.to), occupant = taken.get(target);
      if (occupant === undefined || target === same(plan.name)) continue;
      let next = moving.get(target), cycle = false;
      for (let steps = 0; next?.to && !cycle && steps <= moving.size; steps++) {
        cycle = same(next.to) === same(plan.name);
        next = moving.get(same(next.to));
      }
      if (moving.get(target)?.to && !cycle) continue;
      if (!cycle) { plan.to = null; plan.note = `已有同名的「${occupant}」`; }
      // Every file in the ring stays.
      else for (let member: Planned | undefined = plan; member?.to;) {
        const following = moving.get(same(member.to));
        member.to = null;
        member.note = '几个文件要互换名字，请手动改名';
        member = following;
      }
      changed = true;
    }
  }
  return {
    named: plans.filter(plan => plan.named).length,
    files: plans.filter(plan => !plan.named).map(({ named: _, ...file }) => file),
  };
}

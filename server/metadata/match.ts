// Bangumi matching for one library folder: search a few keywords, resolve single-volume hits to their series, score every
// candidate by title, author and volume count, and auto-accept only a clear winner. Everything else becomes a suggestion.
import type { BangumiCandidate } from '@shared/model';
import { creators, editions, infobox, subjectDto, type BangumiApi, type BgmSubject } from './bangumi';
import { fold, isVolumeName, mainTitle, surname, titleParts, titleSimilarity, volumeBase } from './text';

export interface MatchInput {
  /** Titles to search and compare, best first: Kmoe title, file-name hint, folder name … (≤ 3 are searched). */
  keywords: string[];
  /** Authors of the linked Kmoe comic (empty when not linked). */
  authors: string[];
  /** Volumes on disk / on Kmoe, for the volume-count sanity check. */
  localVolumes: number | null;
}
/** match = an author name agrees; partial = same two-character surname (矢澤愛 / 矢沢あい); mismatch = both known, none agree. */
export type AuthorEvidence = 'match' | 'partial' | 'mismatch' | 'unknown';
/** score: 0–1 for display; raw: uncapped (title + author bonus − penalties), used to rank; title: best title similarity. */
export interface Scored { subject: BgmSubject; score: number; raw: number; title: number; author: AuthorEvidence }
export interface MatchOutcome { state: 'matched' | 'suggested' | 'unmatched'; subject: BgmSubject | null; candidates: BangumiCandidate[] }

/** Auto-accept needs this score (and this title similarity), plus author evidence or this lead over the runner-up. */
export const AUTO_SCORE = 0.85, AUTO_TITLE = 0.8, AUTO_MARGIN = 0.1;
const SUGGEST_SCORE = 0.5, LIST_SCORE = 0.3, MAX_SEARCHES = 3, MAX_VOLUME_LOOKUPS = 2;

function names(subject: BgmSubject): string[] {
  const list = [subject.name, subject.name_cn ?? '', ...infobox(subject, '中文名'), ...infobox(subject, '别名')];
  for (const { fields } of editions(subject)) list.push(fields['版本名'] ?? '', fields['别名'] ?? '');
  return [...new Set(list.map(name => name.trim()).filter(Boolean))];
}

export function authorEvidence(authors: string[], subject: BgmSubject): AuthorEvidence {
  const ours = authors.flatMap(name => name.split(/[、,，/／]/)).map(fold).filter(name => Array.from(name).length >= 2);
  if (!ours.length) return 'unknown';
  const credited = [...creators(subject), ...subject.credits_cn ?? []].map(fold).filter(Boolean);
  // Tags often carry the Chinese form of a name (矢泽爱 for 矢沢あい): good positive evidence, never counted against.
  const tagged = new Set((subject.tags ?? []).map(tag => fold(tag.name)));
  if (ours.some(name => credited.includes(name) || tagged.has(name))) return 'match';
  if (ours.some(name => { const family = surname(name); return family !== null && credited.some(other => surname(other) === family); })) return 'partial';
  return credited.length ? 'mismatch' : 'unknown';
}

/** A title and weaker readings of it: without subtitle/reading (0.95), its Latin or Chinese half (0.9). */
function variants(text: string, subtitles: boolean): [string, number][] {
  const main = subtitles ? mainTitle(text) : null;
  return [[text, 1], ...(main ? [[main, 0.95] as [string, number]] : []), ...titleParts(text).map(part => [part, 0.9] as [string, number])];
}

export function scoreSubject(subject: BgmSubject, input: MatchInput): Scored {
  let title = 0;
  const ours = input.keywords.flatMap(keyword => variants(keyword, false));
  for (const name of names(subject)) {
    for (const [theirs, weight] of variants(name, true)) for (const [mine, own] of ours) title = Math.max(title, weight * own * titleSimilarity(mine, theirs));
  }
  const author = authorEvidence(input.authors, subject);
  let score = title + { match: 0.1, partial: 0.05, mismatch: -0.15, unknown: 0 }[author];
  if (subject.platform === '小说') score -= 0.1;
  else if (subject.platform && subject.platform !== '漫画') score -= 0.15;
  // A single volume of a longer work ("NANA -ナナ- (11)") is never the work itself.
  if (!subject.series && isVolumeName(subject.name)) score -= 0.2;
  const volumes = subject.volumes && subject.volumes > 0 ? subject.volumes : subject.series ? null : 1;
  if (volumes && input.localVolumes && input.localVolumes > volumes * 1.5 + 2) score -= 0.1;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return { subject, author, title: round(title), raw: round(score), score: round(Math.min(1, Math.max(0, score))) };
}

export function decide(scored: Scored[]): MatchOutcome {
  const ranked = [...scored].sort((a, b) => b.raw - a.raw || Number(Boolean(b.subject.series)) - Number(Boolean(a.subject.series)));
  const [top, runnerUp] = ranked;
  const candidates = ranked.filter(entry => entry.raw >= LIST_SCORE).slice(0, 5).map(entry => ({ ...subjectDto(entry.subject), score: entry.score }));
  if (!top || top.raw < SUGGEST_SCORE) return { state: 'unmatched', subject: null, candidates };
  const margin = top.raw - (runnerUp?.raw ?? 0);
  const evidence = top.author === 'match' || top.author === 'partial';
  const volume = !top.subject.series && isVolumeName(top.subject.name);
  const clear = !volume && top.raw >= AUTO_SCORE && top.title >= AUTO_TITLE && (evidence ? margin > 0.02 : margin >= AUTO_MARGIN);
  return clear ? { state: 'matched', subject: top.subject, candidates } : { state: 'suggested', subject: null, candidates };
}

/** The series a single-volume subject belongs to ("系列" relation), if Bangumi links one. */
async function seriesOf(client: BangumiApi, volume: BgmSubject, signal?: AbortSignal): Promise<BgmSubject | null> {
  const parent = (await client.related(volume.id, signal)).find(entry => entry.relation === '系列');
  return parent ? client.subject(parent.id, signal) : null;
}

export async function findSubject(client: BangumiApi, input: MatchInput, signal?: AbortSignal): Promise<MatchOutcome> {
  const scored = new Map<number, Scored>();
  const volumeGroups = new Set<string>();
  let lookups = 0;
  let outcome: MatchOutcome = { state: 'unmatched', subject: null, candidates: [] };
  for (const keyword of input.keywords.slice(0, MAX_SEARCHES)) {
    const hits = await client.search(keyword, signal);
    const known = new Set([...hits.filter(hit => hit.series), ...[...scored.values()].map(entry => entry.subject)].map(subject => fold(subject.name)));
    for (const hit of hits) {
      let subject = hit;
      if (!hit.series && isVolumeName(hit.name)) {
        // "NANA -ナナ- (11)": one lookup per work finds the series entry; its other volumes are skipped.
        const group = fold(volumeBase(hit.name));
        if (volumeGroups.has(group) || known.has(group)) continue;
        volumeGroups.add(group);
        if (lookups < MAX_VOLUME_LOOKUPS) { lookups++; subject = await seriesOf(client, hit, signal) ?? hit; }
      }
      if (!scored.has(subject.id)) scored.set(subject.id, scoreSubject(subject, input));
    }
    outcome = decide([...scored.values()]);
    if (outcome.state === 'matched') break;
  }
  return outcome;
}

// Bangumi's raw wiki (infobox) text → the API's infobox shape ([{ key, value: string | [{ k?, v }] }]).
// Written from the syntax description in bangumi/wiki-syntax-spec; lenient, because dump data is user-entered.
import type { BgmInfobox } from './bangumi';

/**
 * "{{Infobox Type\n|key= value\n|list={\n[v]\n[k|v]\n}\n}}": fields start with "|", split at the first "=",
 * a value of "{" opens a list closed by a lone "}". Unclosed lists end at the next field; stray lines extend the last value.
 */
export function parseWiki(text: string | null | undefined): BgmInfobox[] {
  const lines = (text ?? '').split(/\r?\n/);
  let index = lines.findIndex(line => line.trimStart().startsWith('{{Infobox'));
  if (index < 0) return [];
  const fields: BgmInfobox[] = [];
  let list: { k?: string; v: string }[] | null = null;
  for (index++; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (list) {
      if (line === '}') { list = null; continue; }
      if (!line) continue;
      if (line.startsWith('[')) {
        const inner = line.slice(1, line.endsWith(']') ? -1 : undefined);
        const bar = inner.indexOf('|');
        list.push(bar < 0 ? { v: inner.trim() } : { k: inner.slice(0, bar).trim(), v: inner.slice(bar + 1).trim() });
        continue;
      }
      if (!line.startsWith('|') && line !== '}}') continue;
      list = null;
    }
    if (line === '}}') break;
    if (line.startsWith('|')) {
      const equals = line.indexOf('=');
      const key = (equals < 0 ? line.slice(1) : line.slice(1, equals)).trim();
      const value = equals < 0 ? '' : line.slice(equals + 1).trim();
      if (value === '{') fields.push({ key, value: list = [] });
      else fields.push({ key, value });
      continue;
    }
    const last = fields.at(-1);
    if (line && last && typeof last.value === 'string') last.value = last.value ? `${last.value}\n${line}` : line;
  }
  return fields;
}

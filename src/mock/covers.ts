// Placeholder covers for demo data: printed-manga compositions as SVG data URIs (no hotlinking).
const INKS = ['#c8472a', '#2f4a6d', '#3d6b5a', '#a97a24', '#7a3b5c', '#33363d', '#8a5a3c', '#4f6f8f'];
const PAPER = '#f4efe6';
const INK = '#1f2127';

export function hash(text: string): number {
  let h = 2166136261;
  for (const char of text) { h ^= char.codePointAt(0)!; h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const escape = (text: string) => text.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

export function coverFor(title: string, seed: string): string {
  const h = hash(seed);
  const ink = INKS[h % INKS.length]!;
  const glyph = escape(Array.from(title.trim())[0] ?? '?');
  const name = escape(Array.from(title).slice(0, 9).join(''));
  const serif = `font-family="'Songti SC','Noto Serif CJK SC','Source Han Serif SC','SimSun',serif" font-weight="700"`;
  const sans = `font-family="'PingFang SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif" font-weight="600"`;
  const dots = `<pattern id="d" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="3.5" cy="3.5" r="1.3" fill="${INK}" fill-opacity=".14"/></pattern>`;
  const layouts = [
    // Seal sun over screentone.
    `<rect width="240" height="320" fill="${PAPER}"/><rect y="150" width="240" height="170" fill="url(#d)"/>
     <circle cx="168" cy="96" r="70" fill="${ink}"/>
     <text x="22" y="262" font-size="128" fill="${INK}" ${serif}>${glyph}</text>`,
    // Ink block with a paper glyph.
    `<rect width="240" height="320" fill="${PAPER}"/><rect width="240" height="206" fill="${ink}"/><rect width="240" height="206" fill="url(#d)"/>
     <text x="120" y="160" font-size="118" text-anchor="middle" fill="${PAPER}" ${serif}>${glyph}</text>`,
    // Diagonal band.
    `<rect width="240" height="320" fill="${PAPER}"/><path d="M0 214 L240 54 L240 150 L0 310 Z" fill="${ink}"/><rect width="240" height="320" fill="url(#d)" opacity=".7"/>
     <text x="200" y="142" font-size="112" text-anchor="end" fill="${INK}" ${serif}>${glyph}</text>`,
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 320"><defs>${dots}</defs>${layouts[(h >>> 5) % layouts.length]}
    <rect x="0" y="282" width="240" height="38" fill="${PAPER}" fill-opacity=".92"/>
    <text x="16" y="307" font-size="17" fill="${INK}" ${sans}>${name}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/\s+/g, ' '))}`;
}

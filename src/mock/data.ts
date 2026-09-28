// Seed data for the in-browser demo server: a small Kmoe catalog and one state per scenario.
import type {
  Activity, AiProvider, AiVerdict, BangumiArchiveStatus, BangumiSource, ContentType, FolderMetadata, Format, Item, KmoeAccount, KmoeCandidate, KmoeLinkState, KomgaLibrary, LibraryJob,
  MetadataOptions, MetadataText, PauseReason, Settings, Source, SourceItem, Subscription, Target, Task,
} from '@shared/model';
import { DEFAULT_RULE, joinPath, renderRule } from '@shared/naming';
import { version } from '../../package.json';
import { coverFor, hash } from './covers';

export type Scenario = 'setup' | 'fresh' | 'full' | 'paused' | 'expired' | 'network';

export interface MockComic {
  key: string;
  title: string;
  authors: string[];
  status: string;
  description: string | null;
  items: Item[];
  /** Revealed one at a time by subscription checks. */
  upcoming: Item[];
  cover: string;
  lastActivityAt: string | null;
  fetchedAt: string;
}

/** A file in a target's library; `unknown` = found but not confirmable (size mismatch). */
type LibraryFile = { path: string; size: number; unknown?: boolean };

/** A series folder found by a library scan (path relative to its target; file names directly inside it). */
export interface MockFolder {
  id: number;
  targetId: number;
  path: string;
  files: string[];
  scannedAt: string;
  kmoe: { state: KmoeLinkState; comicKey: string | null; candidates: KmoeCandidate[]; score: number | null; error: string | null; ai?: AiVerdict | null };
  metadata: FolderMetadata;
  /** AI-tidied summary and tags awaiting review (设置 → AI). */
  polish?: { original: MetadataText; polished: MetadataText; status: 'pending' | 'accepted' | 'rejected'; at: string } | null;
}

export interface MockAi { provider: AiProvider; baseUrl: string; model: string; useProxy: boolean; monthlyTokens: number; key: string | null; tokens: number }

export interface MockMetadata {
  enabled: boolean;
  komga: { url: string; auth: 'apiKey' | 'basic'; username: string; secret: string | null; libraries: { targetId: number; libraryId: string }[] };
  bangumi: {
    token: string | null;
    source: BangumiSource;
    online: { reachable: boolean | null; checkedAt: string | null; error: string | null };
    archive: BangumiArchiveStatus;
  };
  options: MetadataOptions;
}

export interface MockDb {
  auth: { setupRequired: boolean; authenticated: boolean; password: string; csrf: string | null };
  kmoe: KmoeAccount;
  settings: Omit<Settings, 'apiToken'>;
  token: string | null;
  ai: MockAi;
  targets: Target[];
  comics: Map<string, MockComic>;
  subscriptions: Map<string, Subscription>;
  tasks: Task[];
  /** Keyed by `${targetId}|${format}|${itemId}`. */
  library: Map<string, LibraryFile>;
  /** Extra folders and stray files per filesystem ("local" or a WebDAV host). */
  extras: Map<string, string[]>;
  activity: Activity[];
  sources: Source[];
  sourceItems: SourceItem[];
  /** Series folders per target, found by library scans. */
  folders: MockFolder[];
  /** `${comicKey}|${targetId}` → the folder (in the target) the comic lives in, when linked to one. */
  comicFolders: Map<string, string>;
  metadata: MockMetadata;
  job: LibraryJob;
  /** Last finished scan per target (a scan can find no folders). */
  lastScan: Record<number, string>;
  queue: { paused: boolean; reason: PauseReason | null };
  checking: boolean;
  seq: number;
}

export const LIBRARY_ROOT = '/library';
export const MIRRORS = ['kxo.moe', 'kzo.moe', 'mox.moe', 'koz.moe'];
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

type Spec = { key: string; title: string; authors: string[]; status: '連載' | '完結'; volumes: number; extras?: number; serial?: [number, number]; description?: string };

const SHELF: Spec[] = [
  { key: '18488', title: '葬送的芙莉蓮', authors: ['山田鐘人', '阿部司'], status: '連載', volumes: 14, description: '打倒魔王之後，長壽的精靈魔法使芙莉蓮與新的同伴再度啟程，在旅途中一點一點理解人類。' },
  { key: '17930', title: '間諜家家酒', authors: ['遠藤達哉'], status: '連載', volumes: 13, extras: 1, description: '間諜、殺手與超能力者各懷秘密，湊成一個假扮的家庭，只為了各自的任務。' },
  { key: '19012', title: '藥屋少女的呢喃', authors: ['日向夏', 'ねこクラゲ'], status: '連載', volumes: 12, description: '被賣進後宮的藥師少女貓貓，憑著藥學知識一一解開宮中接連發生的怪事。' },
  { key: '15521', title: '迷宮飯', authors: ['九井諒子'], status: '完結', volumes: 14, extras: 1, description: '為了救回被紅龍吞下的妹妹，冒險者們一路以迷宮裡的魔物為食，向更深處前進。' },
  { key: '20113', title: '我推的孩子', authors: ['赤坂アカ', '横槍メンゴ'], status: '完結', volumes: 16, description: '轉生成偶像孩子的少年，在演藝圈的光與影之間追查母親之死的真相。' },
  { key: '16877', title: '鏈鋸人', authors: ['藤本タツキ'], status: '連載', volumes: 20, serial: [190, 205], description: '背負巨額債務的少年與鏈鋸惡魔波奇塔合而為一，成為公安的惡魔獵人。' },
  { key: '19854', title: '膽大黨', authors: ['龍幸伸'], status: '連載', volumes: 18, description: '相信幽靈的少女與相信外星人的少年打了個賭，從此捲入接連不斷的怪異事件。' },
  { key: '18820', title: '怪獸8號', authors: ['松本直也'], status: '完結', volumes: 16, description: '夢想加入防衛隊的怪獸清潔員，某天自己變成了怪獸。' },
  { key: '21207', title: '渣女沒渣報', authors: ['岸川瑞樹'], status: '連載', volumes: 2, serial: [1, 24], description: '兩個人、一段關係，以及那些始終沒說出口的話。' },
  { key: '14502', title: '排球少年!!', authors: ['古舘春一'], status: '完結', volumes: 45, description: '身材矮小卻擁有驚人彈跳力的少年，在球場上一次次追逐頂點。' },
];

const CATALOG: Spec[] = [
  { key: '10001', title: '海賊王', authors: ['尾田栄一郎'], status: '連載', volumes: 110 },
  { key: '17432', title: '咒術迴戰', authors: ['芥見下々'], status: '完結', volumes: 30 },
  { key: '12098', title: '進擊的巨人', authors: ['諫山創'], status: '完結', volumes: 34 },
  { key: '19387', title: '孤獨搖滾！', authors: ['はまじあき'], status: '連載', volumes: 7, description: '極度怕生的吉他少女，被拉進了一支缺人的樂團。' },
  { key: '18011', title: '更衣人偶墜入愛河', authors: ['福田晋一'], status: '完結', volumes: 15 },
  { key: '20598', title: '失憶投捕', authors: ['山田リョウ'], status: '連載', volumes: 11 },
  { key: '19765', title: '地。─關於地球的運動─', authors: ['魚豊'], status: '完結', volumes: 8, description: '在異端審問的時代，有人為了一個關於天空的真理押上性命。' },
  { key: '15874', title: '夏日重現', authors: ['田中靖規'], status: '完結', volumes: 13 },
  { key: '11203', title: '蜂蜜與四葉草', authors: ['羽海野チカ'], status: '完結', volumes: 10 },
  { key: '17120', title: '輝夜姬想讓人告白', authors: ['赤坂アカ'], status: '完結', volumes: 28 },
  { key: '16033', title: '黃金神威', authors: ['野田サトル'], status: '完結', volumes: 31 },
  { key: '18259', title: '夜櫻家的大作戰', authors: ['權平ひつじ'], status: '完結', volumes: 27 },
  { key: '20877', title: '藍色時期', authors: ['山口つばさ'], status: '連載', volumes: 16, description: '什麼都做得不錯卻總覺得空虛的高中生，在一幅畫前第一次心動。' },
  { key: '21004', title: '放學後失眠的你', authors: ['オジロマコト'], status: '完結', volumes: 14 },
  { key: '13301', title: 'GRAND BLUE碧藍之海', authors: ['井上堅二', '吉岡公威'], status: '連載', volumes: 23, description: '進入大學的伊織在潛水店住下，迎接他的是啤酒、裸體與一片湛藍的大海。' },
  { key: '16240', title: 'BLUE GIANT', authors: ['石塚真一'], status: '完結', volumes: 10 },
  { key: '18777', title: 'BLUE GIANT SUPREME', authors: ['石塚真一'], status: '完結', volumes: 11 },
  { key: '20055', title: 'BLUE GIANT EXPLORER', authors: ['石塚真一'], status: '完結', volumes: 9 },
  { key: '22150', title: 'JOJO的奇妙冒險 第9部 JOJOLands', authors: ['荒木飛呂彥'], status: '連載', volumes: 5 },
  { key: '11877', title: 'JOJO的奇妙冒險 第7部 STEEL BALL RUN', authors: ['荒木飛呂彥'], status: '完結', volumes: 24 },
  { key: '15123', title: '鬼滅之刃', authors: ['吾峠呼世晴'], status: '完結', volumes: 23 },
];

/**
 * The NAS library as it was before Kmoe Sync: series folders under the library root, files named "書名-卷 01.epub".
 * Present in every scenario (the disk does not depend on the app), found by 书库 › 扫描书库.
 */
const LEGACY: { path: string; books?: number; ext?: Format; files?: string[] }[] = [
  { path: '/GRAND BLUE 碧藍之海', books: 23 }, { path: '/海賊王', books: 105 }, { path: '/咒術迴戰', books: 30 }, { path: '/進擊的巨人', books: 34 },
  { path: '/孤獨搖滾！', books: 7 }, { path: '/黃金神威', books: 31 }, { path: '/藍色時期', books: 15 }, { path: '/失憶投捕', books: 11 },
  { path: '/放學後失眠的你', books: 14 }, { path: '/BLUE GIANT', books: 10 }, { path: '/地。─關於地球的運動─', books: 8 },
  { path: '/更衣人偶墜入愛河 完結', books: 15 }, { path: '/輝夜姬想讓人告白～天才們的戀愛頭腦戰～', books: 28 }, { path: '/夏日重現 Summer Time Rendering', books: 13 },
  { path: '/夜櫻家大作戰', books: 27 }, { path: '/藍色巨星 BLUE GIANT SUPREME', books: 11 },
  { path: '/JOJO的奇妙冒險/JOJO的奇妙冒險-JOJO Lands', books: 4 }, { path: '/JOJO的奇妙冒險/JOJO的奇妙冒險-STEEL BALL RUN', books: 24 },
  { path: '/蜂蜜幸運草', books: 10 }, { path: '/銀之匙 Silver Spoon', books: 15 }, { path: '/惡之華', books: 11, ext: 'mobi' }, { path: '/寄生獸 完全版', books: 8 },
  { path: '/火之鳥', books: 12 }, { path: '/AKIRA', books: 6 }, { path: '/棋靈王', books: 23, ext: 'mobi' }, { path: '/20世紀少年', books: 22 },
  { path: '/BLUE GIANT EXPLORER', books: 9 }, { path: '/鬼滅之刃', books: 23 }, { path: '/蟲師', books: 10 },
  { path: '/_待整理', files: ['IMG_2024.epub', 'scan_0012.epub', '未命名.mobi', 'readme.txt'] },
  { path: '/Magazines/週刊少年Jump 2024', files: Array.from({ length: 12 }, (_, i) => `週刊少年Jump 2024年${i + 1}號.mobi`) },
];
export const LEGACY_FILES = LEGACY.flatMap(({ path, books = 0, ext = 'epub', files }) => {
  const title = path.slice(path.lastIndexOf('/') + 1), width = books >= 100 ? 3 : 2;
  return (files ?? Array.from({ length: books }, (_, i) => `${title}-卷 ${String(i + 1).padStart(width, '0')}.${ext}`)).map(name => `${path}/${name}`);
});

/** Bangumi subjects the demo knows; `aliases` are the (traditional Chinese) titles folders and Kmoe use. */
export type BangumiEntry = { id: number; name: string; nameCn: string; date: string; volumes: number | null; authors: string[]; aliases: string[]; platform?: string; series?: boolean };
export const BANGUMI: BangumiEntry[] = [
  { id: 305226, name: '葬送のフリーレン', nameCn: '葬送的芙莉莲', date: '2020-08-18', volumes: 14, authors: ['山田鐘人', 'アベツカサ'], aliases: ['葬送的芙莉蓮'] },
  { id: 305227, name: '葬送のフリーレン (1)', nameCn: '葬送的芙莉莲 (1)', date: '2020-08-18', volumes: null, authors: ['山田鐘人', 'アベツカサ'], aliases: ['葬送的芙莉蓮 1'], series: false },
  { id: 247451, name: '薬屋のひとりごと', nameCn: '药屋少女的呢喃', date: '2017-09-25', volumes: 12, authors: ['日向夏', 'ねこクラゲ'], aliases: ['藥屋少女的呢喃'] },
  { id: 101958, name: 'ダンジョン飯', nameCn: '迷宫饭', date: '2015-01-15', volumes: 14, authors: ['九井諒子'], aliases: ['迷宮飯'] },
  { id: 263434, name: '【推しの子】', nameCn: '我推的孩子', date: '2020-07-17', volumes: 16, authors: ['赤坂アカ', '横槍メンゴ'], aliases: ['我推的孩子'] },
  { id: 316386, name: 'ダンダダン', nameCn: '胆大党', date: '2021-08-04', volumes: 18, authors: ['龍幸伸'], aliases: ['膽大黨'] },
  { id: 302187, name: '怪獣8号', nameCn: '怪兽8号', date: '2020-12-04', volumes: 16, authors: ['松本直也'], aliases: ['怪獸8號'] },
  { id: 44652, name: 'ハイキュー!!', nameCn: '排球少年!!', date: '2012-06-04', volumes: 45, authors: ['古舘春一'], aliases: ['排球少年!!'] },
  { id: 225604, name: 'SPY×FAMILY', nameCn: '间谍过家家', date: '2019-07-04', volumes: 13, authors: ['遠藤達哉'], aliases: ['間諜家家酒'] },
  { id: 227213, name: 'チェンソーマン', nameCn: '电锯人', date: '2019-03-04', volumes: 20, authors: ['藤本タツキ'], aliases: ['鏈鋸人'] },
  { id: 350221, name: 'クズ女に報いを', nameCn: '渣女没渣报', date: '2022-04-12', volumes: 2, authors: ['岸川瑞樹'], aliases: ['渣女沒有渣報'] },
  { id: 1628, name: 'ONE PIECE', nameCn: '海贼王', date: '1997-12-24', volumes: 110, authors: ['尾田栄一郎'], aliases: ['海賊王', '航海王'] },
  { id: 226498, name: '呪術廻戦', nameCn: '咒术回战', date: '2018-07-04', volumes: 30, authors: ['芥見下々'], aliases: ['咒術迴戰'] },
  { id: 4946, name: '進撃の巨人', nameCn: '进击的巨人', date: '2010-03-17', volumes: 34, authors: ['諫山創'], aliases: ['進擊的巨人'] },
  { id: 238616, name: 'ぼっち・ざ・ろっく！', nameCn: '孤独摇滚！', date: '2019-02-27', volumes: 7, authors: ['はまじあき'], aliases: ['孤獨搖滾！'] },
  { id: 117766, name: 'ゴールデンカムイ', nameCn: '黄金神威', date: '2015-01-19', volumes: 31, authors: ['野田サトル'], aliases: ['黃金神威'] },
  { id: 201306, name: 'ブルーピリオド', nameCn: '蓝色时期', date: '2017-12-22', volumes: 16, authors: ['山口つばさ'], aliases: ['藍色時期'] },
  { id: 227311, name: '忘却バッテリー', nameCn: '失忆投捕', date: '2016-10-04', volumes: 11, authors: ['みかわ絵子'], aliases: ['失憶投捕'] },
  { id: 275734, name: '君は放課後インソムニア', nameCn: '放学后失眠的你', date: '2019-09-09', volumes: 14, authors: ['オジロマコト'], aliases: ['放學後失眠的你'] },
  { id: 94421, name: 'ぐらんぶる', nameCn: 'GRAND BLUE 碧蓝之海', date: '2014-04-07', volumes: 23, authors: ['井上堅二', '吉岡公威'], aliases: ['GRAND BLUE碧藍之海', '碧藍之海'] },
  { id: 102376, name: 'BLUE GIANT', nameCn: '蓝色巨星', date: '2013-12-27', volumes: 10, authors: ['石塚真一'], aliases: ['BLUE GIANT', '藍色巨星'] },
  { id: 193544, name: 'BLUE GIANT SUPREME', nameCn: '蓝色巨星 SUPREME', date: '2017-01-30', volumes: 11, authors: ['石塚真一'], aliases: ['BLUE GIANT SUPREME'] },
  { id: 304019, name: 'BLUE GIANT EXPLORER', nameCn: '蓝色巨星 EXPLORER', date: '2020-10-30', volumes: 9, authors: ['石塚真一'], aliases: ['BLUE GIANT EXPLORER'] },
  { id: 318355, name: 'チ。―地球の運動について―', nameCn: '地。～关于地球的运动～', date: '2020-12-28', volumes: 8, authors: ['魚豊'], aliases: ['地。─關於地球的運動─'] },
  { id: 243718, name: 'その着せ替え人形は恋をする', nameCn: '更衣人偶坠入爱河', date: '2018-05-25', volumes: 15, authors: ['福田晋一'], aliases: ['更衣人偶墜入愛河'] },
  { id: 139520, name: 'かぐや様は告らせたい～天才たちの恋愛頭脳戦～', nameCn: '辉夜大小姐想让我告白～天才们的恋爱头脑战～', date: '2016-03-18', volumes: 28, authors: ['赤坂アカ'], aliases: ['輝夜姬想讓人告白', '輝夜姬想讓人告白～天才們的戀愛頭腦戰～'] },
  { id: 187391, name: 'サマータイムレンダ', nameCn: '夏日重现', date: '2017-10-23', volumes: 13, authors: ['田中靖規'], aliases: ['夏日重現'] },
  { id: 311020, name: 'サマータイムレンダ 小説版', nameCn: '夏日重现 小说版', date: '2022-04-04', volumes: 2, authors: ['田中靖規', '田口仙年堂'], aliases: ['夏日重現 小說版'], platform: '小说' },
  { id: 280117, name: '夜桜さんちの大作戦', nameCn: '夜樱家的大作战', date: '2019-08-26', volumes: 27, authors: ['権平ひつじ'], aliases: ['夜櫻家的大作戰'] },
  { id: 381256, name: 'The JOJOLands', nameCn: 'JOJO的奇妙冒险 第9部 JOJOLands', date: '2023-02-17', volumes: 5, authors: ['荒木飛呂彦'], aliases: ['JOJO的奇妙冒險 第9部 JOJOLands'] },
  { id: 11546, name: 'ジョジョリオン', nameCn: 'JOJO的奇妙冒险 第8部 JOJOLion', date: '2011-05-19', volumes: 27, authors: ['荒木飛呂彦'], aliases: ['JOJO的奇妙冒險 第8部 JOJOLion'] },
  { id: 3413, name: 'スティール・ボール・ラン', nameCn: '飙马野郎', date: '2004-01-19', volumes: 24, authors: ['荒木飛呂彦'], aliases: ['JOJO的奇妙冒險 第7部 STEEL BALL RUN', 'STEEL BALL RUN'] },
  { id: 173623, name: '鬼滅の刃', nameCn: '鬼灭之刃', date: '2016-06-03', volumes: 23, authors: ['吾峠呼世晴'], aliases: ['鬼滅之刃'] },
  { id: 10366, name: 'ハチミツとクローバー', nameCn: '蜂蜜与四叶草', date: '2000-07-05', volumes: 10, authors: ['羽海野チカ'], aliases: ['蜂蜜與四葉草', '蜂蜜幸運草'] },
  { id: 26283, name: '銀の匙 Silver Spoon', nameCn: '银之匙', date: '2011-06-17', volumes: 15, authors: ['荒川弘'], aliases: ['銀之匙 Silver Spoon'] },
  { id: 4327, name: '惡の華', nameCn: '恶之华', date: '2010-03-09', volumes: 11, authors: ['押見修造'], aliases: ['惡之華'] },
  { id: 10442, name: '寄生獣', nameCn: '寄生兽', date: '1990-06-25', volumes: 10, authors: ['岩明均'], aliases: ['寄生獸'] },
  { id: 58003, name: '寄生獣 完全版', nameCn: '寄生兽 完全版', date: '2003-01-23', volumes: 8, authors: ['岩明均'], aliases: ['寄生獸 完全版'] },
  { id: 5623, name: 'AKIRA', nameCn: '阿基拉', date: '1984-09-14', volumes: 6, authors: ['大友克洋'], aliases: ['AKIRA'] },
  { id: 3584, name: 'ヒカルの碁', nameCn: '棋魂', date: '1999-05-06', volumes: 23, authors: ['ほったゆみ', '小畑健'], aliases: ['棋靈王', '棋魂'] },
];

/** Libraries of the demo Komga server. */
export const KOMGA_LIBRARIES: KomgaLibrary[] = [{ id: '0KMG1', name: '漫画', root: '/comic' }, { id: '0KMG2', name: 'Kindle', root: '/comic/Kindle' }];
const METADATA_OPTIONS: MetadataOptions = { titleLanguage: 'cn', books: true, posters: 'series', lock: true, autoSync: true, tagLimit: 10 };

/** The newest Bangumi Archive dump (weekly; the demo's is five days old): its file name and export time. */
export function latestDump() {
  const date = new Date(Date.now() - 5 * 864e5);
  date.setUTCHours(21, 3, 41, 0);
  return { name: `dump-${date.toISOString().slice(0, 10)}.210341Z.zip`, date: date.toISOString() };
}
export const NO_ARCHIVE: BangumiArchiveStatus = { state: 'none', dump: null, dumpDate: null, importedAt: null, subjects: 0, progress: null, error: null, checkedAt: null };

/** Invented titles for keys that are not in the catalog (pasted links). */
const UNKNOWN_TITLES = ['海風與燈塔', '月下舊書店', '雨宿咖啡館', '星屑郵便局', '北方的鯨', '紙飛機與夏天'];

function rng(seed: string) {
  let state = hash(seed) || 1;
  return () => { state = Math.imul(state ^ (state >>> 15), 2246822507) ^ Math.imul(state ^ (state >>> 13), 3266489909); return ((state >>>= 0) % 10_000) / 10_000; };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
function item(key: string, type: ContentType, n: number, random: () => number): Item {
  const volume = type !== 'serial';
  const epub = Math.round((volume ? 42 + random() * 50 : 8 + random() * 6) * 10) / 10;
  return {
    id: `${key}-${type[0]}${n}`,
    type,
    name: type === 'volume' ? `卷 ${pad(n)}` : type === 'extra' ? `番外 ${pad(n)}` : `話 ${pad(n, 3)}`,
    order: n,
    pages: volume ? 176 + Math.round(random() * 40) : 18 + Math.round(random() * 8),
    sizeMB: { epub, mobi: Math.round(epub * 1.14 * 10) / 10 },
    isNew: false,
  };
}

function comicFrom(spec: Spec): MockComic {
  const random = rng(spec.key);
  const items: Item[] = [];
  for (let n = 1; n <= spec.volumes; n++) items.push(item(spec.key, 'volume', n, random));
  for (let n = 1; n <= (spec.extras ?? 0); n++) items.push(item(spec.key, 'extra', n, random));
  if (spec.serial) for (let n = spec.serial[0]; n <= spec.serial[1]; n++) items.push(item(spec.key, 'serial', n, random));
  return {
    key: spec.key, title: spec.title, authors: spec.authors, status: spec.status, description: spec.description ?? null,
    items, upcoming: [], cover: coverFor(spec.title, spec.key), lastActivityAt: null, fetchedAt: ago(30),
  };
}

export function unknownComic(key: string): MockComic {
  const random = rng(key);
  const title = UNKNOWN_TITLES[hash(key) % UNKNOWN_TITLES.length]!;
  return comicFrom({ key, title, authors: ['佚名'], status: random() > 0.5 ? '連載' : '完結', volumes: 3 + Math.floor(random() * 9) });
}

export const latestLabel = (comic: MockComic) => {
  const last = comic.items.filter(i => i.type !== 'extra').sort((a, b) => (a.type === b.type ? (a.order ?? 0) - (b.order ?? 0) : a.type === 'serial' ? 1 : -1)).at(-1);
  return last?.name ?? null;
};

export const libraryKey = (targetId: number, format: Format, itemId: string) => `${targetId}|${format}|${itemId}`;

/** Where a chapter lands in a target, with the target's naming rule (relative to the library root for local targets). */
export function filePath(target: Target, comic: MockComic, entry: Item, format: Format): string {
  const bookname = entry.name;
  return joinPath(target.path, renderRule(target.rule, { title: comic.title, filename: `[Kmoe][${comic.title}]${bookname.replace(/\s/g, '')}`, bookname, author: comic.authors, ext: format }));
}

const DEFAULT_SETTINGS: MockDb['settings'] = {
  checkIntervalHours: 6, concurrency: 2, autoRetry: true, maxRetries: 3, quotaReserveMB: 500,
  defaultFormat: 'epub', defaultLine: 0, defaultTargetId: 1, preferredMirror: 'kxo.moe', notifications: [], proxy: '', proxyKmoe: false,
};

const LOCAL_TARGET: Target = { id: 1, kind: 'local', name: '本地书库', path: '/', url: null, username: null, hasPassword: false, rule: DEFAULT_RULE, isDefault: true, createdAt: ago(60 * 24 * 30) };

function emptyDb(): MockDb {
  return {
    auth: { setupRequired: false, authenticated: true, password: 'demo1234', csrf: 'mock-csrf' },
    kmoe: { state: 'none', email: null, mirror: null, level: null, vip: null, free: null, vipQuota: null, remainingMB: null, checkedAt: null, error: null, throttledUntil: null },
    settings: structuredClone(DEFAULT_SETTINGS),
    token: null,
    ai: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', useProxy: false, monthlyTokens: 0, key: null, tokens: 0 },
    targets: [structuredClone(LOCAL_TARGET)],
    comics: new Map([...SHELF, ...CATALOG].map(spec => [spec.key, comicFrom(spec)])),
    subscriptions: new Map(),
    tasks: [],
    library: new Map(),
    extras: new Map([['local', ['/_待整理/', '/Magazines/', ...LEGACY_FILES]]]),
    activity: [{ id: 1, kind: 'info', level: 'info', title: 'Kmoe Sync 已启动', detail: `版本 ${version}`, comicKey: null, createdAt: ago(3) }],
    sources: [],
    sourceItems: [],
    folders: [],
    comicFolders: new Map(),
    metadata: {
      enabled: false, komga: { url: '', auth: 'apiKey', username: '', secret: null, libraries: [] },
      bangumi: { token: null, source: 'auto', online: { reachable: null, checkedAt: null, error: null }, archive: { ...NO_ARCHIVE } },
      options: { ...METADATA_OPTIONS },
    },
    job: { kind: null, running: false, targetId: null, done: 0, total: 0, current: null, error: null, cancelled: false, startedAt: null, finishedAt: null },
    lastScan: {},
    queue: { paused: false, reason: null },
    checking: false,
    seq: 100,
  };
}

export function seed(scenario: Scenario): MockDb {
  const db = emptyDb();
  if (scenario === 'setup') { db.auth = { ...db.auth, setupRequired: true, authenticated: false, password: '', csrf: null }; return db; }
  if (scenario === 'fresh') return db;
  seedLibrary(db, scenario);
  return db;
}

function seedLibrary(db: MockDb, scenario: Exclude<Scenario, 'setup' | 'fresh'>) {
  const paused = scenario === 'paused', expired = scenario === 'expired', network = scenario === 'network';
  // The demo shows the AI features set up (a canned model; nothing leaves the browser).
  db.ai = { ...db.ai, key: 'demo', tokens: 12_345 };
  db.kmoe = {
    state: expired ? 'expired' : 'active', email: 'reader@example.com', mirror: 'kxo.moe', level: 3, vip: true,
    free: { totalMB: 1024, usedMB: paused ? 1000 : 820, resetDay: 1 },
    vipQuota: { totalMB: 5120, usedMB: paused ? 4700 : 3740, resetDay: 1 },
    remainingMB: paused ? 444 : 1584,
    checkedAt: ago(6), error: expired ? 'Kmoe 会话已过期，请重新登录' : null, throttledUntil: null,
  };
  if (paused) db.queue = { paused: true, reason: 'quota' };
  if (expired) db.queue = { paused: true, reason: 'auth' };
  if (network) db.queue = { paused: true, reason: 'network' };
  // Komga already runs next to the library (the user's former BangumiKomga setup): two libraries, two targets mapped.
  db.metadata = {
    enabled: true, komga: { url: 'http://nas.local:25600', auth: 'apiKey', username: '', secret: 'demo-komga-api-key', libraries: [{ targetId: 1, libraryId: '0KMG1' }, { targetId: 3, libraryId: '0KMG2' }] },
    // bgm.tv is blocked on this NAS; last week's offline dump is imported and carries the matching.
    bangumi: {
      token: null, source: 'auto',
      online: { reachable: false, checkedAt: ago(12), error: '连接被重置（ECONNRESET），网络可能屏蔽了 Bangumi' },
      archive: { state: 'ready', dump: latestDump().name, dumpDate: latestDump().date, importedAt: ago(60 * 24 * 5 - 150), subjects: 123_456, progress: null, error: null, checkedAt: ago(70) },
    },
    options: { ...METADATA_OPTIONS },
  };
  db.settings = {
    ...db.settings, maxRetries: 4,
    notifications: [
      { id: 'ch-bark', kind: 'bark', name: 'iPhone', server: 'https://api.day.app', key: 'x7Kq9mP2LwD', events: ['new_items', 'download_failed', 'session_expired', 'quota_low'], enabled: true },
      { id: 'ch-hook', kind: 'webhook', name: 'Home Assistant', url: 'http://homeassistant.local:8123/api/webhook/kmoesync', events: ['download_done', 'download_failed'], enabled: false },
    ],
  };
  db.token = 'kms_demo_token_not_shown';
  db.targets.push(
    { id: 2, kind: 'webdav', name: 'NAS WebDAV', path: '/Comics', url: 'https://nas.local:5006/dav', username: 'reader', hasPassword: true, rule: DEFAULT_RULE, isDefault: false, createdAt: ago(60 * 24 * 20) },
    { id: 3, kind: 'local', name: 'Kindle 同步', path: '/Kindle', url: null, username: null, hasPassword: false, rule: '{author$0}/{title}/{bookname}', isDefault: false, createdAt: ago(60 * 24 * 12) },
  );
  db.extras.set('nas.local:5006', ['/Books/', '/Photos/', '/Comics/_inbox/']);
  db.extras.set('local', ['/_待整理/', '/Magazines/', '/Kindle/', '/迷宮飯/迷宮飯 設定資料集.pdf', ...LEGACY_FILES]);

  // Upcoming chapters that "立即检查" can discover.
  for (const [key, count] of [['18488', 1], ['19012', 1], ['19854', 1]] as const) {
    const comic = db.comics.get(key)!;
    const random = rng(`${key}-next`);
    const last = comic.items.filter(i => i.type === 'volume').length;
    for (let n = 1; n <= count; n++) comic.upcoming.push(item(key, 'volume', last + n, random));
  }

  const target = (id: number) => db.targets.find(t => t.id === id)!;
  const sub = (key: string, patch: Partial<Subscription>): void => {
    db.subscriptions.set(key, {
      id: db.subscriptions.size + 1, comicKey: key, enabled: true, types: ['volume'], format: 'epub', targetId: 1, strategy: 'future', line: 0,
      lastCheckAt: ago(95), lastSuccessAt: ago(95), nextCheckAt: new Date(now + 265 * 60_000).toISOString(), error: null, createdAt: ago(60 * 24 * 14), ...patch,
    });
  };
  sub('18488', {});
  sub('17930', { types: ['volume', 'extra'], targetId: 2, strategy: 'backfill' });
  sub('19012', {});
  sub('20113', { enabled: false, nextCheckAt: null });
  sub('16877', { types: ['serial'], targetId: 2 });
  sub('19854', { format: 'mobi', error: '检查失败：Kmoe 暂时无法访问（HTTP 503），下次检查时会重试', lastSuccessAt: ago(60 * 26) });
  sub('21207', { types: ['serial'] });

  const store = (key: string, targetId: number, format: Format, pick: (entry: Item) => boolean, unknown?: (entry: Item) => boolean) => {
    const comic = db.comics.get(key)!;
    for (const entry of comic.items.filter(pick)) {
      db.library.set(libraryKey(targetId, format, entry.id), { path: filePath(target(targetId), comic, entry, format), size: (entry.sizeMB[format] ?? 0) * 1024 ** 2, unknown: unknown?.(entry) });
    }
  };
  const vol = (max: number, min = 1) => (entry: Item) => entry.type === 'volume' && (entry.order ?? 0) >= min && (entry.order ?? 0) <= max;
  const ser = (max: number, min = 0) => (entry: Item) => entry.type === 'serial' && (entry.order ?? 0) >= min && (entry.order ?? 0) <= max;
  store('18488', 1, 'epub', vol(12));
  store('17930', 2, 'epub', vol(13));
  store('19012', 1, 'epub', vol(10));
  store('15521', 1, 'epub', () => true);
  store('20113', 1, 'epub', vol(15));
  store('16877', 2, 'epub', entry => vol(17)(entry) || ser(202)(entry));
  store('19854', 1, 'mobi', vol(17), entry => entry.order === 17);
  store('18820', 1, 'epub', vol(8));
  store('21207', 1, 'epub', ser(21), entry => entry.order === 21);
  store('14502', 1, 'epub', vol(30));
  store('18488', 3, 'epub', vol(6));

  const mark = (key: string, ids: string[]) => { for (const entry of db.comics.get(key)!.items) if (ids.includes(entry.id)) entry.isNew = true; };
  mark('18488', ['18488-v14']);
  mark('19012', ['19012-v12']);
  mark('16877', ['16877-s204', '16877-s205']);
  mark('19854', ['19854-v18']);
  mark('21207', ['21207-s24']);

  let id = 1;
  const task = (key: string, itemId: string, targetId: number, patch: Partial<Task>): Task => {
    const comic = db.comics.get(key)!, entry = comic.items.find(i => i.id === itemId)!, to = target(targetId);
    const format = patch.format ?? 'epub';
    const created = patch.createdAt ?? ago(30);
    const value: Task = {
      id: id++, comicKey: key, comicTitle: comic.title, cover: comic.cover, itemId, itemName: entry.name, type: entry.type, format,
      targetId, targetName: to.name, status: 'queued', phase: null, attempt: 1, maxAttempts: db.settings.maxRetries, retryAt: null,
      loaded: 0, total: null, speed: 0, path: null, error: null, errorCode: null, origin: 'subscription', createdAt: created,
      startedAt: null, finishedAt: null, ...patch,
    };
    if (value.status === 'completed') {
      value.path = filePath(to, comic, entry, format);
      value.total = value.loaded = Math.round((entry.sizeMB[format] ?? 0) * 1024 ** 2);
    }
    db.tasks.push(value);
    return value;
  };
  const done = (key: string, itemId: string, targetId: number, minutes: number, patch: Partial<Task> = {}) =>
    task(key, itemId, targetId, { status: 'completed', createdAt: ago(minutes + 3), startedAt: ago(minutes + 1), finishedAt: ago(minutes), ...patch });

  done('15521', '15521-e1', 1, 60 * 24 * 6, { origin: 'manual' });
  done('20113', '20113-v15', 1, 60 * 24 + 20);
  done('19854', '19854-v16', 1, 60 * 20, { format: 'mobi' });
  done('21207', '21207-s19', 1, 60 * 9);
  done('21207', '21207-s20', 1, 60 * 9 - 2);
  done('19012', '19012-v10', 1, 60 * 7);
  done('18488', '18488-v12', 1, 60 * 2 + 5);
  done('16877', '16877-s200', 2, 58);
  done('16877', '16877-s201', 2, 50);
  done('16877', '16877-s202', 2, 12);
  task('14502', '14502-v31', 1, { status: 'cancelled', origin: 'manual', createdAt: ago(60 * 30), finishedAt: ago(60 * 30 - 1) });
  task('17930', '17930-e1', 2, {
    status: 'failed', attempt: 4, maxAttempts: 4, error: 'WebDAV 上传失败：507 空间不足', errorCode: 'no_space',
    createdAt: ago(60 * 5 + 8), startedAt: ago(60 * 5 + 6), finishedAt: ago(60 * 5), loaded: 0, total: null,
  });
  task('16877', '16877-s205', 2, {
    status: 'failed', error: 'Kmoe 返回 404：这一话暂时无法下载', errorCode: 'not_found', createdAt: ago(40), startedAt: ago(39), finishedAt: ago(38),
  });

  const size = (key: string, itemId: string) => Math.round((db.comics.get(key)!.items.find(i => i.id === itemId)!.sizeMB.epub ?? 0) * 1024 ** 2);
  if (!paused && !expired && !network) {
    task('18488', '18488-v13', 1, { status: 'running', phase: 'downloading', startedAt: ago(1), createdAt: ago(3), total: size('18488', '18488-v13'), loaded: Math.round(size('18488', '18488-v13') * 0.42), speed: 3.4 * 1024 ** 2 });
    task('16877', '16877-s203', 2, { status: 'running', phase: 'downloading', startedAt: ago(1), createdAt: ago(38), total: size('16877', '16877-s203'), loaded: Math.round(size('16877', '16877-s203') * 0.7), speed: 2.6 * 1024 ** 2 });
  } else {
    task('18488', '18488-v13', 1, { createdAt: ago(3) });
    task('16877', '16877-s203', 2, { createdAt: ago(38) });
  }
  task('16877', '16877-s204', 2, {
    phase: 'waiting', attempt: 2, maxAttempts: 4, retryAt: new Date(now + 26_000).toISOString(), error: '连接超时（ETIMEDOUT）', errorCode: 'network', createdAt: ago(38),
  });
  task('18488', '18488-v14', 1, { createdAt: ago(2) });
  for (const n of [9, 10, 11, 12]) task('18820', `18820-v${n}`, 1, { origin: 'manual', createdAt: ago(1) });
  db.seq = id;

  const lastActivity: Record<string, number> = { '16877': 12, '18488': 2, '18820': 1, '17930': 300, '19854': 180, '19012': 420, '21207': 540, '20113': 60 * 25, '15521': 60 * 24 * 6, '14502': 60 * 30 };
  for (const [key, minutes] of Object.entries(lastActivity)) db.comics.get(key)!.lastActivityAt = ago(minutes);

  let activityId = 1;
  const event = (kind: Activity['kind'], level: Activity['level'], title: string, detail: string | null, comicKey: string | null, minutes: number): Activity =>
    ({ id: activityId++, kind, level, title, detail, comicKey, createdAt: ago(minutes) });
  db.activity = [
    event('info', 'info', 'Kmoe Sync 已启动', `版本 ${version}`, null, 60 * 24 * 7),
    event('download_done', 'success', '下载完成 · 迷宮飯', '14 卷与番外 01 · 本地书库', '15521', 60 * 24 * 6),
    event('queue_paused', 'warning', '额度不足，队列已暂停', '剩余 380 MB，低于保留的 500 MB', null, 60 * 24 * 4),
    event('queue_resumed', 'info', '下载队列已恢复', '额度已于 1 日重置', null, 60 * 24 * 3),
    event('source_synced', 'info', 'Bangumi 书单已同步', '新增 2 部待匹配', null, 60 * 24 + 40),
    event('download_done', 'success', '下载完成 · 我推的孩子', '卷 15 · 本地书库', '20113', 60 * 24 + 20),
    event('download_failed', 'error', '下载失败 · 間諜家家酒', '番外 01：WebDAV 上传失败（507 空间不足）', '17930', 60 * 5),
    event('check_failed', 'warning', '检查失败 · 膽大黨', 'Kmoe 暂时无法访问（HTTP 503）', '19854', 180),
    event('new_items', 'info', '发现新章节 · 葬送的芙莉蓮', '卷 14 已加入下载队列', '18488', 125),
    event('download_failed', 'error', '下载失败 · 鏈鋸人', '話 205：Kmoe 返回 404', '16877', 38),
    event('new_items', 'info', '发现新章节 · 鏈鋸人', '話 204、話 205 已加入下载队列', '16877', 40),
    event('download_done', 'success', '下载完成 · 鏈鋸人', '話 200–202 · NAS WebDAV', '16877', 12),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (expired) db.activity.unshift(event('session_expired', 'error', 'Kmoe 登录已失效', '队列已暂停，重新登录后会继续', null, 20));
  if (paused) db.activity.unshift(event('queue_paused', 'warning', '额度不足，队列已暂停', '剩余 444 MB，低于保留的 500 MB', null, 15));
  if (network) db.activity.unshift(event('queue_paused', 'warning', '网络中断，队列已暂停', '连不上 Kmoe 下载服务器；网络恢复后会自动继续', null, 6));

  const bangumi = (externalId: string, title: string, originalTitle: string, status: SourceItem['status'], match: SourceItem['match'], days: number): SourceItem => ({
    id: Number(externalId.slice(-4)), sourceId: 1, externalId, title, originalTitle, status, cover: coverFor(title, `bgm-${externalId}`),
    url: `https://bgm.tv/subject/${externalId}`, match, firstSeenAt: ago(60 * 24 * days),
  });
  const pending = { state: 'pending', comicKey: null, comicTitle: null } as const;
  db.sourceItems = [
    bangumi('400602', '葬送的芙莉蓮', '葬送のフリーレン', 'doing', { state: 'matched', comicKey: '18488', comicTitle: '葬送的芙莉蓮' }, 40),
    bangumi('376703', '藥屋少女的呢喃', '薬屋のひとりごと', 'doing', { state: 'matched', comicKey: '19012', comicTitle: '藥屋少女的呢喃' }, 35),
    bangumi('328609', '孤獨搖滾！', 'ぼっち・ざ・ろっく！', 'wish', pending, 1),
    bangumi('353233', '地。─關於地球的運動─', 'チ。―地球の運動について―', 'wish', pending, 1),
    bangumi('241561', '藍色時期', 'ブルーピリオド', 'wish', pending, 9),
    bangumi('313470', '放學後失眠的你', '君は放課後インソムニア', 'wish', pending, 12),
    bangumi('292222', '夏日重現', 'サマータイムレンダ', 'doing', { state: 'matched', comicKey: '15874', comicTitle: '夏日重現' }, 20),
    bangumi('183878', '紫羅蘭永恆花園', 'ヴァイオレット・エヴァーガーデン', 'wish', { state: 'dismissed', comicKey: null, comicTitle: null }, 30),
  ];
  db.sources = [{
    id: 1, name: '我的 Bangumi', username: 'kmoe_reader', types: ['wish', 'doing'], enabled: true, intervalHours: 24,
    itemCount: db.sourceItems.length, pendingCount: db.sourceItems.filter(i => i.match.state === 'pending').length, lastSyncAt: ago(60 * 24 + 40), error: null,
  }];
}

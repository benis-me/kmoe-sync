// A fake Kmoe mirror with the same routes and payload shapes as the real site, for tests and `bun run dev:fake`.
// Login with any email and the password "kmoe-test". Control endpoints under /__fake/ inject failures and new volumes.
import { deflateRawSync } from 'node:zlib';
import { fold } from '../server/metadata/text';

export const FAKE_PASSWORD = 'kmoe-test';

interface FakeVolume { id: string; type: '單行本' | '番外篇' | '話'; order: number; name: string; pages: number; epubMB: number; mobiMB: number }
interface FakeComic { key: string; bookId: string; title: string; authors: string[]; status: string; description: string; volumes: FakeVolume[]; hue: number }

const vol = (id: number, type: FakeVolume['type'], order: number, name: string, mb: number): FakeVolume =>
  ({ id: String(id), type, order, name, pages: Math.round(mb * 5), epubMB: mb, mobiMB: Math.round(mb * 1.9 * 10) / 10 });

function catalog(): FakeComic[] {
  return [
    { key: '8a3dbd', bookId: '31352', title: '渣女沒渣報', authors: ['岸川瑞樹'], status: '連載', hue: 18, description: '在中學時代被女朋友狠狠甩掉的秋吉直，成為大學生後又遇見了她……',
      volumes: [vol(1001, '單行本', 1, '卷 01', 33.3), vol(1002, '單行本', 2, '卷 02', 31.8), vol(3005, '話', 5, '話 005-015', 53.3), vol(3016, '話', 16, '話 016-020', 22.0), vol(3021, '話', 21, '話 021', 4.2)] },
    { key: 'f7e2c9', bookId: '50076', title: '葬送的芙莉蓮', authors: ['山田鐘人', 'アベツカサ'], status: '連載', hue: 150, description: '打倒魔王之後，精靈魔法使芙莉蓮踏上了重新認識人類的旅程。',
      volumes: Array.from({ length: 13 }, (_, i) => vol(2001 + i, '單行本', i + 1, `卷 ${String(i + 1).padStart(2, '0')}`, 38 + (i % 4))) },
    { key: 'b1c4a0', bookId: '18488', title: '迷宮飯', authors: ['九井諒子'], status: '完結', hue: 40, description: '在迷宮深處，冒險者們一邊戰鬥一邊把魔物煮成料理。',
      volumes: [...Array.from({ length: 14 }, (_, i) => vol(4001 + i, '單行本', i + 1, `卷 ${String(i + 1).padStart(2, '0')}`, 45)), vol(4101, '番外篇', 1, '番外 冒險者指南', 12)] },
    { key: 'c9d0e1', bookId: '40112', title: '間諜家家酒', authors: ['遠藤達哉'], status: '連載', hue: 330, description: '間諜、殺手與超能力者組成的假家庭。',
      volumes: Array.from({ length: 12 }, (_, i) => vol(5001 + i, '單行本', i + 1, `卷 ${String(i + 1).padStart(2, '0')}`, 30)) },
    // Older comics have numeric keys: the key is the book id.
    { key: '10114', bookId: '10114', title: 'NANA', authors: ['矢澤愛'], status: '完結', hue: 0, description: '兩個同名的女孩在前往東京的列車上相遇。',
      volumes: Array.from({ length: 3 }, (_, i) => vol(6001 + i, '單行本', i + 1, `卷 ${String(i + 1).padStart(2, '0')}`, 28)) },
  ];
}

interface Control {
  /** Fail the next N file downloads with a dropped connection. */
  dropDownloads: number;
  /** getdownurl answers "quota exhausted". */
  quotaExhausted: boolean;
  /** Bytes per second for file downloads (0 = unthrottled). */
  rate: number;
  /** Session cookies invalidated (simulates an expired Kmoe login). */
  expired: boolean;
  /** Answer the next N searches the way Kmoe deflects clients it throttles: a redirect to www.google.com. */
  deflect: number;
  /** Answer logins with this msgid instead (e.g. e401: Kmoe refuses an automated login). */
  loginCode: string;
}

/** A minimal but valid EPUB (ZIP with a stored mimetype entry) padded to `size` bytes. */
function fakeEpub(size: number, label: string): Uint8Array {
  const name = Buffer.from('mimetype'), content = Buffer.from('application/epub+zip');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(10, 4); header.writeUInt32LE(0, 14);
  header.writeUInt32LE(content.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(name.length, 26);
  const note = deflateRawSync(Buffer.from(label));
  const body = Buffer.concat([header, name, content, note]);
  const out = new Uint8Array(Math.max(size, body.length + 22));
  out.set(body);
  out.set(Buffer.from('PK\x05\x06', 'latin1'), out.length - 22); // end of central directory
  return out;
}
function fakeMobi(size: number): Uint8Array {
  const out = new Uint8Array(Math.max(size, 128));
  out.set(Buffer.from('BOOKMOBI'), 60);
  return out;
}

const page = (title: string, body: string, script = '') =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}<script type="module">${script}</script></body></html>`;

export function startFakeKmoe(options: { port?: number; hostname?: string; fileScale?: number } = {}) {
  const comics = catalog();
  const control: Control = { dropDownloads: 0, quotaExhausted: false, rate: 0, expired: false, deflect: 0, loginCode: '' };
  let searches = 0, fileRequests = 0;
  const sessions = new Map<string, { email: string | null }>();
  const hashes = new Map<string, string>();
  let usedMB = 1024;
  const scale = options.fileScale ?? 1 / 4096; // 1 "MB" in the catalogue = 256 bytes by default: fast tests.
  let counter = 0;

  const session = (req: Request) => {
    const id = /VLIBSID=([\w-]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
    return id && !control.expired ? { id, data: sessions.get(id) } : null;
  };
  const newSession = (email: string | null) => { const id = `s${++counter}${Math.random().toString(36).slice(2)}`; sessions.set(id, { email }); return id; };
  const cookie = (id: string) => `VLIBSID=${id}; Max-Age=18000; path=/`;
  const loggedIn = (req: Request) => Boolean(session(req)?.data?.email);
  const html = (body: string, headers: Record<string, string> = {}) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
  const redirectLogin = () => new Response(null, { status: 302, headers: { Location: '/login.php' } });
  const find = (key: string) => comics.find(comic => comic.key === key);

  const server = Bun.serve({
    port: options.port ?? 18080,
    hostname: options.hostname ?? '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url), origin = url.origin, path = url.pathname;

      if (path.startsWith('/__fake/')) {
        if (req.method === 'POST' && path === '/__fake/control') { Object.assign(control, await req.json()); return Response.json(control); }
        if (req.method === 'POST' && path === '/__fake/new-volume') {
          const { key } = await req.json() as { key: string };
          const comic = find(key);
          if (!comic) return new Response('no comic', { status: 404 });
          const last = comic.volumes.filter(v => v.type === '單行本').at(-1);
          const order = (last?.order ?? 0) + 1;
          const volume = vol(Number(last?.id ?? 9000) + 1, '單行本', order, `卷 ${String(order).padStart(2, '0')}`, 36);
          comic.volumes.push(volume);
          return Response.json(volume);
        }
        if (path === '/__fake/state') return Response.json({ control, usedMB, sessions: sessions.size, searches, fileRequests });
      }

      if (path === '/' ) return html(page('Kmoe', `<form action="${origin}/list.php" method="get"><input name="s"></form>`));
      if (path === '/login.php') return html(page('登錄', '<form action="/login_do.php" method="post" name="login"><input name="email"><input name="passwd"></form>', "kb_http_post( '/login_act.php', oData, cb_login );"));
      if (path === '/login_act.php' && req.method === 'POST') {
        const form = await req.formData();
        if (control.loginCode) return Response.json({ msgid: control.loginCode });
        if (form.get('passwd') !== FAKE_PASSWORD) return Response.json({ msgid: 'e400', msg: '帳號或密碼錯誤' });
        control.expired = false;
        return Response.json({ msgid: 'm100' }, { headers: { 'Set-Cookie': cookie(newSession(String(form.get('email')))) } });
      }
      if (path === '/my.php') {
        if (!loggedIn(req)) return redirectLogin();
        return html(page('我的', `<a href="/logout.php">登出</a><p>Lv2 每月額度 : 10240 M</p><p>本月已用免費額度 : ${usedMB.toFixed(1)} M</p><p>Lv2 額度 : 每月 5 日</p><p>VIP 每月額度 : 40960 M</p><p>本月已經用VIP額度 : 2048 M</p><p>VIP 額度 : 每月 10 日</p>`,
          'var is_vip = parseInt( "1" ); var user_level = parseInt( "2" );'));
      }
      const list = /^\/l\/([^,]+),[^/]*\/(\d+)\.htm$/.exec(path);
      if (path === '/list.php' || list) {
        if (!loggedIn(req)) return redirectLogin();
        searches++;
        if (control.deflect > 0) { control.deflect--; return new Response(null, { status: 302, headers: { Location: 'https://www.google.com/' } }); }
        const query = list ? decodeURIComponent(list[1]!) : url.searchParams.get('s') ?? '';
        const pageNumber = list ? Number(list[2]) : 1;
        // Like Kmoe, a Simplified query finds the Traditional title.
        const hits = comics.filter(comic => !query.trim() || fold(comic.title).includes(fold(query)) || comic.authors.some(author => author.includes(query)) || query === '*');
        const perPage = 2, total = Math.max(1, Math.ceil(hits.length / perPage));
        const calls = hits.slice((pageNumber - 1) * perPage, pageNumber * perPage).map((comic, index) =>
          `disp_divinfo( "div_${index}", "${origin}/c/${comic.key}.htm", "${origin}/cover/${comic.key}.jpg", "0", "0", "0", "", "", "9.1", "${comic.title}", "${comic.authors.join(',')}", "${comic.volumes.at(-1)?.name}", "2026-09-20" );`).join('\n');
        return html(page(`搜索 ${query}`, '<div id="div_list"></div>', `var page_now = "${String(pageNumber).padStart(2, '0')}";\n${calls}\ndisp_divpage( "div_page", "${query}", "${total}" );`));
      }
      const detail = /^\/c\/([A-Za-z0-9]+)\.htm$/.exec(path);
      if (detail) {
        const comic = find(detail[1]!);
        if (!comic) return new Response('not found', { status: 404 });
        let current = session(req);
        const headers: Record<string, string> = {};
        if (!current) { const id = newSession(null); current = { id, data: sessions.get(id) }; headers['Set-Cookie'] = cookie(id); }
        const hash = `1790${Date.now().toString().slice(-6)}${comic.key}${Math.random().toString(16).slice(2, 14)}`;
        hashes.set(hash, current.id);
        const authors = comic.authors.map(author => `<a href="${origin}/list.php?s=${encodeURIComponent(author)}">${author}</a>`).join(' ');
        return html(page(`${comic.title} : ${comic.authors[0]} [Kindle漫畫|epub漫畫] [fake]`,
          `<meta property="og:image" content="${origin}/cover/${comic.key}.jpg"><table><tr><td><img class="img_book" src="/cover/${comic.key}.jpg"></td>
          <td class="author"><font class="text_bglight_big">${comic.title}</font><br><font class="text_bglight">作者：${authors}<a href="${origin}/list.php?s="></a></font><br>
          <font class="text_bglight">狀態：${comic.status}　地區：日本　語言：繁體</font></td></tr></table><input type="hidden" name="bookid" value="${comic.bookId}"><div id="div_desc_content">請訪問</div>`,
          `var bookid = "${comic.bookId}"; var bookstatus = "${comic.status}";\ndocument.getElementById("div_desc_content").innerHTML = ${JSON.stringify(comic.description)};\ndata_book( "${hash}" );`), headers);
      }
      if (path === '/data_book.php') {
        const owner = hashes.get(url.searchParams.get('h') ?? '');
        const current = session(req);
        const comic = comics.find(item => url.searchParams.get('h')?.includes(item.key));
        if (!owner || !current || owner !== current.id || !comic) return Response.json({ msgid: 0, hash: '', bookkey: '', bookname: '', volcount: 0, voldata: [], tagcate: '', linkbook: '', needrec: 0 });
        return Response.json({ msgid: 0, hash: url.searchParams.get('h'), bookkey: comic.key, bookname: comic.title, volcount: comic.volumes.length,
          voldata: comic.volumes.map(v => [v.id, '0', '0', v.type, String(v.order), v.name, String(v.pages), String(v.pages), '0.0', String(v.mobiMB), String(v.epubMB), String(v.epubMB), '', '2026-09-01', '', '', ''] ) });
      }
      if (path === '/getdownurl.php') {
        if (!loggedIn(req)) return new Response('非法訪問，請先登錄', { status: 403 });
        if (control.quotaExhausted) return Response.json({ code: 'e403', msg: '額度不足' });
        const comic = comics.find(item => item.bookId === url.searchParams.get('b'));
        const volume = comic?.volumes.find(item => item.id === url.searchParams.get('v'));
        if (!comic || !volume) return Response.json({ code: '404', msg: '找不到文檔' });
        const ext = url.searchParams.get('mobi') === '1' ? 'mobi' : 'epub';
        usedMB += ext === 'epub' ? volume.epubMB : volume.mobiMB;
        return Response.json({ code: 200, url: `${origin}/file/${comic.bookId}/${volume.id}.${ext}?sign=${Date.now()}`, name: `[Kmoe][${comic.title}]${volume.name.replace(/\s+/g, '')}.${ext}` });
      }
      const file = /^\/file\/(\d+)\/(\d+)\.(epub|mobi)$/.exec(path);
      if (file) {
        const comic = comics.find(item => item.bookId === file[1]);
        const volume = comic?.volumes.find(item => item.id === file[2]);
        if (!comic || !volume) return new Response('gone', { status: 404 });
        const size = Math.round((file[3] === 'epub' ? volume.epubMB : volume.mobiMB) * 1024 * 1024 * scale) + 256;
        const bytes = file[3] === 'epub' ? fakeEpub(size, `${comic.title} ${volume.name}`) : fakeMobi(size);
        fileRequests++;
        const range = /^bytes=(\d+)-$/.exec(req.headers.get('range') ?? '');
        // Like a CDN: a resume from the end (or beyond) of the file is not satisfiable.
        if (range && Number(range[1]) >= bytes.length) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } });
        const start = range ? Number(range[1]) : 0;
        const slice = bytes.subarray(start);
        const drop = control.dropDownloads > 0;
        if (drop) control.dropDownloads--;
        const rate = control.rate;
        const body = new ReadableStream<Uint8Array>({
          async start(stream) {
            const chunk = Math.max(drop ? 256 : 1024, Math.round((rate || slice.length) / 10));
            for (let offset = 0; offset < slice.length; offset += chunk) {
              if (drop && offset >= slice.length / 2) { stream.close(); return; } // truncated body = dropped connection
              stream.enqueue(slice.subarray(offset, offset + chunk));
              if (rate) await Bun.sleep(100);
            }
            stream.close();
          },
        });
        return new Response(body, { status: range ? 206 : 200, headers: {
          'Content-Type': 'application/octet-stream', 'Content-Length': String(slice.length),
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`[Kmoe][${comic.title}]${volume.name.replace(/\s+/g, '')}.${file[3]}`)}`,
          ...(range ? { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}),
        } });
      }
      const cover = /^\/cover\/([A-Za-z0-9]+)\.jpg$/.exec(path);
      if (cover) {
        const comic = find(cover[1]!);
        const hue = comic?.hue ?? 200;
        return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,68%)"/><stop offset="1" stop-color="hsl(${hue + 30},40%,30%)"/></linearGradient></defs><rect width="300" height="420" fill="url(#g)"/><text x="24" y="380" font-size="30" fill="#fff" font-family="sans-serif">${comic?.title ?? ''}</text></svg>`, { headers: { 'Content-Type': 'image/svg+xml' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { server, origin: `http://${server.hostname}:${server.port}`, control, comics, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const fake = startFakeKmoe({ fileScale: 1 / 64 });
  fake.control.rate = 256 * 1024;
  console.log(`Fake Kmoe mirror on ${fake.origin} — log in with any email and the password "${FAKE_PASSWORD}"`);
}

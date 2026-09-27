// In-memory WebDAV server for storage tests: PROPFIND (Depth 0/1), MKCOL, PUT (If-None-Match), GET, optional Basic auth.
// Three multistatus dialects: "d:" prefixes, Apache-style mixed prefixes with a 404 propstat, and a default namespace with
// absolute-URL hrefs and numeric character references.
type Entry = { dir: true } | { dir: false; size: number; bytes?: Uint8Array<ArrayBuffer> };
export type Dialect = 'd' | 'apache' | 'default';
export interface Logged { method: string; path: string; depth: string | null; headers: Headers }

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
const encode = (path: string, dir: boolean) => path.split('/').map(encodeURIComponent).join('/') + (dir ? '/' : '');

export function startFakeDav(options: { auth?: { username: string; password: string } } = {}) {
  const tree = new Map<string, Entry>();
  const requests: Logged[] = [];
  const state = {
    dialect: 'd' as Dialect,
    /** Consulted first; return a Response to take over a request. */
    override: undefined as undefined | ((request: Request, path: string) => Response | undefined | Promise<Response | undefined>),
    /** Raw <d:response> elements appended to every multistatus. */
    extra: '',
  };
  const mkdirs = (path: string) => { for (let p = path; p !== '/' && !tree.has(p); p = parent(p)) tree.set(p, { dir: true }); };
  const reset = () => { tree.clear(); tree.set('/dav', { dir: true }); requests.length = 0; state.dialect = 'd'; state.override = undefined; state.extra = ''; };
  reset();

  function multistatus(entries: [string, Entry][]): string {
    const body = entries.map(([path, entry]) => {
      const name = path.slice(path.lastIndexOf('/') + 1), size = entry.dir ? '' : String(entry.size);
      if (state.dialect === 'apache') {
        return `<D:response xmlns:lp1="DAV:" xmlns:lp2="http://apache.org/dav/props/">\n<D:href>${encode(path, entry.dir)}</D:href>\n<D:propstat>\n<D:prop>\n`
          + `<lp1:resourcetype>${entry.dir ? '<D:collection/>' : ''}</lp1:resourcetype>\n${size && `<lp1:getcontentlength>${size}</lp1:getcontentlength>\n`}`
          + `</D:prop>\n<D:status>HTTP/1.1 200 OK</D:status>\n</D:propstat>\n<D:propstat>\n<D:prop>\n<D:displayname/>\n</D:prop>\n<D:status>HTTP/1.1 404 Not Found</D:status>\n</D:propstat>\n</D:response>\n`;
      }
      if (state.dialect === 'default') {
        const display = escapeXml(name).replace(/[^\x20-\x7e]/gu, char => `&#${char.codePointAt(0)};`);
        return `<response><href>${origin}${encode(path, entry.dir)}</href><propstat><prop><displayname>${display}</displayname>`
          + `<resourcetype>${entry.dir ? '<collection/>' : ''}</resourcetype>${size && `<getcontentlength>${size}</getcontentlength>`}</prop>`
          + `<status>HTTP/1.1 200 OK</status></propstat></response>`;
      }
      return `<d:response><d:href>${encode(path, entry.dir)}</d:href><d:propstat><d:prop><d:displayname>${escapeXml(name)}</d:displayname>`
        + `<d:resourcetype>${entry.dir ? '<d:collection/>' : ''}</d:resourcetype>${size && `<d:getcontentlength>${size}</d:getcontentlength>`}</d:prop>`
        + `<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
    }).join('') + state.extra;
    if (state.dialect === 'apache') return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:ns0="DAV:">\n${body}</D:multistatus>\n`;
    if (state.dialect === 'default') return `<?xml version="1.0"?><multistatus xmlns="DAV:">${body}</multistatus>`;
    return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`;
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname).replace(/(.)\/+$/, '$1');
      requests.push({ method: request.method, path, depth: request.headers.get('depth'), headers: request.headers });
      const custom = await state.override?.(request, path);
      if (custom) return custom;
      const expected = options.auth && `Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`).toString('base64')}`;
      if (expected && request.headers.get('authorization') !== expected) return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="dav"' } });
      const entry = tree.get(path);
      switch (request.method) {
        case 'PROPFIND': {
          if (!entry) return new Response('', { status: 404 });
          const children = request.headers.get('depth') === '1' && entry.dir ? [...tree].filter(([p]) => p !== path && parent(p) === path) : [];
          return new Response(multistatus([[path, entry], ...children]), { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
        }
        case 'MKCOL':
          if (entry) return new Response('', { status: 405 });
          if (!tree.get(parent(path))?.dir) return new Response('', { status: 409 });
          tree.set(path, { dir: true });
          return new Response('', { status: 201 });
        case 'PUT': {
          if (!tree.get(parent(path))?.dir) return new Response('', { status: 409 });
          if (entry && request.headers.get('if-none-match') === '*') return new Response('', { status: 412 });
          const bytes = new Uint8Array(await request.arrayBuffer());
          tree.set(path, { dir: false, size: bytes.length, bytes });
          return new Response('', { status: entry ? 204 : 201 });
        }
        case 'GET':
          return entry && !entry.dir ? new Response(entry.bytes ?? new Uint8Array(entry.size)) : new Response('', { status: 404 });
      }
      return new Response('', { status: 405 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;

  return {
    origin,
    url: `${origin}/dav`,
    tree,
    requests,
    state,
    reset,
    /** Files (size, or bytes) and directories, as decoded server paths; parents are created. */
    seed(files: Record<string, number | Uint8Array<ArrayBuffer>>, dirs: string[] = []) {
      for (const dir of dirs) mkdirs(dir);
      for (const [path, value] of Object.entries(files)) {
        mkdirs(parent(path));
        tree.set(path, typeof value === 'number' ? { dir: false, size: value } : { dir: false, size: value.length, bytes: value });
      }
    },
    stop: () => server.stop(true),
  };
}
export type FakeDav = ReturnType<typeof startFakeDav>;

/** A multistatus body in the "d:" dialect, for hand-written responses. */
export const xml = (body: string) => `<d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`;
export const entry = (href: string, directory = false, size = 10) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${directory ? '<d:collection/>' : ''}</d:resourcetype>`
  + `<d:getcontentlength>${size}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

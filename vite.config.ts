import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const serverPort = Number(process.env.PORT) || 8080;

/** Brotli and gzip copies next to the scripts and styles; the server sends one when the browser accepts it. */
const precompress = (): Plugin => ({
  name: 'precompress',
  apply: 'build',
  writeBundle({ dir }) {
    const assets = join(dir!, 'assets');
    for (const name of readdirSync(assets).filter(file => /\.(?:js|css)$/.test(file))) {
      const file = join(assets, name), body = readFileSync(file);
      writeFileSync(`${file}.br`, brotliCompressSync(body));
      writeFileSync(`${file}.gz`, gzipSync(body, { level: 9 }));
    }
  },
});

type ModuleGraph = (id: string) => { importers: readonly string[] } | null;
/** Package code that only `owner` pulls in (directly or through other packages), so it loads with owner's chunk. */
function onlyFor(owner: string, id: string, graph: ModuleGraph, seen = new Set<string>()): boolean {
  if (seen.has(id)) return true;
  seen.add(id);
  const importers = graph(id)?.importers ?? [];
  return importers.length > 0 && importers.every(importer => importer.endsWith(owner) || (importer.includes('/node_modules/') && onlyFor(owner, importer, graph, seen)));
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  // Only the app entry: test fixtures under tests/ are HTML too.
  optimizeDeps: { entries: ['index.html'] },
  server: {
    proxy: {
      '/api': { target: `http://127.0.0.1:${serverPort}`, changeOrigin: false },
      '/mcp': `http://127.0.0.1:${serverPort}`,
    },
  },
  build: {
    outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900,
    // Name the shared third-party chunk explicitly (otherwise it is named after whichever app module pulled it in first).
    // The assistant's Markdown renderer is left out: it loads when the assistant opens.
    rolldownOptions: { output: { manualChunks: (id: string, { getModuleInfo }: { getModuleInfo: ModuleGraph }) =>
      id.includes('/node_modules/') && !onlyFor('/src/features/assistant/markdown.tsx', id, getModuleInfo) ? 'vendor' : undefined } },
  },
});

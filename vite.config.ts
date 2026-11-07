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
    // Let the bundler keep route-only dependencies lazy instead of pulling them into one eager vendor chunk.
  },
});

import { defineConfig } from 'vite';

export default defineConfig({
  root: decodeURIComponent(new URL('.', import.meta.url).pathname),
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 5688, strictPort: true },
  preview: { host: '127.0.0.1', port: 5688, strictPort: true },
  build: { outDir: '/private/tmp/wm-m2-02g-competition-fixture-dist', emptyOutDir: true },
});

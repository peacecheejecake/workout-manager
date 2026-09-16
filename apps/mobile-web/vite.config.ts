import { defineConfig } from 'vite';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 4200, strictPort: true },
  preview: {
    headers: {
      'Content-Security-Policy':
        "worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:",
    },
  },
});

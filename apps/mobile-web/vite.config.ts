import { defineConfig } from 'vite';

// Development/preview only. Production hosting must proxy /bff to its configured API.
const apiOrigin = process.env['API_ORIGIN'];
const target = apiOrigin ? new URL(apiOrigin) : null;
if (
  target &&
  (!['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.pathname !== '/' ||
    target.search ||
    target.hash)
)
  throw new Error('API_ORIGIN must be an HTTP(S) origin');
const proxy = target ? { '/bff': { target: target.origin } } : undefined;

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 4200, strictPort: true, ...(proxy ? { proxy } : {}) },
  preview: {
    ...(proxy ? { proxy } : {}),
    headers: {
      'Content-Security-Policy':
        "worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:",
    },
  },
});

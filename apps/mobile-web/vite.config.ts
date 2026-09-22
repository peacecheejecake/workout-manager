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
/**
 * Development/preview only: where the self-hosted background map is served from.
 *
 * This shell has no server of its own, so during development the background assets are
 * proxied to whichever origin already serves them (the Next shell, or a static host).
 * Production hosting serves `/map/basemap/**` itself. Unset means no background map, which
 * the route screen shows as its own state rather than as a failure.
 */
const basemapOrigin = process.env['BASEMAP_ORIGIN'];
const basemapTarget = basemapOrigin ? new URL(basemapOrigin) : null;
if (
  basemapTarget &&
  (!['http:', 'https:'].includes(basemapTarget.protocol) ||
    basemapTarget.username ||
    basemapTarget.password ||
    basemapTarget.pathname !== '/' ||
    basemapTarget.search ||
    basemapTarget.hash)
)
  throw new Error('BASEMAP_ORIGIN must be an HTTP(S) origin');
const proxy =
  target || basemapTarget
    ? {
        ...(target ? { '/bff': { target: target.origin } } : {}),
        ...(basemapTarget ? { '/map/basemap': { target: basemapTarget.origin } } : {}),
      }
    : undefined;

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

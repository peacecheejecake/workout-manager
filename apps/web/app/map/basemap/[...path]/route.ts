/**
 * Static serving for the self-hosted basemap deployment.
 *
 * The background map is a *public* static asset: no session, no athlete id, cacheable and
 * deliberately on a different path, auth and cache policy from the private track objects,
 * which stay behind the authenticated API. This handler serves the background and nothing
 * else — it never reaches outside the configured deployment directory.
 *
 * It is opt-in: with `BASEMAP_DIST_DIR` unset there is no background map at all and every
 * request here is a 404. The build itself is `scripts/build-basemap.mjs`, which writes an
 * immutable `dist/<deploymentId>/` directory; this handler serves that directory.
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

export const dynamic = 'force-dynamic';

const contentTypes: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.pbf': 'application/x-protobuf',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

/** The configured deployment root, resolved once. `null` disables the whole route. */
const distRoot = (() => {
  const configured = process.env['BASEMAP_DIST_DIR'];
  return configured === undefined || configured === '' ? null : resolve(configured);
})();

/** Control characters and separators never reach the filesystem join. */
function safeSegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') return false;
  if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')) return false;
  for (const character of segment) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  if (distRoot === null) return new Response(null, { status: 404 });
  const { path } = await context.params;
  // `current.json` (one segment) plus every asset inside a deployment directory. The
  // extension allowlist and the containment check below decide the rest.
  if (!Array.isArray(path) || path.length === 0 || !path.every(safeSegment))
    return new Response(null, { status: 404 });
  const target = normalize(join(distRoot, ...path));
  // Belt and braces: even with every segment checked, the resolved path must still be
  // inside the deployment root before a byte is read.
  if (target !== distRoot && !target.startsWith(distRoot + sep))
    return new Response(null, { status: 404 });
  const extension = extname(target);
  const contentType = contentTypes[extension];
  if (contentType === undefined) return new Response(null, { status: 404 });
  let body: Buffer;
  try {
    const stats = await stat(target);
    if (!stats.isFile()) return new Response(null, { status: 404 });
    body = await readFile(target);
  } catch {
    return new Response(null, { status: 404 });
  }
  // A deployment directory is immutable, but the pointer that names the current
  // deployment is not: it changes on every publish and on a rollback. Caching it as
  // immutable would leave a client on an old deployment, and on a pruned one the map
  // would simply stop loading. Only the per-deployment assets are immutable.
  const pointer = path.length === 1;
  const headers = new Headers({
    'content-type': contentType,
    'cache-control': pointer ? 'no-store' : 'public, max-age=604800, immutable',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  // Only vector tiles are stored gzip-compressed (that is how MBTiles holds them). Glyph
  // ranges are plain protobuf and must not claim an encoding.
  if (extension === '.pbf' && path.includes('tiles')) headers.set('content-encoding', 'gzip');
  return new Response(new Uint8Array(body), { status: 200, headers });
}

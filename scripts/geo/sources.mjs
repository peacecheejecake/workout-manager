/**
 * Operations allowlist for self-hosted map data acquisition (M2-01d).
 *
 * Only the exact URLs below may be fetched by the geo build tooling. There is no
 * user-supplied URL path into these scripts: `fetchAllowedSource` takes an allowlist
 * id, never a URL. Every entry records the license we rely on and the attribution
 * obligation that the distributed artifact must carry.
 *
 * These downloads are build-time only. The browser must never reach any of them.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** @typedef {{ id: string, url: string, purpose: string, license: string, licenseUrl: string, attribution: string | null, redistribution: string, maxBytes: number, sha256?: string }} AllowedSource */

/** @type {readonly AllowedSource[]} */
export const allowedSources = Object.freeze([
  {
    id: 'osm-extract-seoul',
    url: 'https://download.bbbike.org/osm/bbbike/Seoul/Seoul.osm.pbf',
    purpose: 'Regional OpenStreetMap extract used as the only basemap and routing graph input.',
    license: 'ODbL-1.0',
    licenseUrl: 'https://www.openstreetmap.org/copyright',
    attribution: '© OpenStreetMap contributors',
    redistribution:
      'ODbL share-alike applies to the database and to produced works derived from it. Tiles, style, routing graph and any exported geometry must carry the attribution and a link to the license.',
    maxBytes: 300 * 1024 * 1024,
  },
  {
    id: 'glyphs-noto-sans-regular',
    url: 'https://raw.githubusercontent.com/protomaps/basemaps-assets/83bc11ea49e5c024df51979d5953ee841fd06584/fonts/Noto%20Sans%20Regular/{range}.pbf',
    purpose: 'Pre-generated SDF glyph ranges for the Latin part of basemap labels.',
    license: 'OFL-1.1',
    licenseUrl:
      'https://raw.githubusercontent.com/protomaps/basemaps-assets/83bc11ea49e5c024df51979d5953ee841fd06584/fonts/OFL.txt',
    attribution: 'Noto Sans, SIL Open Font License 1.1',
    redistribution:
      'OFL permits bundling and redistribution with the license text; the font name must not be used to promote derivatives.',
    maxBytes: 4 * 1024 * 1024,
  },
  {
    id: 'glyphs-noto-sans-license',
    url: 'https://raw.githubusercontent.com/protomaps/basemaps-assets/83bc11ea49e5c024df51979d5953ee841fd06584/fonts/OFL.txt',
    purpose: 'License text distributed next to the glyph ranges.',
    license: 'OFL-1.1',
    licenseUrl:
      'https://raw.githubusercontent.com/protomaps/basemaps-assets/83bc11ea49e5c024df51979d5953ee841fd06584/fonts/OFL.txt',
    attribution: null,
    redistribution: 'Must be shipped with the glyph files.',
    maxBytes: 64 * 1024,
  },
  {
    id: 'graphhopper-web-jar',
    url: 'https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/10.0/graphhopper-web-10.0.jar',
    purpose: 'GraphHopper open-source routing engine candidate (server build, not the hosted API).',
    license: 'Apache-2.0',
    // Pinned on 2026-09-21 from the first download; a reused or re-downloaded jar whose
    // bytes differ is refused rather than measured.
    sha256: 'e5a1268f2cd6b1e4ef849b9237e98b651bf3c31adf4a3766c6d9f5feb241bb41',
    licenseUrl: 'https://github.com/graphhopper/graphhopper/blob/master/LICENSE.txt',
    attribution: 'GraphHopper GmbH and contributors',
    redistribution: 'Apache-2.0 allows self-hosting; NOTICE must be preserved if redistributed.',
    maxBytes: 128 * 1024 * 1024,
  },
]);

/** @param {string} id */
export function allowedSource(id) {
  const source = allowedSources.find((entry) => entry.id === id);
  if (!source) throw new Error(`SOURCE_NOT_ALLOWLISTED: ${id}`);
  return source;
}

/**
 * Resolve an allowlist entry to a concrete URL. `{range}` is the only substitution and
 * it must be a numeric glyph range, so no caller can steer the request elsewhere.
 * @param {AllowedSource} source
 * @param {{ range?: string }} [parameters]
 */
export function resolveUrl(source, parameters = {}) {
  let href = source.url;
  if (href.includes('{range}')) {
    const range = parameters.range ?? '';
    if (!/^[0-9]{1,5}-[0-9]{1,5}$/.test(range)) throw new Error('INVALID_GLYPH_RANGE');
    href = href.replace('{range}', range);
  }
  const url = new URL(href);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('INVALID_SOURCE_URL');
  return url;
}

/** @param {string} path */
export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Download one allowlisted source to `destination`.
 *
 * Redirects are **not** followed: `curl --location` would happily move to another HTTPS
 * host, which is exactly what the allowlist exists to prevent. Without `--location`,
 * curl still exits 0 on a 30x and writes the (empty) redirect body, so the status code
 * is checked explicitly and anything outside 2xx fails the download.
 *
 * Response headers are captured so the run can record the server's own date for the
 * bytes, and the SHA-256 is verified against the pin when the allowlist entry has one.
 *
 * @param {{ id: string, destination: string, range?: string, execute?: typeof execFileAsync }} options
 */
export async function fetchAllowedSource({ id, destination, range, execute = execFileAsync }) {
  const source = allowedSource(id);
  const url = resolveUrl(source, { range });
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  const headerPath = `${destination}.${process.pid}.headers`;
  // `--disable` first so a local curlrc cannot add credentials, retries or extra requests.
  const { stdout } = await execute(
    'curl',
    [
      '--disable',
      '--silent',
      '--show-error',
      '--fail',
      '--write-out',
      '%{http_code}',
      '--proto',
      '=https',
      // No --location: a 30x is a failure, not a hop.
      '--max-redirs',
      '0',
      '--max-time',
      '900',
      '--max-filesize',
      String(source.maxBytes),
      '--user-agent',
      'WorkoutManager-GeoBuild/0.1 (self-hosted map preparation; build-time only)',
      '--dump-header',
      headerPath,
      '--output',
      temporary,
      '--url',
      url.href,
    ],
    { timeout: 900_000, killSignal: 'SIGKILL', maxBuffer: 1 << 20, encoding: 'utf8' },
  );
  const status = Number.parseInt(String(stdout).trim(), 10);
  const headers = await readResponseHeaders(headerPath);
  await rm(headerPath, { force: true });
  if (!Number.isInteger(status) || status < 200 || status > 299) {
    await rm(temporary, { force: true });
    throw new Error(`SOURCE_HTTP_STATUS_${Number.isInteger(status) ? status : 'UNKNOWN'}`);
  }
  await rename(temporary, destination);
  const { size } = await stat(destination);
  const sha256 = await sha256File(destination);
  if (source.sha256 && source.sha256 !== sha256) {
    await rm(destination, { force: true });
    throw new Error(`SOURCE_HASH_MISMATCH: ${source.id}`);
  }
  return {
    sourceId: source.id,
    url: url.href,
    bytes: size,
    sha256,
    sha256Pinned: source.sha256 ?? null,
    httpStatus: status,
    lastModified: headers.get('last-modified') ?? null,
    etag: headers.get('etag') ?? null,
    dateSource: headers.has('last-modified') ? 'http-last-modified' : 'not-provided-by-server',
    license: source.license,
    licenseUrl: source.licenseUrl,
    attribution: source.attribution,
  };
}

/**
 * Verify a file already on disk against an allowlist pin, so a cached artifact is never
 * measured without checking it is the same bytes we pinned.
 * @param {string} id @param {string} path
 */
export async function verifyAllowedSourceFile(id, path) {
  const source = allowedSource(id);
  const sha256 = await sha256File(path);
  if (source.sha256 && source.sha256 !== sha256)
    throw new Error(`SOURCE_HASH_MISMATCH: ${source.id}`);
  const { size } = await stat(path);
  return { sourceId: source.id, bytes: size, sha256, sha256Pinned: source.sha256 ?? null };
}

/** @param {string} path */
async function readResponseHeaders(path) {
  const headers = new Map();
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return headers;
  }
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return headers;
}

/** @param {string} directory @param {string} name */
export function inWorkspace(directory, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('INVALID_PATH_SEGMENT');
  return join(directory, name);
}

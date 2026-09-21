/**
 * Background map descriptor and the same-origin rules that go with it.
 *
 * The kit accepts a style location only as a path that a real URL parser resolves to the
 * **current origin**. String inspection alone is not enough: `\\evil.example/style.json`
 * starts with neither a scheme nor `//`, yet `new URL()` resolves it to
 * `https://evil.example/style.json` because the URL standard treats a backslash as a
 * separator in special schemes. Everything here therefore parses first and compares
 * origins exactly, and the caller must supply the origin it is running on.
 *
 * The style document itself is checked with the same rule before the renderer sees it.
 */

export interface BasemapDescriptor {
  /** Same-origin absolute path to the style document, e.g. `/map/basemap/abc123/style.json`. */
  readonly styleUrl: string;
  /**
   * Attribution rendered next to the map as **plain text** (never as HTML). ODbL requires
   * it on every distribution, including when the renderer is unavailable.
   */
  readonly attribution: string;
  /**
   * Font family used for locally rendered Hangul/CJK glyphs. Those characters are
   * rasterised on the device and never produce a glyph request.
   */
  readonly localIdeographFontFamily?: string;
}

/**
 * Scheme used for every asset the renderer fetches. Rewriting the style onto our own
 * protocol means MapLibre never issues an ordinary http request for a tile, glyph or
 * sprite: it hands the request to our loader, which is the only place the real fetch
 * happens and the only place redirects can be refused. MapLibre's worker forwards
 * unknown-protocol requests to the main thread, so tiles are covered too.
 */
export const selfHostedScheme = 'geokit-self';
export const selfHostedPrefix = `${selfHostedScheme}://self`;

export type BasemapProblem =
  | 'ABSOLUTE_URL_NOT_ALLOWED'
  | 'PROTOCOL_RELATIVE_NOT_ALLOWED'
  | 'PATH_MUST_BE_ABSOLUTE'
  | 'PATH_TRAVERSAL_NOT_ALLOWED'
  | 'BACKSLASH_NOT_ALLOWED'
  | 'ENCODED_TRAVERSAL_NOT_ALLOWED'
  | 'CONTROL_CHARACTER_NOT_ALLOWED'
  | 'ORIGIN_MISMATCH'
  | 'INVALID_ORIGIN'
  | 'EMPTY_ATTRIBUTION'
  | 'ATTRIBUTION_MARKUP_NOT_ALLOWED';

export type BasemapValidation =
  { readonly ok: true } | { readonly ok: false; readonly problem: BasemapProblem };

/**
 * C0 controls, DEL and C1: a URL parser strips or reinterprets several of these, so they
 * must never reach it. An interior space is allowed because MapLibre asks for font stacks
 * by name (`Noto Sans Regular`) and a URL parser percent-encodes it rather than acting on
 * it; leading or trailing whitespace is rejected separately, because that *is* stripped.
 * Checked by code point rather than by a regular expression containing literal controls.
 */
function hasForbiddenCharacter(value: string): boolean {
  if (value !== value.trim()) return true;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * After percent-decoding, a path must still contain no traversal segment, no backslash
 * and no control character. `%2e%2e` decodes to `..`, which a URL parser then resolves
 * away — so checking only the raw text is not enough. Space is allowed here because
 * MapLibre percent-encodes font stack names such as `Noto%20Sans%20Regular`.
 */
function hasEncodedTraversalOrControl(path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }
  if (decoded.includes('\\')) return true;
  if (decoded.split('/').includes('..')) return true;
  for (const character of decoded) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Controls that must never appear in displayed attribution; tab and newline are fine. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Resolve a same-origin path with a real URL parser.
 *
 * Returns the resolved URL only when every one of these holds: no forbidden characters,
 * no backslash, no traversal segment, the input is an absolute path (not protocol
 * relative, not a scheme), and the parsed origin is **exactly** the given origin.
 */
export function resolveSameOriginPath(
  path: string,
  origin: string,
):
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly problem: BasemapProblem } {
  if (hasForbiddenCharacter(path)) return { ok: false, problem: 'CONTROL_CHARACTER_NOT_ALLOWED' };
  if (path.includes('\\')) return { ok: false, problem: 'BACKSLASH_NOT_ALLOWED' };
  if (path.startsWith('//')) return { ok: false, problem: 'PROTOCOL_RELATIVE_NOT_ALLOWED' };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path))
    return { ok: false, problem: 'ABSOLUTE_URL_NOT_ALLOWED' };
  if (!path.startsWith('/')) return { ok: false, problem: 'PATH_MUST_BE_ABSOLUTE' };
  if (path.split('/').includes('..')) return { ok: false, problem: 'PATH_TRAVERSAL_NOT_ALLOWED' };
  if (hasEncodedTraversalOrControl(path))
    return { ok: false, problem: 'ENCODED_TRAVERSAL_NOT_ALLOWED' };
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return { ok: false, problem: 'INVALID_ORIGIN' };
  }
  if (base.origin === 'null') return { ok: false, problem: 'INVALID_ORIGIN' };
  let resolved: URL;
  try {
    resolved = new URL(path, base);
  } catch {
    return { ok: false, problem: 'ORIGIN_MISMATCH' };
  }
  if (resolved.origin !== base.origin) return { ok: false, problem: 'ORIGIN_MISMATCH' };
  return { ok: true, url: resolved };
}

/**
 * Attribution shown by the renderer's own control is HTML. Only plain text and anchors
 * are allowed there: an `<img src="https://…">` inside attribution is a network request
 * that never passes through the renderer's request hook, and the installed sanitiser
 * does not remove it.
 */
export function validateAttributionMarkup(value: string): boolean {
  if (hasControlCharacter(value)) return false;
  const withoutAnchors = value
    .replace(/<a href="https?:\/\/[^"<>\s]+"(?: rel="[a-z ]{1,40}")?(?: target="_blank")?>/g, '')
    .replace(/<\/a>/g, '');
  return !withoutAnchors.includes('<') && !withoutAnchors.includes('>');
}

/**
 * @param origin the origin the page is running on, e.g. `globalThis.location.origin`.
 */
export function validateBasemap(basemap: BasemapDescriptor, origin: string): BasemapValidation {
  const resolved = resolveSameOriginPath(basemap.styleUrl, origin);
  if (!resolved.ok) return { ok: false, problem: resolved.problem };
  if (basemap.attribution.trim() === '') return { ok: false, problem: 'EMPTY_ATTRIBUTION' };
  // The kit renders attribution as text, so markup there is never wanted.
  if (/[<>]/.test(basemap.attribution))
    return { ok: false, problem: 'ATTRIBUTION_MARKUP_NOT_ALLOWED' };
  return { ok: true };
}

export function assertBasemap(basemap: BasemapDescriptor, origin: string): void {
  const result = validateBasemap(basemap, origin);
  if (!result.ok) throw new Error(result.problem);
}

/** Network schemes that would take a request off our origin. `name:en` is a tag, not a URL. */
const networkScheme = /^(?:https?|ftp|ws|wss|data|blob):/i;

/**
 * Every string in a style document that would fetch from somewhere other than this
 * origin. `attribution` is checked separately by `validateAttributionMarkup`, because it
 * is display markup rather than a fetched resource.
 */
export function findExternalStyleReferences(style: unknown): string[] {
  const offenders: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (networkScheme.test(value) || value.startsWith('//') || value.includes('\\'))
        offenders.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'attribution') continue;
        visit(entry);
      }
    }
  };
  visit(style);
  return offenders;
}

export type StylePreparation =
  { readonly ok: true } | { readonly ok: false; readonly problem: string; readonly value: string };

/**
 * Check a self-hosted style document and rewrite its same-origin paths onto our own
 * protocol, which MapLibre accepts as an absolute URL for sprite, glyphs and tiles.
 * Mutates `style` only when the whole document passes.
 *
 * Rewriting is plain concatenation, not `new URL()`, because `{fontstack}`, `{range}`
 * and `{z}/{x}/{y}` must survive; the path has already been checked by a real parser.
 */
export function prepareSelfHostedStyle(
  style: Record<string, unknown>,
  origin: string,
): StylePreparation {
  const external = findExternalStyleReferences(style);
  const firstExternal = external[0];
  if (firstExternal !== undefined)
    return { ok: false, problem: 'EXTERNAL_STYLE_REFERENCE', value: firstExternal };

  const attributions: string[] = [];
  const collectAttribution = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) collectAttribution(entry);
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'attribution' && typeof entry === 'string') attributions.push(entry);
      else collectAttribution(entry);
    }
  };
  collectAttribution(style);
  for (const attribution of attributions) {
    if (!validateAttributionMarkup(attribution))
      return { ok: false, problem: 'ATTRIBUTION_MARKUP_NOT_ALLOWED', value: attribution };
  }

  const rewrites: { apply: () => void }[] = [];
  const plan = (value: unknown, assign: (next: string) => void): StylePreparation | null => {
    if (typeof value !== 'string') return null;
    const resolved = resolveSameOriginPath(value, origin);
    if (!resolved.ok) return { ok: false, problem: resolved.problem, value };
    rewrites.push({ apply: () => assign(`${selfHostedPrefix}${value}`) });
    return null;
  };

  const failures: StylePreparation[] = [];
  const record = (result: StylePreparation | null) => {
    if (result) failures.push(result);
  };
  if ('sprite' in style) record(plan(style.sprite, (next) => (style.sprite = next)));
  if ('glyphs' in style) record(plan(style.glyphs, (next) => (style.glyphs = next)));
  // TileJSON shape: a document fetched through `sources[].url` carries its own `tiles`
  // array at the top level, and the renderer merges its `attribution` into the source.
  if (Array.isArray(style.tiles)) {
    const tiles = style.tiles;
    tiles.forEach((tile, index) => record(plan(tile, (next) => (tiles[index] = next))));
  }
  const sources = style.sources;
  if (sources && typeof sources === 'object') {
    for (const source of Object.values(sources as Record<string, unknown>)) {
      if (!source || typeof source !== 'object') continue;
      const entry = source as Record<string, unknown>;
      if (Array.isArray(entry.tiles)) {
        const tiles = entry.tiles;
        tiles.forEach((tile, index) => record(plan(tile, (next) => (tiles[index] = next))));
      }
      if ('url' in entry) record(plan(entry.url, (next) => (entry.url = next)));
    }
  }
  const firstFailure = failures[0];
  if (firstFailure) return firstFailure;
  for (const rewrite of rewrites) rewrite.apply();
  return { ok: true };
}

export interface StyleFetchOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

/**
 * Fetch a self-hosted style document ourselves rather than letting the renderer do it.
 *
 * The renderer's own fetch of a style URL does not pass through its request hook, and it
 * follows redirects, so a 30x to another host would be honoured. Here the request is made
 * with `redirect: 'error'` and the responding URL's origin is compared again afterwards,
 * so a redirect off this origin fails instead of loading.
 */
export async function loadSelfHostedStyle(
  styleUrl: string,
  origin: string,
  options: StyleFetchOptions = {},
): Promise<Record<string, unknown>> {
  const resolved = resolveSameOriginPath(styleUrl, origin);
  if (!resolved.ok) throw new Error(`STYLE_URL_REJECTED: ${resolved.problem}`);
  const call = options.fetchImpl ?? fetch;
  const response = await call(resolved.url.href, {
    credentials: 'omit',
    cache: 'default',
    redirect: 'error',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error('STYLE_LOAD_FAILED');
  const responded = response.url === '' ? resolved.url.href : response.url;
  let respondedOrigin: string;
  try {
    respondedOrigin = new URL(responded).origin;
  } catch {
    throw new Error('STYLE_ORIGIN_CHANGED');
  }
  if (respondedOrigin !== new URL(origin).origin) throw new Error('STYLE_ORIGIN_CHANGED');
  const style = (await response.json()) as Record<string, unknown>;
  const prepared = prepareSelfHostedStyle(style, origin);
  if (!prepared.ok) throw new Error(prepared.problem);
  return style;
}

export interface SelfHostedRequest {
  readonly url: string;
  readonly type?: 'string' | 'json' | 'arrayBuffer' | 'image';
  readonly cache?: RequestCache;
}

export interface SelfHostedResponse {
  readonly data: unknown;
  readonly cacheControl?: string;
  readonly expires?: string;
  readonly etag?: string;
}

/**
 * The only place a basemap asset is actually fetched.
 *
 * A renderer request hook sees only the URL it is given; the renderer then follows
 * redirects itself, so a same-origin tile endpoint answering 302 to another host would
 * move there unnoticed. Here the fetch refuses redirects outright and the responding
 * URL's origin is compared again, so that cannot happen whatever the page's CSP says.
 */
export function createSelfHostedLoader(origin: string, fetchImpl: typeof fetch = fetch) {
  return async function load(
    request: SelfHostedRequest,
    abortController: { signal: AbortSignal },
  ): Promise<SelfHostedResponse> {
    const path = request.url.startsWith(selfHostedPrefix)
      ? request.url.slice(selfHostedPrefix.length)
      : null;
    const resolved = path === null ? null : resolveSameOriginPath(path, origin);
    if (!resolved?.ok) throw new Error('SELF_HOSTED_REQUEST_REJECTED');
    const response = await fetchImpl(resolved.url.href, {
      credentials: 'omit',
      redirect: 'error',
      signal: abortController.signal,
      ...(request.cache ? { cache: request.cache } : {}),
    });
    const responded = response.url === '' ? resolved.url.href : response.url;
    let respondedOrigin: string;
    try {
      respondedOrigin = new URL(responded).origin;
    } catch {
      throw new Error('SELF_HOSTED_ORIGIN_CHANGED');
    }
    if (respondedOrigin !== new URL(origin).origin) throw new Error('SELF_HOSTED_ORIGIN_CHANGED');
    if (!response.ok) throw new Error(`SELF_HOSTED_REQUEST_FAILED_${response.status}`);
    let data: unknown;
    if (request.type === 'json') {
      // A JSON response can be a TileJSON document, and the renderer merges its
      // `attribution` into the source and uses its `tiles` array. That is a second way in
      // for an external `<img>` or an external tile host, so every JSON body is checked
      // and rewritten exactly like the style document before it is handed over.
      const document = (await response.json()) as unknown;
      if (Array.isArray(document)) {
        // An array body has no TileJSON shape to rewrite, but it can still carry an
        // external reference, so it is checked rather than waved through.
        const offender = findExternalStyleReferences(document)[0];
        if (offender !== undefined)
          throw new Error('SELF_HOSTED_JSON_REJECTED_EXTERNAL_STYLE_REFERENCE');
      } else if (document && typeof document === 'object') {
        const prepared = prepareSelfHostedStyle(document as Record<string, unknown>, origin);
        if (!prepared.ok) throw new Error(`SELF_HOSTED_JSON_REJECTED_${prepared.problem}`);
      }
      data = document;
    } else if (request.type === 'string') {
      data = await response.text();
    } else {
      data = await response.arrayBuffer();
    }
    // `exactOptionalPropertyTypes`: absent headers must be omitted, not set to null.
    const cacheControl = response.headers.get('Cache-Control');
    const expires = response.headers.get('Expires');
    const etag = response.headers.get('ETag');
    return {
      data,
      ...(cacheControl === null ? {} : { cacheControl }),
      ...(expires === null ? {} : { expires }),
      ...(etag === null ? {} : { etag }),
    };
  };
}

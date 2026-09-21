/**
 * Self-hosted MapLibre style for the M2-01d basemap spike.
 *
 * Every URL in the produced style is relative to the serving origin. No absolute URL
 * and no external host may appear, so a browser rendering this style can only talk to us.
 * `assertSelfHostedStyle` is the mechanical check and the build fails if it trips.
 */

/** Local rendering of Hangul/CJK: those ranges never leave the device as glyph requests. */
export const localIdeographFontFamily = "'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif";

export const fontStack = 'Noto Sans Regular';

/**
 * @param {{ basePath: string, attribution: string, minzoom: number, maxzoom: number,
 *           bounds: [number, number, number, number], center: [number, number] }} options
 */
export function createBasemapStyle({ basePath, attribution, minzoom, maxzoom, bounds, center }) {
  const base = basePath.replace(/\/$/, '');
  return {
    version: 8,
    name: 'workout-manager-self-hosted',
    // MapLibre substitutes {fontstack}/{range}; both are served from our own origin.
    glyphs: `${base}/glyphs/{fontstack}/{range}.pbf`,
    sprite: `${base}/sprite`,
    sources: {
      basemap: {
        type: 'vector',
        tiles: [`${base}/tiles/{z}/{x}/{y}.pbf`],
        minzoom,
        maxzoom,
        bounds,
        attribution,
      },
    },
    center,
    zoom: 13,
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#eef1f5' } },
      {
        id: 'water',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'water',
        paint: { 'fill-color': '#bcd4e6' },
      },
      {
        id: 'structures',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'structures',
        minzoom: 13,
        paint: { 'fill-color': '#e2e6eb', 'fill-outline-color': '#d3d8df' },
      },
      {
        id: 'roads-minor',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        filter: ['!', ['in', ['get', 'highway'], ['literal', ['motorway', 'trunk', 'primary']]]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 15, 3],
        },
      },
      {
        id: 'roads-major',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        filter: ['in', ['get', 'highway'], ['literal', ['motorway', 'trunk', 'primary']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#f6d08a',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 15, 6],
        },
      },
      {
        id: 'park-icon',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'structures',
        minzoom: 13,
        filter: ['==', ['get', 'leisure'], 'park'],
        layout: { 'icon-image': 'park-dot', 'icon-allow-overlap': true },
      },
      {
        // Korean names exercise the local-ideograph path, not the glyph endpoint.
        id: 'road-label',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'roads',
        minzoom: 13,
        filter: ['has', 'name'],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name'],
          'text-font': [fontStack],
          'text-size': 11,
        },
        paint: { 'text-color': '#4a5260', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 },
      },
      {
        // Latin names exercise the self-hosted glyph endpoint.
        id: 'road-label-latin',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'roads',
        minzoom: 13,
        filter: ['has', 'name:en'],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name:en'],
          'text-font': [fontStack],
          'text-size': 10,
          'text-offset': [0, 1],
        },
        paint: { 'text-color': '#6b7280', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 },
      },
    ],
  };
}

/**
 * Reject any absolute or protocol-relative URL anywhere in a style document.
 * @param {unknown} style
 * @returns {string[]} offending values, empty when the style is self-hosted only
 */
export function findExternalReferences(style) {
  /** @type {string[]} */
  const offenders = [];
  const visit = (/** @type {unknown} */ value) => {
    if (typeof value === 'string') {
      // `name:en` is a tag key, not a URL, so only network schemes, protocol-relative
      // references and backslashes count. A backslash matters because a URL parser
      // resolves `\\host/x` against our origin as `https://host/x`.
      if (
        /^(?:https?|ftp|ws|wss|data|blob):/i.test(value) ||
        value.startsWith('//') ||
        value.includes('\\')
      )
        offenders.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        // Attribution is display text, not a fetched resource; it may carry a link.
        if (key === 'attribution') continue;
        visit(entry);
      }
    }
  };
  visit(style);
  return offenders;
}

/** @param {unknown} style */
export function assertSelfHostedStyle(style) {
  const offenders = findExternalReferences(style);
  if (offenders.length > 0)
    throw new Error(`EXTERNAL_STYLE_REFERENCE: ${offenders.slice(0, 5).join(', ')}`);
}

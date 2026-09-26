/**
 * ODbL notice and alteration-method record for the background tile build (M0-06b-odbl).
 *
 * self-hosted-map-adr.md §6 "공개 배포 전 이행 절차":
 *
 * - §4.2: every distributed artifact names the licence by URI next to the OSM copyright
 *   link. `assertOdblNotice` is the check, and `verifyStagedBuild` runs it on every
 *   artifact of a staged deployment before it can be published.
 * - §4.6 option (b): the method used to alter the extract is published with the
 *   deployment. `createBasemapDisclosure` assembles it from the values this build run
 *   actually used (the same values its build report records), and `renderBasemapAttribution`
 *   turns that document into `ATTRIBUTION.txt`. Nothing here is typed in by hand; a
 *   deployment whose `ATTRIBUTION.txt` is not the rendering of its `odbl-disclosure.json`
 *   is refused.
 *
 * The constants must equal `@workout/contracts/map-data-licence` (a test compares them);
 * this plain-Node script cannot import the TypeScript contract.
 *
 * This is how the ADR reads the licence text; it is not legal review.
 */
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
export const ODBL_LICENCE_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const DISCLOSURE_FILE = 'odbl-disclosure.json';
export const MAP_DATA_LICENCE_PAGE = '/map-data-licence';

/** HTML attribution for the renderer's own control: plain text and anchors only. */
export const basemapStyleAttribution = `지도 데이터 ${OSM_ATTRIBUTION} · 자체 생성 타일 · <a href="${OSM_COPYRIGHT_URL}">저작권</a> · <a href="${ODBL_LICENCE_URL}">ODbL 1.0</a>`;
/** The same notice without markup, for surfaces that render text rather than HTML. */
export const basemapAttributionText = `지도 데이터 ${OSM_ATTRIBUTION} · 자체 생성 타일 · ${OSM_COPYRIGHT_URL} · ODbL 1.0 ${ODBL_LICENCE_URL}`;

/**
 * @param {unknown} text
 * @param {string} where names the artifact in the error
 */
export function assertOdblNotice(text, where) {
  if (typeof text !== 'string' || !text.includes(OSM_COPYRIGHT_URL))
    throw new Error(`ODBL_NOTICE_MISSING: ${where} has no OpenStreetMap copyright link`);
  if (!text.includes(ODBL_LICENCE_URL))
    throw new Error(`ODBL_NOTICE_MISSING: ${where} has no ODbL 1.0 licence URI`);
}

/**
 * The extract's acquisition, from the artifacts that recorded it, in order of directness:
 * this run's download response; the record the downloader left beside a reused file; an
 * earlier build report run that downloaded the same bytes. Otherwise the date is `null`.
 *
 * @param {{
 *   download: { sourceId: string, url: string | null, sha256: string, lastModified?: string | null, etag?: string | null, reusedFromDisk: boolean },
 *   record: { sourceId: string, url: string, lastModified: string | null, etag: string | null } | null,
 *   earlierRuns: readonly unknown[],
 *   allowlistedUrl: string,
 * }} input
 */
export function resolveAcquisition({ download, record, earlierRuns, allowlistedUrl }) {
  if (!download.reusedFromDisk && download.url !== null)
    return {
      sourceId: download.sourceId,
      url: download.url,
      lastModified: download.lastModified ?? null,
      etag: download.etag ?? null,
      recordedBy: 'download-response',
    };
  if (record !== null && record.sourceId === download.sourceId)
    return { ...record, recordedBy: 'acquisition-record' };
  // Newest first: the last run that downloaded exactly these bytes.
  for (const run of [...earlierRuns].reverse()) {
    const source = run !== null && typeof run === 'object' ? Reflect.get(run, 'source') : null;
    if (
      source &&
      source.sha256 === download.sha256 &&
      source.sourceId === download.sourceId &&
      source.reusedFromDisk === false &&
      typeof source.url === 'string' &&
      typeof source.lastModified === 'string'
    )
      return {
        sourceId: download.sourceId,
        url: source.url,
        lastModified: source.lastModified,
        etag: typeof source.etag === 'string' ? source.etag : null,
        recordedBy: 'earlier-build-report',
      };
  }
  return {
    sourceId: download.sourceId,
    url: allowlistedUrl,
    lastModified: null,
    etag: null,
    recordedBy: 'none',
  };
}

/**
 * The deployment's §4.6 record. Every value is passed in by the build from what it ran.
 *
 * @param {{
 *   buildId: string, deploymentId: string, region: string,
 *   source: { sha256: string, bytes: number, acquisition: ReturnType<typeof resolveAcquisition> },
 *   alterationMethod: {
 *     description: string, layerFilters: readonly { layer: string, expressions: readonly string[] }[],
 *     osmiumExportFormat: string, tippecanoeArguments: readonly string[], minzoom: number, maxzoom: number,
 *     glyphRanges: readonly string[], scripts: Record<string, string>,
 *   },
 *   toolVersions: { osmium: string | null, tippecanoe: string | null, node: string },
 * }} input
 */
export function createBasemapDisclosure({
  buildId,
  deploymentId,
  region,
  source,
  alterationMethod,
  toolVersions,
}) {
  return {
    schemaVersion: 1,
    kind: 'basemap-tiles',
    licence: {
      name: 'ODbL-1.0',
      url: ODBL_LICENCE_URL,
      copyrightUrl: OSM_COPYRIGHT_URL,
      attribution: OSM_ATTRIBUTION,
    },
    buildId,
    deploymentId,
    region,
    source: { sha256: source.sha256, bytes: source.bytes, acquisition: source.acquisition },
    alterationMethod: {
      description: alterationMethod.description,
      layerFilters: alterationMethod.layerFilters.map(({ layer, expressions }) => ({
        layer,
        expressions: [...expressions],
      })),
      osmiumExportFormat: alterationMethod.osmiumExportFormat,
      tippecanoeArguments: [...alterationMethod.tippecanoeArguments],
      minzoom: alterationMethod.minzoom,
      maxzoom: alterationMethod.maxzoom,
      glyphRanges: [...alterationMethod.glyphRanges],
      scripts: { ...alterationMethod.scripts },
    },
    toolVersions: { ...toolVersions },
  };
}

/**
 * `ATTRIBUTION.txt` for a deployment. The first paragraph (up to the first blank line) is
 * the on-screen notice the shells read; everything after it is the alteration method.
 *
 * @param {ReturnType<typeof createBasemapDisclosure>} disclosure
 */
export function renderBasemapAttribution(disclosure) {
  const { source, alterationMethod: method } = disclosure;
  const lines = [
    'Background map tiles built by Workout Manager from an OpenStreetMap extract.',
    `Map data ${OSM_ATTRIBUTION} (${OSM_COPYRIGHT_URL}), available under the Open Database License 1.0 (${ODBL_LICENCE_URL}).`,
    '',
    'The tiles are a derived database of that data; ODbL attribution and share-alike apply to redistribution.',
    'Label glyphs: Noto Sans, SIL Open Font License 1.1 (see glyphs/OFL.txt).',
    'Sprite icons generated by this repository; no third-party asset.',
    '',
    `Alteration method (ODbL 4.6), generated from this deployment's build record (${DISCLOSURE_FILE}):`,
    `- build ${disclosure.buildId}, deployment ${disclosure.deploymentId}, region ${disclosure.region}`,
    `- extract ${source.acquisition.url}`,
    `  SHA-256 ${source.sha256}, ${source.bytes} bytes`,
    `  Last-Modified ${source.acquisition.lastModified ?? 'not recorded'} (${source.acquisition.recordedBy})`,
    `- ${method.description}`,
    ...method.layerFilters.map(
      ({ layer, expressions }) => `- layer ${layer}: osmium tags-filter ${expressions.join(' ')}`,
    ),
    `- osmium export: ${method.osmiumExportFormat}`,
    `- tippecanoe ${method.tippecanoeArguments.join(' ')}`,
    `- zoom ${method.minzoom}-${method.maxzoom}, glyph ranges ${method.glyphRanges.join(', ')}`,
    `- tools: osmium ${disclosure.toolVersions.osmium ?? 'unknown'}; tippecanoe ${disclosure.toolVersions.tippecanoe ?? 'unknown'}; node ${disclosure.toolVersions.node}`,
    ...Object.entries(method.scripts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, sha256]) => `- script ${path} SHA-256 ${sha256}`),
    `Public page: ${MAP_DATA_LICENCE_PAGE}`,
    '',
  ];
  return lines.join('\n');
}

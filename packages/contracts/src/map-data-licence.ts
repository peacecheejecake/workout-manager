import { z } from 'zod';

import { instantSchema } from './primitives.js';

/**
 * ODbL notice and the public "how this data was altered" record (M0-06b-odbl).
 *
 * The background tiles and the pedestrian routing graph are derived databases of
 * OpenStreetMap data, which is licensed under the Open Database License 1.0. Two of its
 * obligations are carried here (self-hosted-map-adr.md §6 "공개 배포 전 이행 절차"):
 *
 * - §4.2: every distribution names the licence by URI, next to the OSM copyright link.
 *   {@link carriesOdblNotice} is the one test every artifact and every screen notice meets.
 * - §4.6 option (b): the method used to alter the source extract is published instead of
 *   the derived database itself. The two disclosure documents below are that method,
 *   generated from build artifacts — the tile build's record and the graph's own manifest
 *   and derivation record — never typed by hand.
 *
 * These are the obligations as the ADR reads the licence text; it is not legal review.
 */
export const osmCopyrightUrl = 'https://www.openstreetmap.org/copyright';
export const odblLicenceUrl = 'https://opendatacommons.org/licenses/odbl/1-0/';
export const osmAttribution = '© OpenStreetMap contributors';

/** The public page (no sign-in) that shows both disclosures, in both shells. */
export const mapDataLicencePagePath = '/map-data-licence';
/** The unauthenticated API read of the routing graph disclosure. */
export const mapDataLicenceReadPath = '/bff/v1/map-data/licence';
/** The background deployment pointer and its disclosure file, public static assets. */
export const basemapPointerPath = '/map/basemap/current.json';
export const basemapDisclosureFile = 'odbl-disclosure.json';

/** True when `text` names both the OSM copyright page and the ODbL 1.0 licence URI. */
export function carriesOdblNotice(text: string): boolean {
  return text.includes(osmCopyrightUrl) && text.includes(odblLicenceUrl);
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 hex digest');
const httpsUrlSchema = z.url({ protocol: /^https$/ }).max(512);
const shortTextSchema = z.string().min(1).max(200);

const licenceSchema = z.strictObject({
  name: z.literal('ODbL-1.0'),
  url: z.literal(odblLicenceUrl),
  copyrightUrl: z.literal(osmCopyrightUrl),
  attribution: z.literal(osmAttribution),
});
export type MapDataLicence = z.infer<typeof licenceSchema>;
export const mapDataLicence: MapDataLicence = Object.freeze({
  name: 'ODbL-1.0',
  url: odblLicenceUrl,
  copyrightUrl: osmCopyrightUrl,
  attribution: osmAttribution,
});

/**
 * Where an extract came from, as the acquisition recorded it. `lastModified` is the
 * server's `Last-Modified` header of the download that produced these bytes, or `null`
 * when no build artifact recorded it — never a date filled in afterwards.
 */
export const extractAcquisitionSchema = z.strictObject({
  sourceId: z.string().regex(/^[a-z0-9-]{1,64}$/),
  url: httpsUrlSchema,
  lastModified: z.string().min(1).max(64).nullable(),
  etag: z.string().min(1).max(128).nullable(),
  /** Which artifact the date comes from. */
  recordedBy: z.enum(['download-response', 'acquisition-record', 'earlier-build-report', 'none']),
});
export type ExtractAcquisition = z.infer<typeof extractAcquisitionSchema>;

/**
 * The background tile deployment's record, written by `scripts/build-basemap.mjs` as
 * `<deployment>/odbl-disclosure.json` from the same values its build report holds.
 * `ATTRIBUTION.txt` in the same directory is rendered from this document.
 */
export const basemapDataDisclosureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('basemap-tiles'),
  licence: licenceSchema,
  buildId: z.string().regex(/^[0-9a-f]{12}$/),
  deploymentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  region: shortTextSchema,
  source: z.strictObject({
    sha256: sha256Schema,
    bytes: z.number().int().positive(),
    acquisition: extractAcquisitionSchema,
  }),
  alterationMethod: z.strictObject({
    description: z.string().min(1).max(1000),
    layerFilters: z
      .array(
        z.strictObject({
          layer: z.string().regex(/^[a-z]{1,32}$/),
          expressions: z.array(z.string().min(1).max(200)).min(1).max(32),
        }),
      )
      .min(1)
      .max(32),
    osmiumExportFormat: shortTextSchema,
    tippecanoeArguments: z.array(z.string().min(1).max(1000)).min(1).max(128),
    minzoom: z.number().int().min(0).max(24),
    maxzoom: z.number().int().min(0).max(24),
    glyphRanges: z.array(z.string().regex(/^[0-9]{1,5}-[0-9]{1,5}$/)).max(64),
    /** SHA-256 of every script that defines the alteration, by repository path. */
    scripts: z
      .record(z.string().regex(/^scripts\/[A-Za-z0-9/_.-]{1,120}$/), sha256Schema)
      .refine((scripts) => Object.keys(scripts).length > 0),
  }),
  toolVersions: z.strictObject({
    osmium: z.string().min(1).max(200).nullable(),
    tippecanoe: z.string().min(1).max(200).nullable(),
    node: z.string().min(1).max(64),
  }),
});
export type BasemapDataDisclosure = z.infer<typeof basemapDataDisclosureSchema>;

/**
 * The derivation a graph was imported through (M2-01ay): the pinned extract with barrier
 * nodes inserted where a walkable way crosses a military perimeter. Read from the graph's
 * `edge-facts/derivation.json`, which the graph content hash covers.
 */
export const routingDerivationSchema = z.strictObject({
  osmium: z.string().min(1).max(200).nullable(),
  militaryPerimeterBarriers: z
    .strictObject({
      tool: z.string().regex(/^scripts\/[A-Za-z0-9/_.-]{1,120}$/),
      toolSha256: sha256Schema,
      summary: z.record(z.string().regex(/^[A-Za-z]{1,64}$/), z.number().int().nonnegative()),
      changesSha256: sha256Schema,
      derivedExtractSha256: sha256Schema,
      keptHeaderOptions: z.array(z.string().min(1).max(300)).max(16),
    })
    .nullable(),
  /** How many ways the graph lists as time-conditional; `null` when it lists none at all. */
  timeConditionalWays: z.number().int().nonnegative().nullable(),
});
export type RoutingDerivation = z.infer<typeof routingDerivationSchema>;

/**
 * The routing graph the API is serving right now, described from its verified manifest and
 * derivation record.
 *
 * `artifactNotice` says whether the graph directory itself carries the notice:
 * `verified` — its `ATTRIBUTION.txt` is exactly what these facts render to; `missing` — the
 * graph was built before the build wrote one (it cannot be distributed as it is);
 * `mismatch` — a file is there but says something else.
 */
export const routingDataDisclosureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('routing-graph'),
  licence: licenceSchema,
  graph: z.strictObject({
    graphBuildId: z.string().regex(/^[0-9a-f]{16}$/),
    graphContentSha256: sha256Schema,
    graphImportedAt: instantSchema,
    roadDataAt: instantSchema,
  }),
  engine: z.strictObject({
    engine: z.literal('graphhopper'),
    engineVersion: z.string().min(1).max(64),
    engineArtifactSha256: sha256Schema,
  }),
  profile: z.strictObject({
    profileId: z.literal('foot-v1'),
    profileName: z.string().min(1).max(64),
    profileConfigSha256: sha256Schema,
  }),
  extract: z.strictObject({
    sha256: sha256Schema,
    region: z.string().min(1).max(120),
    byteLength: z.number().int().positive(),
    /** `null` for a graph whose build recorded no acquisition (built before M0-06b-odbl). */
    acquisition: extractAcquisitionSchema.nullable(),
  }),
  /** `null` for a graph imported from the pinned extract unchanged (before M2-01ay). */
  derivation: routingDerivationSchema.nullable(),
  artifactNotice: z.enum(['verified', 'missing', 'mismatch']),
});
export type RoutingDataDisclosure = z.infer<typeof routingDataDisclosureSchema>;

/** `GET /bff/v1/map-data/licence`. `routing` is `null` when this server computes no routes. */
export const mapDataLicenceResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  routing: routingDataDisclosureSchema.nullable(),
});
export type MapDataLicenceResponse = z.infer<typeof mapDataLicenceResponseSchema>;

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { GraphManifestError } from './graph-manifest.js';

/**
 * What a graph knows about its edges beyond what GraphHopper encodes (M2-01ay).
 *
 * GraphHopper 10.0 has no encoded value for an hour-of-day access condition: its
 * `foot_temporal_access` reads only date ranges (`OSMTemporalAccessParser` asks
 * `DateRangeParser`, which cannot read `yes @ 6:00-24:00`), and it cannot read `opening_hours` at
 * all. A walking route over such a way was therefore silent about it (M0-06b coverage review,
 * TIM-01). The build now lists, from the same extract, the OSM ways a pedestrian route can use
 * (`highway=*` or `route=ferry`) that carry `access:conditional`, `foot:conditional` or
 * `opening_hours`, and stores the list INSIDE the graph directory, so the graph content hash in
 * the manifest covers it. The graph encodes `osm_way_id`, the adapter asks for it as a path
 * detail, and a route over a listed way carries a warning.
 *
 * A graph built before M2-01ay has neither the list nor `osm_way_id`, and loads exactly as before
 * (`null`). A graph with `osm_way_id` and no list, or a list and no `osm_way_id`, is a broken
 * build and is refused: the adapter would otherwise either ask for a detail the engine does not
 * have or stay silent on a graph that promised to speak.
 */
export const EDGE_FACTS_DIRECTORY = 'edge-facts';
export const TIME_CONDITIONAL_WAYS_FILE = 'time-conditional-ways.json';

/** The access keys whose value can depend on the time of day, as the build selects them. */
export const timeConditionalKeys = [
  'access:conditional',
  'foot:conditional',
  'opening_hours',
] as const;

export const timeConditionalWaysSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('time-conditional-ways'),
  keys: z.tuple([
    z.literal('access:conditional'),
    z.literal('foot:conditional'),
    z.literal('opening_hours'),
  ]),
  /** Ascending, without duplicates. GraphHopper 10.0 stores a way id in 31 bits. */
  wayIds: z
    .array(z.number().int().positive().max(2_147_483_647))
    .max(1_000_000)
    .refine(
      (ids) => ids.every((id, index) => index === 0 || id > (ids[index - 1] ?? 0)),
      'Expected ascending, unique way ids',
    ),
});
export type TimeConditionalWays = z.infer<typeof timeConditionalWaysSchema>;

/**
 * Read-only by construction: the list is held in a closure, so nothing reachable from a
 * deployment can add or remove a way after the graph directory was verified.
 */
export interface GraphEdgeFacts {
  /** How many OSM ways carry an hour-of-day or opening-hours access condition. */
  readonly timeConditionalWayCount: number;
  /** Whether this OSM way carries one. */
  readonly isTimeConditionalWay: (wayId: number) => boolean;
}

export function graphEdgeFactsFrom(list: TimeConditionalWays): GraphEdgeFacts {
  const ids = new Set(list.wayIds);
  return Object.freeze({
    timeConditionalWayCount: ids.size,
    isTimeConditionalWay: (wayId: number) => ids.has(wayId),
  });
}

/**
 * The encoded values GraphHopper recorded in the graph it built (`graph.encoded_values` in
 * `properties.txt`, one escaped JSON object per value). A graph whose properties name none
 * (a test fixture) encodes none this module asks about.
 */
export async function graphEncodedValueNames(graphDirectory: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(graphDirectory, 'properties.txt'), 'utf8');
  } catch {
    throw new GraphManifestError('GRAPH_PROPERTIES_UNREADABLE', 'properties.txt is not readable');
  }
  const line = /^graph\.encoded_values=(.*)$/m.exec(text)?.[1] ?? '';
  return [...line.matchAll(/\\"name\\":\\"([a-z_]+)\\"/g)].map((match) => match[1] ?? '');
}

/**
 * The graph's edge facts, or `null` for a graph built before M2-01ay. Read once, when the
 * deployment is verified; the graph content hash has already been checked against the manifest,
 * so these are the bytes the build wrote.
 */
export async function loadGraphEdgeFacts(graphDirectory: string): Promise<GraphEdgeFacts | null> {
  const encodesWayIds = (await graphEncodedValueNames(graphDirectory)).includes('osm_way_id');
  let raw: string | null;
  try {
    raw = await readFile(
      join(graphDirectory, EDGE_FACTS_DIRECTORY, TIME_CONDITIONAL_WAYS_FILE),
      'utf8',
    );
  } catch {
    raw = null;
  }
  if (raw === null && !encodesWayIds) return null;
  if (raw === null)
    throw new GraphManifestError(
      'EDGE_FACTS_INVALID',
      'the graph encodes osm_way_id but has no time-conditional way list',
    );
  if (!encodesWayIds)
    throw new GraphManifestError(
      'EDGE_FACTS_INVALID',
      'the graph has a time-conditional way list but does not encode osm_way_id',
    );
  let parsed: TimeConditionalWays;
  try {
    parsed = timeConditionalWaysSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new GraphManifestError(
      'EDGE_FACTS_INVALID',
      error instanceof Error ? error.message.slice(0, 300) : undefined,
    );
  }
  return graphEdgeFactsFrom(parsed);
}

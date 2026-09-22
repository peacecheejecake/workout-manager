import type { ElevationDatasetDocument, PlaceDatasetDocument } from '@workout/contracts/geo-data';
import { describe, expect, it } from 'vitest';

import { createElevationIndex, createPlaceIndex } from '../src/geo-data.js';

/**
 * Our own place search and elevation (M2-01j).
 *
 * The identity in every answer is not decoration: licence, attribution, build time and
 * update cadence travel with the result because "which version of which data said this" is
 * part of the answer. The elevation tests fix the missing-data policy, which is the normal
 * case rather than an edge: unknown is `null`, never zero and never interpolated.
 */
const identity = {
  datasetVersion: 1 as const,
  region: 'Seoul (BBBike city extract)',
  sourceExtractSha256: 'a'.repeat(64),
  licence: 'ODbL-1.0',
  licenceUrl: 'https://www.openstreetmap.org/copyright',
  attribution: '© OpenStreetMap contributors',
  updateCadence: '월 1회',
  builtAt: '2026-09-22T00:00:00.000Z',
  bbox: [126.734, 37.413, 127.269, 37.715] as [number, number, number, number],
};

const places: PlaceDatasetDocument = {
  identity: { ...identity, kind: 'places', datasetId: '0123456789ab', featureCount: 3 },
  places: [
    {
      placeId: 'p1',
      name: '여의도한강공원',
      localName: 'Yeouido Hangang Park',
      kind: 'leisure:park',
      position: [126.933, 37.5277],
    },
    {
      placeId: 'p2',
      name: '여의도',
      localName: 'Yeouido',
      kind: 'railway:station',
      position: [126.9243, 37.5217],
    },
    {
      placeId: 'p3',
      name: '남산',
      localName: 'Namsan',
      kind: 'place:locality',
      position: [126.9882, 37.5512],
    },
  ],
};

const elevation: ElevationDatasetDocument = {
  identity: { ...identity, kind: 'elevation', datasetId: 'beef0123cafe', featureCount: 2 },
  maxSourceDistanceMeters: 150,
  points: [
    { position: [126.988, 37.5522], elevationMeters: 267 },
    { position: [127.0957, 37.5712], elevationMeters: 348 },
  ],
};

describe('self-hosted place search', () => {
  const index = createPlaceIndex(places);

  it('answers with the dataset that produced the result', () => {
    const result = index.search({ query: '남산', near: null });
    if (result.outcome !== 'results') throw new Error(result.outcome);
    expect(result.dataset.datasetId).toBe('0123456789ab');
    expect(result.dataset.licence).toBe('ODbL-1.0');
    expect(result.dataset.updateCadence).toBe('월 1회');
    expect(result.places.map((place) => place.name)).toEqual(['남산']);
  });

  it('matches a local-language name as well as the primary one', () => {
    const korean = index.search({ query: 'yeouido hangang', near: null });
    if (korean.outcome !== 'results') throw new Error(korean.outcome);
    expect(korean.places.map((place) => place.placeId)).toEqual(['p1']);
  });

  it('puts an exact match before a prefix and a prefix before a substring', () => {
    const result = index.search({ query: '여의도', near: null });
    if (result.outcome !== 'results') throw new Error(result.outcome);
    expect(result.places.map((place) => place.placeId)).toEqual(['p2', 'p1']);
  });

  it('orders by distance from a bias point when one is given, and reports it', () => {
    const result = index.search({ query: '여의도', near: [126.9779, 37.5663] });
    if (result.outcome !== 'results') throw new Error(result.outcome);
    expect(result.places.every((place) => place.distanceMeters !== null)).toBe(true);
    const withoutBias = index.search({ query: '여의도', near: null });
    if (withoutBias.outcome !== 'results') throw new Error(withoutBias.outcome);
    expect(withoutBias.places.every((place) => place.distanceMeters === null)).toBe(true);
  });

  it('says a bias point outside the region is outside it, rather than finding nothing', () => {
    const result = index.search({ query: '남산', near: [2.35, 48.85] });
    expect(result.outcome).toBe('outside_region');
  });

  /**
   * A query of nothing but whitespace is not a query.
   *
   * `placeSearchRequestSchema` requires one character, and `"   "` is one character. After
   * folding it is the empty string, and `indexOf('')` is 0 for every entry — so without
   * this the answer to a space is the first `courseLimits.placeResults` places in the
   * dataset, each ranked as a prefix match.
   */
  it('answers a whitespace-only query with nothing, not with everything', () => {
    for (const query of ['   ', '\t', ' \n ']) {
      const result = index.search({ query, near: null });
      if (result.outcome !== 'results') throw new Error('expected results');
      expect(result.places).toEqual([]);
      expect(result.matchCount).toBe(0);
    }
    // And a real query still finds things, so this is not "search is broken".
    const real = index.search({ query: '여의도', near: null });
    if (real.outcome !== 'results') throw new Error('expected results');
    expect(real.matchCount).toBeGreaterThan(0);
  });

  it('reports how many matched when it answers with fewer', () => {
    const many: PlaceDatasetDocument = {
      identity: { ...places.identity, featureCount: 40 },
      places: Array.from({ length: 40 }, (_unused, index_) => ({
        placeId: `many-${index_}`,
        name: `한강공원 ${index_}`,
        localName: null,
        kind: 'leisure:park',
        position: [126.95, 37.53] as [number, number],
      })),
    };
    const result = createPlaceIndex(many).search({ query: '한강공원', near: null });
    if (result.outcome !== 'results') throw new Error(result.outcome);
    expect(result.matchCount).toBe(40);
    expect(result.places).toHaveLength(20);
  });
});

describe('self-hosted elevation', () => {
  const index = createElevationIndex(elevation);

  it('gives a value only where the dataset has one within its radius', () => {
    const result = index.profile({
      geometry: {
        type: 'LineString',
        coordinates: [
          [126.988, 37.5522],
          [126.9885, 37.5522],
          [127.0, 37.56],
        ],
      },
    });
    if (result.outcome !== 'profile') throw new Error(result.outcome);
    expect(result.points[0]?.elevationMeters).toBe(267);
    expect(result.points[0]?.sourceDistanceMeters).toBe(0);
    expect(result.points[1]?.elevationMeters).toBe(267);
    // Beyond 150 m: unknown, and it says so rather than reaching for the nearest value.
    expect(result.points[2]?.elevationMeters).toBeNull();
    expect(result.points[2]?.sourceDistanceMeters).toBeNull();
    expect(result.knownCount).toBe(2);
  });

  it('never substitutes zero, interpolates or totals an ascent', () => {
    const result = index.profile({
      geometry: {
        type: 'LineString',
        coordinates: [
          [126.988, 37.5522],
          [126.995, 37.56],
          [127.0957, 37.5712],
        ],
      },
    });
    if (result.outcome !== 'profile') throw new Error(result.outcome);
    // The middle point lies between two known elevations and stays unknown.
    expect(result.points.map((point) => point.elevationMeters)).toEqual([267, null, 348]);
    expect(Object.keys(result)).not.toContain('ascentMeters');
    expect(Object.keys(result)).not.toContain('descentMeters');
  });

  it('samples a long line and says how many vertices it stands for', () => {
    const coordinates = Array.from(
      { length: 500 },
      (_unused, index_) => [126.988 + index_ * 0.0001, 37.5522] as [number, number],
    );
    const result = index.profile({ geometry: { type: 'LineString', coordinates } });
    if (result.outcome !== 'profile') throw new Error(result.outcome);
    expect(result.points).toHaveLength(200);
    expect(result.vertexCount).toBe(500);
    expect(result.points[0]?.vertexIndex).toBe(0);
    expect(result.points.at(-1)?.vertexIndex).toBe(499);
  });

  it('says a line outside the region is outside it', () => {
    const result = index.profile({
      geometry: {
        type: 'LineString',
        coordinates: [
          [2.35, 48.85],
          [2.36, 48.86],
        ],
      },
    });
    expect(result.outcome).toBe('outside_region');
  });

  /**
   * A point outside the dataset's **declared** box is still a point the dataset holds.
   *
   * Nothing enforces that points lie inside the box a dataset declares: the contract has
   * no such refinement and the builder copies a hard-coded rectangle rather than clipping
   * to it. In this product's own built artifact 232 of 821 elevation points are outside
   * it. So the scan is bounded by the cells that actually hold something — true by
   * construction — and not by the declared box, which would turn a known elevation into
   * "unknown". Measured on the built dataset: clamping to the box lost one known
   * elevation. Two independent probes agreed on that loss and differed on how many
   * out-of-box points are reachable at all (4 versus 8), since that total depends on
   * which legal position inside the box the probe starts from.
   */
  it('answers unknown for every vertex when the dataset holds no point at all', () => {
    // An empty dataset is allowed by the contract (an extract with no `ele` tag produces
    // one), and the scan bounds are derived from the points — so there are none to derive.
    // It must answer "unknown", not fail and not scan.
    const empty: ElevationDatasetDocument = {
      identity: { ...identity, kind: 'elevation', datasetId: 'e0e0e0e0e0e0', featureCount: 0 },
      maxSourceDistanceMeters: 150,
      points: [],
    };
    const result = createElevationIndex(empty).profile({
      geometry: {
        type: 'LineString',
        coordinates: [
          [126.99, 37.5],
          [126.991, 37.5],
        ],
      },
    });
    if (result.outcome !== 'profile') throw new Error(result.outcome);
    expect(result.points.map((point) => point.elevationMeters)).toEqual([null, null]);
    expect(result.knownCount).toBe(0);
  });

  it('still answers from a point that lies outside the declared bounding box', () => {
    const outside: ElevationDatasetDocument = {
      identity: {
        ...identity,
        kind: 'elevation',
        datasetId: 'ba5eba11beef',
        featureCount: 1,
        // The point below is east of this box — and east of the last CELL the box covers,
        // which is what makes the difference observable. The real extract overruns the
        // rectangle the builder declares in exactly this way.
        bbox: [126.734, 37.413, 126.9999, 37.715],
      },
      maxSourceDistanceMeters: 150,
      points: [{ position: [127.0005, 37.5], elevationMeters: 321 }],
    };
    // A legal query position: inside the declared box, and about 60 m from the point.
    const result = createElevationIndex(outside).profile({
      geometry: {
        type: 'LineString',
        coordinates: [
          [126.9998, 37.5],
          [126.99975, 37.5],
        ],
      },
    });
    if (result.outcome !== 'profile') throw new Error(result.outcome);
    expect(result.points[0]?.elevationMeters).toBe(321);
    expect(result.knownCount).toBe(result.points.length);
  });

  it('finds a point that is inside the radius but far east, where cells are narrow', () => {
    // A cell is `cos(latitude)` as wide as it is tall: 193 m at 80° rather than 1,110 m.
    // Sizing the east-west ring with the latitude figure stopped it short of a wide radius
    // and reported a point inside that radius as unknown.
    const far: ElevationDatasetDocument = {
      identity: {
        ...identity,
        kind: 'elevation',
        datasetId: 'c0ffee123456',
        featureCount: 1,
        bbox: [9.5, 79.5, 10.5, 80.5],
      },
      maxSourceDistanceMeters: 5_000,
      points: [{ position: [10.2, 80], elevationMeters: 120 }],
    };
    const result = createElevationIndex(far).profile({
      geometry: {
        type: 'LineString',
        coordinates: [
          [10, 80],
          [10.0001, 80],
        ],
      },
    });
    if (result.outcome !== 'profile') throw new Error(result.outcome);
    // 0.2° of longitude at 80° is about 3.9 km, well inside the 5 km radius.
    expect(result.points[0]?.elevationMeters).toBe(120);
    expect(result.points[0]?.sourceDistanceMeters).toBeLessThan(5_000);
    expect(result.knownCount).toBe(result.points.length);
  });

  it('reports the radius it used, so a reader knows what "unknown" means', () => {
    const result = index.profile({
      geometry: {
        type: 'LineString',
        coordinates: [
          [126.988, 37.5522],
          [126.9885, 37.5522],
        ],
      },
    });
    if (result.outcome !== 'profile') throw new Error(result.outcome);
    expect(result.maxSourceDistanceMeters).toBe(150);
  });
});

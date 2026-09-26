import { describe, expect, it } from 'vitest';

import {
  carriesOdblNotice,
  geoDatasetsDisclosureSchema,
  mapDataLicence,
  mapDataLicenceResponseSchema,
  odblLicenceUrl,
  osmCopyrightUrl,
} from '../src/map-data-licence.js';

/** ODbL §4.2 (M0-06b-odbl): the one test every artifact and screen notice meets. */
describe('the ODbL notice test', () => {
  it('needs both the OSM copyright page and the ODbL 1.0 licence URI', () => {
    expect(odblLicenceUrl).toBe('https://opendatacommons.org/licenses/odbl/1-0/');
    expect(carriesOdblNotice(`${osmCopyrightUrl} ${odblLicenceUrl}`)).toBe(true);
    expect(carriesOdblNotice(osmCopyrightUrl)).toBe(false);
    expect(carriesOdblNotice(`ODbL 1.0 ${odblLicenceUrl}`)).toBe(false);
    expect(carriesOdblNotice('© OpenStreetMap contributors (ODbL 1.0)')).toBe(false);
  });

  it('fixes the licence a disclosure may name', () => {
    expect(
      mapDataLicenceResponseSchema.parse({
        schemaVersion: 1,
        routing: null,
        geoDatasets: { kind: 'none' },
      }),
    ).toEqual({
      schemaVersion: 1,
      routing: null,
      geoDatasets: { kind: 'none' },
    });
    expect(mapDataLicence).toEqual({
      name: 'ODbL-1.0',
      url: odblLicenceUrl,
      copyrightUrl: osmCopyrightUrl,
      attribution: '© OpenStreetMap contributors',
    });
    expect(mapDataLicenceResponseSchema.parse({ schemaVersion: 1, routing: null })).toEqual({
      schemaVersion: 1,
      routing: null,
      geoDatasets: { kind: 'unavailable' },
    });
  });

  it('rejects a place/elevation disclosure without the ODbL licence URI', () => {
    const disclosure = {
      schemaVersion: 1,
      kind: 'geo-datasets',
      licence: mapDataLicence,
      datasets: { placesDatasetId: 'a'.repeat(12), elevationDatasetId: 'b'.repeat(12) },
      source: {
        sha256: 'c'.repeat(64),
        bytes: 100,
        acquisition: {
          sourceId: 'osm-extract-seoul',
          url: 'https://example.org/source.osm.pbf',
          lastModified: null,
          etag: null,
          recordedBy: 'none',
        },
      },
      alterationMethod: {
        description: 'Filter named nodes and explicit elevation tags.',
        placeFilters: ['n/place'],
        elevationFilters: ['n/ele'],
        maxElevationSourceDistanceMeters: 150,
        scripts: { 'scripts/build-geo-datasets.mjs': 'd'.repeat(64) },
      },
      toolVersions: { osmium: '1.18', node: 'v24.12.0' },
    };
    expect(geoDatasetsDisclosureSchema.safeParse(disclosure).success).toBe(true);
    expect(
      geoDatasetsDisclosureSchema.safeParse({
        ...disclosure,
        licence: { ...mapDataLicence, url: 'https://example.org/not-odbl' },
      }).success,
    ).toBe(false);
  });
});

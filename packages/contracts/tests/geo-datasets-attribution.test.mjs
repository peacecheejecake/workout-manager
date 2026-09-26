import { expect, it } from 'vitest';

import {
  geoDatasetsDisclosureSchema,
  renderGeoDatasetsAttribution as renderServerAttribution,
} from '../src/map-data-licence.ts';
import {
  createGeoDatasetDisclosure,
  renderGeoDatasetsAttribution as renderBuildAttribution,
} from '../../../scripts/build-geo-datasets.mjs';
import { allowedSource } from '../../../scripts/geo/sources.mjs';

it('renders the builder and public API notices from the same disclosure identically', () => {
  const source = allowedSource('osm-extract-seoul');
  const disclosure = createGeoDatasetDisclosure({
    placesDatasetId: 'a'.repeat(12),
    elevationDatasetId: 'b'.repeat(12),
    source: {
      sha256: 'c'.repeat(64),
      bytes: 123,
      acquisition: {
        sourceId: source.id,
        url: source.url,
        lastModified: null,
        etag: null,
        recordedBy: 'none',
      },
    },
    scripts: { 'scripts/build-geo-datasets.mjs': 'd'.repeat(64) },
    osmiumVersion: null,
  });
  expect(renderServerAttribution(geoDatasetsDisclosureSchema.parse(disclosure))).toBe(
    renderBuildAttribution(disclosure),
  );
});

'use client';

import { MapDataLicenceView } from '@workout/modules-courses/map-data-licence';

/** No authenticated workspace: anyone may read how the map data was made. */
export function MapDataLicencePage() {
  return <MapDataLicenceView />;
}

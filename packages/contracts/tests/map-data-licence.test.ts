import { describe, expect, it } from 'vitest';

import {
  carriesOdblNotice,
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
    expect(mapDataLicenceResponseSchema.parse({ schemaVersion: 1, routing: null })).toEqual({
      schemaVersion: 1,
      routing: null,
    });
    expect(mapDataLicence).toEqual({
      name: 'ODbL-1.0',
      url: odblLicenceUrl,
      copyrightUrl: osmCopyrightUrl,
      attribution: '© OpenStreetMap contributors',
    });
  });
});

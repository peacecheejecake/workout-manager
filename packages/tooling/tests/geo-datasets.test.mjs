import { describe, expect, it } from 'vitest';

import { elevationMetresOrNull } from '../../../scripts/build-geo-datasets.mjs';

/**
 * The build step that turns an OSM `ele` tag into a stored elevation (M2-01j).
 *
 * This is where a missing value can silently become a known one: `Number('')` is 0, and a
 * stored 0 is reported to a reader as a measured sea-level elevation rather than as "we
 * have no fact here". The lookup tests work from an already-built dataset, so they cannot
 * see this conversion at all — it is tested here.
 */
describe('elevation tag conversion', () => {
  it('treats an empty or blank tag as missing, never as 0 m', () => {
    expect(elevationMetresOrNull('')).toBeNull();
    expect(elevationMetresOrNull('   ')).toBeNull();
    expect(elevationMetresOrNull('\n\t')).toBeNull();
    expect(elevationMetresOrNull(undefined)).toBeNull();
    expect(elevationMetresOrNull(null)).toBeNull();
  });

  it('keeps a real zero, which is a measured value', () => {
    expect(elevationMetresOrNull('0')).toBe(0);
    expect(elevationMetresOrNull(' 0.0 ')).toBe(0);
  });

  it('drops a value that is not a plain number of metres rather than coercing it', () => {
    // Real OSM values: units, ranges, commas, feet, prose.
    for (const raw of ['123 m', '123m', '1,5', '12-15', '1e3', '약 200', 'approx 200', '200ft'])
      expect(elevationMetresOrNull(raw)).toBeNull();
  });

  it('refuses a value outside the range the contract accepts', () => {
    expect(elevationMetresOrNull('99999')).toBeNull();
    expect(elevationMetresOrNull('-99999')).toBeNull();
    expect(elevationMetresOrNull('8848')).toBe(8848);
  });

  it('reads an ordinary decimal', () => {
    expect(elevationMetresOrNull('267')).toBe(267);
    expect(elevationMetresOrNull('267.45')).toBe(267.45);
    expect(elevationMetresOrNull('-4.2')).toBe(-4.2);
    expect(elevationMetresOrNull('+31')).toBe(31);
  });
});

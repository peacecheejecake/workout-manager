import { describe, expect, it } from 'vitest';
import { timeDomainInViewport, viewportForTimeDomain } from '../src/linked-viewport';

const geometry = {
  path: {
    id: 'recorded',
    role: 'recorded' as const,
    revision: '1',
    positions: [
      [179, 37],
      [-179, 37.01],
      [127, 37.02],
    ] as const,
  },
  vertexSampleIds: ['a', 'b', 'c'],
};
const index = {
  bySampleId: new Map([
    ['a', { recordedAt: '2026-03-01T00:00:00Z' }],
    ['b', { recordedAt: '2026-03-01T00:00:10Z' }],
    ['c', { recordedAt: '2026-03-01T00:00:20Z' }],
  ]),
};

describe('linked chart and map viewport', () => {
  it('fits only samples in the chart domain across the antimeridian', () => {
    expect(
      viewportForTimeDomain(geometry, index, {
        start: Date.parse('2026-03-01T00:00:00Z'),
        end: Date.parse('2026-03-01T00:00:10Z'),
      }),
    ).toEqual({ west: 179, east: -179, south: 37, north: 37.01, crossesAntimeridian: true });
  });

  it('links a wrapped user viewport to the positioned source instants only', () => {
    const expected = {
      start: Date.parse('2026-03-01T00:00:00Z'),
      end: Date.parse('2026-03-01T00:00:10Z'),
    };
    expect(
      timeDomainInViewport(geometry, index, {
        west: 178,
        east: -178,
        south: 36,
        north: 38,
        crossesAntimeridian: true,
      }),
    ).toEqual(expected);
    expect(
      timeDomainInViewport(geometry, index, {
        west: 178,
        east: 182,
        south: 36,
        north: 38,
        crossesAntimeridian: false,
      }),
    ).toEqual(expected);
  });

  it('shows a lone visible instant and declines to invent a domain when none is visible', () => {
    expect(
      timeDomainInViewport(geometry, index, {
        west: 126,
        east: 128,
        south: 36,
        north: 38,
        crossesAntimeridian: false,
      }),
    ).toEqual({
      start: Date.parse('2026-03-01T00:00:20Z'),
      end: Date.parse('2026-03-01T00:00:20Z'),
    });
    expect(
      timeDomainInViewport(geometry, index, {
        west: 126,
        east: 128,
        south: 0,
        north: 1,
        crossesAntimeridian: false,
      }),
    ).toBeNull();
  });
});

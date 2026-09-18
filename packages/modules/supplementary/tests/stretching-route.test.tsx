import { describe, expect, it } from 'vitest';
import { parseStretchingRoute } from '../src/stretching-route';

describe('stretching shell route', () => {
  it('accepts the specialist index and versioned detail with optional Activity context', () => {
    expect(parseStretchingRoute('/stretching', null)).toEqual({
      exerciseId: null,
      activityId: null,
    });
    expect(
      parseStretchingRoute(
        '/stretching/exercises/22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
      ),
    ).toEqual({
      exerciseId: '22222222-2222-4222-8222-222222222222',
      activityId: '11111111-1111-4111-8111-111111111111',
    });
  });
  it.each([
    ['/stretching/exercises', null],
    ['/stretching/exercises/not-an-id', null],
    ['/stretching/exercises/22222222-2222-4222-8222-222222222222/other', null],
    ['/stretching', 'invalid'],
    ['/supplementary', null],
  ])('rejects invalid or unexpected route %s', (path, activityId) => {
    expect(parseStretchingRoute(path, activityId)).toBeNull();
  });
});

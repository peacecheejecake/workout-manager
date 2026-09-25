import { describe, expect, it } from 'vitest';
import { courseRouteKnowledgeSchema, type CoursePosition } from '@workout/contracts/courses';

import { greatCircleMeters } from '../src/geo.js';
import { routeKnowledgeFromPathDetails } from '../src/route-knowledge.js';

/** Six vertices due east, so five segments of known, slightly different lengths. */
const line: CoursePosition[] = [
  [126.97, 37.56],
  [126.971, 37.56],
  [126.972, 37.56],
  [126.973, 37.56],
  [126.974, 37.56],
  [126.975, 37.56],
];
const segment = (index: number) => {
  const from = line[index];
  const to = line[index + 1];
  if (!from || !to) throw new Error('no segment');
  return greatCircleMeters(from, to);
};
const tenth = (meters: number) => Math.round(meters * 10) / 10;
const sum = (...indices: number[]) => tenth(indices.reduce((total, i) => total + segment(i), 0));

describe('route knowledge from engine path details', () => {
  it('splits every fact into what the graph records and what it records nothing for', () => {
    const knowledge = routeKnowledgeFromPathDetails(line, {
      roadClass: [
        [0, 1, 'steps'],
        [1, 3, 'footway'],
        [3, 4, 'steps'],
        [4, 5, 'other'],
      ],
      roadAccess: [
        [0, 2, 'private'],
        [2, 5, 'yes'],
      ],
      footAccess: [
        [0, 4, true],
        [4, 5, false],
      ],
      surface: [
        [0, 1, 'asphalt'],
        [1, 2, 'missing'],
        [2, 4, 'paving_stones'],
        [4, 5, 'missing'],
      ],
    });
    expect(courseRouteKnowledgeSchema.parse(knowledge)).toEqual(knowledge);
    // Two stairways, separate stretches; `other` is an unknown class, not "no stairs".
    expect(knowledge.stairs).toEqual({
      status: 'reported',
      known: [
        { value: 'steps', meters: sum(0, 3), sections: 2 },
        { value: 'not_steps', meters: sum(1, 2), sections: 1 },
      ].sort((left, right) => right.meters - left.meters),
      unknownMeters: sum(4),
    });
    // `missing` is no tag at all: unknown, however it is split.
    expect(knowledge.surface).toEqual({
      status: 'reported',
      known: [
        { value: 'paving_stones', meters: sum(2, 3), sections: 1 },
        { value: 'asphalt', meters: sum(0), sections: 1 },
      ],
      unknownMeters: sum(1, 4),
    });
    // `road_access=yes` is not a finding; a stretch with no restriction on record is unknown.
    expect(knowledge.accessRestrictions).toEqual({
      status: 'reported',
      known: [
        { value: 'road_access=private', meters: sum(0, 1), sections: 1 },
        { value: 'foot_access=no', meters: sum(4), sections: 1 },
      ],
      unknownMeters: sum(2, 3),
    });
    expect(knowledge.nightAccess).toBe('unknown');
    expect(knowledge.gradient).toBe('unknown');
  });

  it('keeps a detail the engine did not report apart from one it reported as clean', () => {
    const knowledge = routeKnowledgeFromPathDetails(line, {
      roadClass: [[0, 5, 'footway']],
      roadAccess: null,
      footAccess: null,
      surface: null,
    });
    expect(knowledge.surface).toEqual({ status: 'not_reported' });
    expect(knowledge.accessRestrictions).toEqual({ status: 'not_reported' });
    expect(knowledge.stairs).toEqual({
      status: 'reported',
      known: [{ value: 'not_steps', meters: sum(0, 1, 2, 3, 4), sections: 1 }],
      unknownMeters: 0,
    });
  });

  it('counts a stretch carrying two restrictions under both, once in the line', () => {
    const knowledge = routeKnowledgeFromPathDetails(line, {
      roadClass: [[0, 5, 'footway']],
      roadAccess: [[0, 5, 'no']],
      footAccess: [[0, 5, false]],
      surface: [[0, 5, 'missing']],
    });
    expect(knowledge.accessRestrictions).toEqual({
      status: 'reported',
      known: [
        { value: 'road_access=no', meters: sum(0, 1, 2, 3, 4), sections: 1 },
        { value: 'foot_access=no', meters: sum(0, 1, 2, 3, 4), sections: 1 },
      ],
      unknownMeters: 0,
    });
  });

  it('reads a value it cannot name as unknown rather than guessing', () => {
    const knowledge = routeKnowledgeFromPathDetails(line, {
      roadClass: [[0, 5, 'footway']],
      roadAccess: [[0, 5, 'permit_only']],
      footAccess: [[0, 5, true]],
      surface: [[0, 5, 'metal_grating']],
    });
    expect(knowledge.surface).toEqual({
      status: 'reported',
      known: [],
      unknownMeters: sum(0, 1, 2, 3, 4),
    });
    expect(knowledge.accessRestrictions).toEqual({
      status: 'reported',
      known: [],
      unknownMeters: sum(0, 1, 2, 3, 4),
    });
  });
});

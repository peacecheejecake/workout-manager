import { describe, expect, it } from 'vitest';

import {
  courseDisclosureConfirmationRequestSchema,
  courseShareCreateRequestSchema,
  courseSharingLimits,
  sharedCourseSchema,
} from '../src/course-sharing';

/** M2-01k-o: the contract refuses what the requirement forbids, before any server logic. */
describe('course sharing contract', () => {
  const confirmation = {
    purpose: 'export',
    expectedRevision: 1,
    acknowledgedZoneSetDigest: 'a'.repeat(64),
    exposure: 'owner-exact',
    includeNames: true,
    acknowledgedRisk: true,
  } as const;

  it('never lets a link be confirmed on an exact line (D3b, D3c, T20(4))', () => {
    expect(courseDisclosureConfirmationRequestSchema.safeParse(confirmation).success).toBe(true);
    for (const exposure of ['owner-exact', 'no-zones-exact'] as const)
      expect(
        courseDisclosureConfirmationRequestSchema.safeParse({
          ...confirmation,
          purpose: 'share',
          exposure,
        }).success,
      ).toBe(false);
    for (const exposure of ['trimmed', 'no-zone-intersection'] as const)
      expect(
        courseDisclosureConfirmationRequestSchema.safeParse({
          ...confirmation,
          purpose: 'share',
          exposure,
        }).success,
      ).toBe(true);
  });

  it('refuses a link longer than thirty days rather than clamping it (D2)', () => {
    const receiptId = '11111111-1111-4111-8111-111111111111';
    expect(courseShareCreateRequestSchema.parse({ receiptId })).toEqual({ receiptId });
    expect(courseShareCreateRequestSchema.safeParse({ receiptId, expiresInDays: 30 }).success).toBe(
      true,
    );
    expect(courseShareCreateRequestSchema.safeParse({ receiptId, expiresInDays: 31 }).success).toBe(
      false,
    );
    expect(courseSharingLimits.shareExpiryDefaultDays).toBe(7);
  });

  it('reads the recipient answer as a strict allowlist (B-3, R9)', () => {
    const answer = {
      coordinates: [
        [127.02227, 37.5],
        [127.03, 37.51],
      ],
      waypoints: [
        { role: 'start', position: [127.02227, 37.5] },
        { role: 'finish', position: [127.03, 37.51] },
      ],
      distanceMeters: 1200,
      expiresOn: '2026-10-02',
    };
    expect(sharedCourseSchema.parse(answer)).toEqual(answer);
    for (const extra of [
      { courseId: '11111111-1111-4111-8111-111111111111' },
      { revisionId: '11111111-1111-4111-8111-111111111111' },
      { createdAt: '2026-09-25T00:00:00.000Z' },
      { generation: {} },
      { lineage: [] },
      { trimmed: true },
      { exposure: 'trimmed' },
      { elevation: [] },
    ])
      expect(sharedCourseSchema.safeParse({ ...answer, ...extra }).success).toBe(false);
    expect(
      sharedCourseSchema.safeParse({ ...answer, expiresOn: '2026-10-02T00:00:00.000Z' }).success,
    ).toBe(false);
    expect(
      sharedCourseSchema.safeParse({
        ...answer,
        waypoints: [{ ...answer.waypoints[0], sourceSampleId: '0:0' }, answer.waypoints[1]],
      }).success,
    ).toBe(false);
  });
});

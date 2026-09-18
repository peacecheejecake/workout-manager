import { describe, expect, it } from 'vitest';

import { jointCandidateDiffV3Schema, jointCandidateIssueV3Schema } from '../src/joint-coaching.js';

describe('joint candidate nutrition item IDs', () => {
  it('preserves the existing non-UUID nutrition item identity in impact and issue records', () => {
    const itemId = 'meal-before';
    const diff = jointCandidateDiffV3Schema.parse({
      definitionVersion: 'joint-candidate-diff-v3',
      training: null,
      nutrition: [],
      relativeImpacts: [
        {
          planId: '11111111-1111-4111-8111-111111111111',
          itemId,
          sessionId: 'session-1',
          point: 'start',
          resolution: 'requires_reprojection',
        },
      ],
    });
    const issue = jointCandidateIssueV3Schema.parse({
      code: 'RELATIVE_NUTRITION_REQUIRES_COMBINED',
      subject: { kind: 'nutrition_item', id: itemId },
    });

    expect(diff.relativeImpacts[0]?.itemId).toBe(itemId);
    expect(issue.subject).toEqual({ kind: 'nutrition_item', id: itemId });
  });
});

import { expect, it } from 'vitest';
import { nutritionPlanItemCoreSchema } from '../src/nutrition-core.js';
import {
  raceManualProjectionIntentSchema,
  raceManualPublicPrepareSchema,
  raceManualPublicApproveSchema,
} from '../src/race-manual-public.js';
const intent = {
  expectedEvent: { id: 'abcdefab-abcd-7abc-8abc-000000000001', revision: 1 },
  newLocalDate: '2026-10-09',
  selection: { kind: 'keep_plan' },
};
it('keeps the established empty resolutions default without exposing a server basis', () => {
  expect(raceManualPublicPrepareSchema.parse({ schemaVersion: 1, intent }).intent).toEqual({
    ...intent,
    resolutions: { nutrition: [], routines: [] },
  });
});
it.each(['expectedBasis', 'capture', 'sourceInventory', 'recipes', 'authority'])(
  'rejects client %s at prepare and intent boundaries',
  (field) => {
    expect(
      raceManualPublicPrepareSchema.safeParse({ schemaVersion: 1, intent, [field]: {} }).success,
    ).toBe(false);
    expect(raceManualProjectionIntentSchema.safeParse({ ...intent, [field]: {} }).success).toBe(
      false,
    );
  },
);
it('retains the exact move-period intent and refuses fabricated missing plan identity', () => {
  const raw = {
    ...intent,
    selection: {
      kind: 'move_period',
      expectedCurrentPlanVersionId: intent.expectedEvent.id,
      periodId: 'base',
      newStartDate: '2026-10-09',
      scope: 'descendants_and_sessions',
    },
  };
  expect(raceManualProjectionIntentSchema.parse(raw).selection).toEqual(raw.selection);
  expect(
    raceManualProjectionIntentSchema.safeParse({
      ...raw,
      selection: { ...raw.selection, expectedCurrentPlanVersionId: null },
    }).success,
  ).toBe(false);
});
it('requires explicit confirmation and an exact stored digest for public approval', () => {
  const raw = { schemaVersion: 1, confirmed: true, applicationDigest: 'a'.repeat(64) };
  expect(raceManualPublicApproveSchema.parse(raw)).toEqual(raw);
  expect(raceManualPublicApproveSchema.safeParse({ ...raw, confirmed: false }).success).toBe(false);
  expect(
    raceManualPublicApproveSchema.safeParse({ ...raw, applicationDigest: 'bad' }).success,
  ).toBe(false);
});
it.each(['expectedBasis', 'chain', 'expectation', 'raceChange', 'writes', 'athleteId'])(
  'rejects client %s overrides at public approval',
  (field) => {
    expect(
      raceManualPublicApproveSchema.safeParse({
        schemaVersion: 1,
        confirmed: true,
        applicationDigest: 'a'.repeat(64),
        [field]: {},
      }).success,
    ).toBe(false);
  },
);

it.each(['x'.repeat(201), '한글항목'.repeat(60)])(
  'accepts exact canonical nutrition item identity: %s',
  (itemId) => {
    expect(nutritionPlanItemCoreSchema.shape.id.safeParse(itemId).success).toBe(true);
    const raw = {
      ...intent,
      resolutions: {
        nutrition: [
          {
            planVersionId: intent.expectedEvent.id,
            itemId,
            action: 'replace_anchor',
            anchor: {
              kind: 'relative',
              entity: 'session',
              entityId: 'session-1',
              point: 'end',
              offsetMinutes: 30,
            },
          },
        ],
        routines: [],
      },
    };
    expect(raceManualProjectionIntentSchema.parse(raw).resolutions.nutrition[0]?.itemId).toBe(
      itemId,
    );
  },
);

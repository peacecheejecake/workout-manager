import { createHash } from 'node:crypto';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { nutritionPlanVersionV3Schema } from '@workout/contracts/nutrition-race-plan-v3';
import {
  parseNutritionCurrentArtifact,
  nutritionCurrentRowsSha256,
  NUTRITION_CURRENT_MAX_BYTES,
  type NutritionCurrentPreparationRow,
} from '../src/restore-nutrition-current-artifact.js';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const at = '2026-10-07T00:00:00.123456Z';
const hash = 'a'.repeat(64);
function fixture(itemId = '음식'.repeat(150)) {
  const saved = nutritionPlanVersionV3Schema.parse({
    schemaVersion: 3,
    planId: id(2),
    versionId: id(3),
    version: 1,
    previousVersionId: null,
    approvalId: id(4),
    approvedAt: at,
    period: { from: '2026-10-07', toInclusive: '2026-10-07' },
    timezone: 'UTC',
    purpose: 'Retained food',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: itemId,
        planVersionId: id(3),
        category: 'meal',
        title: 'Meal',
        anchor: { kind: 'disconnected', entity: 'race' },
        foods: [
          {
            foodVersionId: null,
            description: 'Preserved food',
            quantity: 0,
            unit: 'g',
            sourceBasis: 'manual_total',
          },
        ],
        targets: [],
        instructions: 'Eat the retained meal',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
    raceTimingPins: [],
    itemRaceTimingBindings: [],
  });
  const rows: NutritionCurrentPreparationRow[] = [
    {
      relation: 'nutrition_plan_version',
      row: {
        athlete_id: id(1),
        plan_id: id(2),
        version_id: id(3),
        version: 1,
        previous_version_id: null,
        previous_version: null,
        period_from: '2026-10-07',
        period_to: '2026-10-07',
        linked_training_plan_version_id: null,
        approval_id: id(4),
        approved_at: at,
        record_json: saved,
      },
    },
    {
      relation: 'nutrition_plan_head',
      row: { athlete_id: id(1), plan_id: id(2), version_id: id(3), version: 1 },
    },
    {
      relation: 'nutrition_plan_history',
      row: {
        athlete_id: id(1),
        plan_id: id(2),
        version_id: id(3),
        approval_id: id(4),
        action: 'candidate_approved',
        created_at: at,
      },
    },
    {
      relation: 'original_race_deletion_v4',
      row: {
        athlete_id: id(1),
        event_id: id(5),
        record_version: 4,
        kind: 'race_event_deleted',
        target_id: id(6),
        occurred_at: at,
        race_previous_revision: 1,
        race_deleted_revision: 2,
      },
    },
    {
      relation: 'nutrition_race_item_disconnection',
      row: {
        athlete_id: id(1),
        version_id: id(3),
        item_key: `\\x${createHash('sha256').update(itemId).digest('hex')}`,
        item_id: itemId,
        event_id: id(5),
      },
    },
    {
      relation: 'integrated_candidate_v4',
      row: {
        athlete_id: id(1),
        id: id(7),
        proposal_id: id(8),
        digest: hash,
        body: null,
        purged_reason: 'source_deleted',
        created_at: at,
      },
    },
    {
      relation: 'nutrition_integrated_candidate_disconnection',
      row: {
        athlete_id: id(1),
        candidate_id: id(7),
        event_id: id(5),
        row_digest_version: 'postgres-row-jsonb-utc-v1',
        row_digest: 'b'.repeat(64),
        payload_digest_version: 'integrated-candidate-v4-canonical-v1',
        payload_digest: hash,
      },
    },
    {
      relation: 'integrated_candidate_app_admission_binding',
      row: {
        athlete_id: id(1),
        candidate_id: id(7),
        evidence_snapshot_id: id(9),
        binding_version: 1,
      },
    },
    {
      relation: 'integrated_approval_v4',
      row: {
        athlete_id: id(1),
        approval_id: id(4),
        candidate_id: id(7),
        proposal_id: id(8),
        proposal_digest: hash,
        write_domains: ['nutrition'],
        approved_at: at,
        result_json: {
          schemaVersion: 4,
          approvalId: id(4),
          candidateId: id(7),
          versions: [{ domain: 'nutrition', aggregateId: id(2), versionId: id(3) }],
          occurrenceIds: [],
          approvedAt: at,
        },
      },
    },
    {
      relation: 'approval_app_admission_binding',
      row: {
        athlete_id: id(1),
        receipt_key: 'original-integrated-receipt',
        candidate_id: null,
        integrated_candidate_id: id(7),
        integrated_approval_id: id(4),
        binding_version: 1,
        created_at: at,
      },
    },
    {
      relation: 'command_receipt',
      row: {
        athlete_id: id(1),
        idempotency_key: 'nutrition-plan:original',
        request: {
          receiptVersion: 2,
          digestVersion: 'postgres-jsonb-sha256-v1',
          requestDigest: hash,
        },
        result: {
          receiptVersion: 2,
          outcome: 'committed',
          kind: 'nutrition_plan',
          planId: id(2),
          versionId: id(3),
          version: 1,
          approvalId: id(4),
        },
      },
    },
  ];
  return rows;
}
function encode(rows: readonly NutritionCurrentPreparationRow[], extra: object = {}) {
  return Buffer.from(
    JSON.stringify({
      artifactVersion: 1,
      purpose: 'owner_restore_nutrition_current_preparation',
      sourceSchemaVersion: 108,
      ownerId: id(1),
      sourceRegistrySha256: hash,
      archiveSha256: hash,
      tailSha256: hash,
      count: rows.length,
      rowsSha256: nutritionCurrentRowsSha256(rows),
      rows,
      ...extra,
    }),
  );
}
function change(rows: NutritionCurrentPreparationRow[], relation: string, extra: object) {
  return rows.map((entry) =>
    entry.relation === relation ? { ...entry, row: { ...entry.row, ...extra } } : entry,
  );
}
function rawCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(rawCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${rawCanonical(v)}`)
      .join(',')}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('invalid test JSON');
  return text;
}
function parseChanged(relation: string, extra: object) {
  // Serialize adversarial boundary values without casting them to valid typed rows.
  const rows = fixture();
  const changed = change(rows, relation, extra);
  const original = z.record(z.string(), z.unknown()).parse(JSON.parse(encode(rows).toString()));
  original.rows = changed;
  original.rowsSha256 = createHash('sha256').update(rawCanonical(changed)).digest('hex');
  // The parser must validate wire structure before claiming the hash is valid.
  return parseNutritionCurrentArtifact(Buffer.from(JSON.stringify(original)));
}
describe('SQL108 finite private nutrition preparation (no authentication or importer)', () => {
  it('preserves long Unicode item IDs, zero food quantity, immutable approval facts and different digest namespaces', () => {
    const rows = fixture(),
      before = JSON.stringify(rows);
    const result = parseNutritionCurrentArtifact(encode(rows));
    expect(result.status).toBe('not_authenticated');
    expect(result.admissionAllowed).toBe(false);
    expect(result.body.rows).toEqual(rows);
    expect(JSON.stringify(rows)).toBe(before);
    expect(result.requiredExternalSources).toEqual([
      `command_receipt:original-integrated-receipt`,
      `core_evidence_snapshot:${id(9)}`,
    ]);
    expect(result).not.toHaveProperty('verified');
  });
  it.each([2, 3, 4] as const)(
    'accepts exact strict V%s unchanged absolute saved bytes without fabricating a race pin',
    (version) => {
      const rows = fixture('Meal').filter(
        (r) =>
          r.relation !== 'nutrition_race_item_disconnection' && r.relation !== 'command_receipt',
      );
      const next = rows.map((entry): NutritionCurrentPreparationRow =>
        entry.relation === 'nutrition_plan_version'
          ? {
              ...entry,
              row: {
                ...entry.row,
                record_json: {
                  ...entry.row.record_json,
                  schemaVersion: version,
                  items: entry.row.record_json.items.map((item) => ({
                    ...item,
                    anchor: {
                      kind: 'absolute',
                      date: '2026-10-07',
                      localTime: null,
                      timezone: 'UTC',
                    },
                  })),
                  raceTimingPins: [],
                  itemRaceTimingBindings: [],
                },
              },
            }
          : entry,
      );
      expect(parseNutritionCurrentArtifact(encode(next)).body.rows).toEqual(next);
    },
  );
  it.each([
    'nutrition_race_item_disconnection',
    'nutrition_integrated_candidate_disconnection',
    'integrated_candidate_app_admission_binding',
    'original_race_deletion_v4',
  ])('rejects missing %s rather than constructing authority', (relation) => {
    expect(() =>
      parseNutritionCurrentArtifact(encode(fixture().filter((r) => r.relation !== relation))),
    ).toThrow();
  });
  it('rejects byte-key collisions/fulltext mismatch and preserves item identity case', () => {
    expect(() =>
      parseChanged('nutrition_race_item_disconnection', { item_id: 'different' }),
    ).toThrow();
    expect(() =>
      parseChanged('nutrition_race_item_disconnection', { item_key: `\\x${'0'.repeat(64)}` }),
    ).toThrow();
    expect(() => parseChanged('nutrition_race_item_disconnection', { item_id: 'MEAL' })).toThrow();
  });
  it.each([
    'nutrition_plan_head',
    'nutrition_plan_history',
    'command_receipt',
    'nutrition_integrated_candidate_disconnection',
  ])('rejects foreign %s', (relation) => {
    expect(() => parseChanged(relation, { athlete_id: id(99) })).toThrow();
  });
  it('rejects unknown row/envelope fields and self-claimed signature/authority', () => {
    expect(() =>
      parseChanged('integrated_candidate_v4', { body: { rawRaceDate: '2026-10-07' } }),
    ).toThrow();
    expect(() => parseChanged('nutrition_plan_head', { unregistered: true })).toThrow();
    expect(() =>
      parseNutritionCurrentArtifact(encode(fixture(), { authenticated: true })),
    ).toThrow();
    expect(() => parseNutritionCurrentArtifact(encode(fixture(), { hmacSha256: hash }))).toThrow();
  });
  it('rejects duplicate rows, SQL composite version duplicates, and noncanonical UUID case', () => {
    const rows = fixture();
    expect(() => parseNutritionCurrentArtifact(encode([...rows, ...rows]))).toThrow();
    expect(() => parseChanged('nutrition_plan_head', { plan_id: id(2).toUpperCase() })).toThrow();
    const v = rows.find((r) => r.relation === 'nutrition_plan_version');
    if (!v || v.relation !== 'nutrition_plan_version') throw new Error('fixture missing');
    const sourceBody = nutritionPlanVersionV3Schema.parse(v.row.record_json);
    const repeated: NutritionCurrentPreparationRow = {
      ...v,
      row: {
        ...v.row,
        version_id: id(20),
        record_json: {
          ...sourceBody,
          versionId: id(20),
          items: sourceBody.items.map((item) => ({ ...item, planVersionId: id(20) })),
        },
      },
    };
    expect(() => parseNutritionCurrentArtifact(encode([...rows, repeated]))).toThrow();
  });
  it('rejects orphan tuple/history, wrong approval metadata, microsecond mismatch and original4 wrong revision', () => {
    expect(() => parseChanged('nutrition_plan_head', { version_id: id(99) })).toThrow();
    expect(() => parseChanged('nutrition_plan_history', { approval_id: id(99) })).toThrow();
    expect(() =>
      parseChanged('nutrition_plan_version', { approved_at: '2026-10-07T00:00:00.123457Z' }),
    ).toThrow();
    expect(() => parseChanged('original_race_deletion_v4', { race_deleted_revision: 3 })).toThrow();
    expect(() =>
      parseChanged('nutrition_integrated_candidate_disconnection', {
        payload_digest: 'c'.repeat(64),
      }),
    ).toThrow();
  });
  it('rejects absent previous versions rather than inventing prior history', () => {
    const rows = fixture();
    const next = rows.map((e): NutritionCurrentPreparationRow =>
      e.relation === 'nutrition_plan_version'
        ? {
            ...e,
            row: {
              ...e.row,
              version: 2,
              previous_version: 1,
              previous_version_id: id(19),
              record_json: { ...e.row.record_json, version: 2, previousVersionId: id(19) },
            },
          }
        : e,
    );
    expect(() => parseNutritionCurrentArtifact(encode(next))).toThrow();
  });
  it('preserves exact unaffected captured pin bytes and rejects deleted-source copied pins', () => {
    const rows = fixture('Meal').filter(
      (r) => r.relation !== 'nutrition_race_item_disconnection' && r.relation !== 'command_receipt',
    );
    function captured(event: string): NutritionCurrentPreparationRow[] {
      return rows.map((entry): NutritionCurrentPreparationRow =>
        entry.relation === 'nutrition_plan_version'
          ? {
              ...entry,
              row: {
                ...entry.row,
                record_json: {
                  ...entry.row.record_json,
                  schemaVersion: 2,
                  items: entry.row.record_json.items.map((item) => ({
                    ...item,
                    anchor: {
                      kind: 'relative',
                      entity: 'race',
                      entityId: event,
                      point: 'start',
                      offsetMinutes: -30,
                    },
                  })),
                  raceTimingPins: [
                    {
                      pinVersion: 1,
                      namespace: 'race-event-revision',
                      eventId: event,
                      eventRevision: 1,
                      sourceDigestVersion: 'race-event-values-canonical-v1',
                      sourceDigest: hash,
                      localDate: '2026-10-07',
                      localStartTime: null,
                      timezone: 'UTC',
                      start: { state: 'unknown', reason: 'start_time_not_recorded' },
                      end: { state: 'unknown', reason: 'race_end_not_recorded' },
                    },
                  ],
                  itemRaceTimingBindings: [
                    {
                      itemId: 'Meal',
                      binding: { state: 'captured', eventId: event, eventRevision: 1 },
                    },
                  ],
                },
              },
            }
          : entry,
      );
    }
    const unaffected = captured(id(22));
    expect(parseNutritionCurrentArtifact(encode(unaffected)).body.rows).toEqual(unaffected);
    expect(() => parseNutritionCurrentArtifact(encode(captured(id(6))))).toThrow();
  });
  it('rejects oversized saved bodies without accepting a valid inventory checksum as proof', () => {
    const rows = fixture();
    const changed = rows.map((entry): NutritionCurrentPreparationRow =>
      entry.relation === 'nutrition_plan_version'
        ? {
            ...entry,
            row: {
              ...entry.row,
              record_json: { ...entry.row.record_json, purpose: 'a'.repeat(524289) },
            },
          }
        : entry,
    );
    expect(() => parseNutritionCurrentArtifact(encode(changed))).toThrow();
  });
  it('accepts exact timestamp equivalent SQL representation without losing microseconds', () => {
    const rows = fixture();
    const changed = rows.map((entry): NutritionCurrentPreparationRow =>
      entry.relation === 'nutrition_plan_version'
        ? { ...entry, row: { ...entry.row, approved_at: '2026-10-07 00:00:00.123456+00' } }
        : entry,
    );
    expect(parseNutritionCurrentArtifact(encode(changed)).body.rows).toEqual(changed);
  });
  it('rejects input bytes/depth/rowcount/inventory hash bounds before any authentication', () => {
    expect(() =>
      parseNutritionCurrentArtifact(new Uint8Array(NUTRITION_CURRENT_MAX_BYTES + 1)),
    ).toThrow();
    expect(() =>
      parseNutritionCurrentArtifact(Buffer.from('['.repeat(65) + '0' + ']'.repeat(65))),
    ).toThrow();
    expect(() => parseNutritionCurrentArtifact(encode(fixture(), { count: 5001 }))).toThrow();
    expect(() =>
      parseNutritionCurrentArtifact(encode(fixture(), { rowsSha256: '0'.repeat(64) })),
    ).toThrow();
    expect(() => parseNutritionCurrentArtifact(Buffer.from([0xff]))).toThrow();
  });
});

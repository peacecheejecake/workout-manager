import { describe, expect, it } from 'vitest';
import type { Transaction } from '../src/database.js';
import {
  selectRaceManualOwnedProtocolIn,
  parseRaceManualReviewMultiOwnedSqlObservationV3,
  parseRaceManualReviewFullSqlObservationV2,
} from '../src/race-manual-review-full-owned-binding-consumer-v2.js';

// Synthetic pure-boundary observations are not SQL/source authentication evidence.
const eventId = 'abcdefab-1234-4123-8123-abcdefabcdef';
const planId = 'bbbbbbbb-1234-4123-8123-abcdefabcdef';
const versionId = 'cccccccc-1234-4123-8123-abcdefabcdef';
const sha = 'a'.repeat(64);
const eventRef = { kind: 'race-event', sourceId: eventId, revision: 1 };
function relation(role: string, table: string, key: readonly (string | number)[]) {
  return {
    role,
    relation: table,
    key: [...key],
    hashMethod: 'postgres-owned-relation-row-jsonb-utc-v2',
    sourceRowDigest: sha,
  };
}
function row(identity: unknown, ordinal: number, relations: ReturnType<typeof relation>[]) {
  return {
    ordinal,
    identity,
    state: 'observed',
    reason: null,
    relations,
    relationGroupHashMethod: 'postgres-owned-relation-group-jsonb-v2',
    relationGroupDigest: sha,
    cleanupHashMethod: 'postgres-narrow-cleanup-observation-jsonb-v1',
    cleanupObservationDigest: null,
  };
}
function eventRow() {
  return row(eventRef, 1, [relation('current_body', 'race_event', [eventId, 1])]);
}
function observation(rows: readonly unknown[] = [eventRow()]) {
  return {
    bindingVersion: 2,
    scope: 'prepared_full_context_relation_groups_only',
    hashMethod: 'postgres-owned-relation-row-jsonb-utc-v2',
    sqlRefsDigest: sha,
    transactionId: '123',
    callerRole: 'untrusted_caller',
    athleteId: 'untrusted_athlete',
    rows,
    storage: 'not_persisted',
    admissionAllowed: false,
    sourceCompleteness: 'unverified',
    authority: 'none',
    freshness: 'not_checked',
  };
}
function blocked(raw: unknown, refs: unknown = [eventRef]) {
  expect(parseRaceManualReviewFullSqlObservationV2(raw, refs).status).toBe('blocked');
}
describe('full SQL observation structural boundary', () => {
  it('accepts exact finite structure while retaining all non-authority limitations', () => {
    const parsed = parseRaceManualReviewFullSqlObservationV2(observation(), [eventRef]);
    expect(parsed.status).toBe('validated_structure');
    expect(parsed).toMatchObject({
      validationScope: 'structure_and_reference_membership_only',
      sqlDigestVerification: 'not_checked',
      sourceAuthentication: 'unverified',
      authority: 'none',
      freshness: 'not_checked',
      storage: 'not_persisted',
      admissionAllowed: false,
      approvalAllowed: false,
    });
  });
  it('hash-shaped values and caller/tenant/tx strings cannot establish authentication or a seal', () => {
    const raw = {
      ...observation(),
      sqlRefsDigest: 'b'.repeat(64),
      transactionId: '999',
      callerRole: 'forged_role',
      athleteId: 'forged_tenant',
    };
    const parsed = parseRaceManualReviewFullSqlObservationV2(raw, [eventRef]);
    expect(parsed.status).toBe('validated_structure');
    expect(parsed.authority).toBe('none');
    expect(parsed.sqlDigestVerification).toBe('not_checked');
  });
  it('rejects unknown envelope fields', () => blocked({ ...observation(), authenticated: true }));
  it('rejects unknown expected identity fields', () =>
    blocked(observation(), [{ ...eventRef, permission: true }]));
  it('rejects a different exact source revision key even with well-shaped hashes', () => {
    blocked(
      observation([row(eventRef, 1, [relation('current_body', 'race_event', [eventId, 2])])]),
    );
  });
  it('rejects wrong ordinal and identity order', () => {
    blocked(
      observation([row(eventRef, 2, [relation('current_body', 'race_event', [eventId, 1])])]),
    );
    const plan = { kind: 'nutrition-plan-version', sourceId: planId, versionId };
    blocked(
      observation([
        row(plan, 1, [
          relation('immutable_version', 'nutrition_plan_version', [planId, versionId]),
        ]),
        row(eventRef, 2, [relation('current_body', 'race_event', [eventId, 1])]),
      ]),
      [eventRef, plan],
    );
  });
  it('rejects malformed hashes', () => blocked({ ...observation(), sqlRefsDigest: 'not-a-hash' }));
  it('rejects normalized UUID alias duplicates in expected refs', () =>
    blocked(observation(), [eventRef, { ...eventRef, sourceId: eventId.toUpperCase() }]));
  it('requires exactly one full current race reference', () => blocked(observation(), []));
  it('rejects a relation from another namespace', () =>
    blocked(
      observation([
        row(eventRef, 1, [relation('immutable_version', 'nutrition_plan_version', [eventId, 1])]),
      ]),
    ));
  it('rejects duplicate exact relation membership', () => {
    const r = relation('current_body', 'race_event', [eventId, 1]);
    blocked(observation([row(eventRef, 1, [r, r])]));
  });
  it('keeps contentless unavailable facts without inventing bodies', () => {
    const unavailable = {
      ...row(eventRef, 1, []),
      state: 'unavailable',
      reason: 'source_unavailable',
      relationGroupDigest: null,
    };
    expect(
      parseRaceManualReviewFullSqlObservationV2({ ...observation(), rows: [unavailable] }, [
        eventRef,
      ]).status,
    ).toBe('validated_structure');
  });
  it('rejects unavailable facts that retain an unrelated copied relation', () => {
    blocked(
      observation([
        {
          ...row(eventRef, 1, [relation('current_body', 'race_event', [eventId, 1])]),
          state: 'unavailable',
          reason: 'source_unavailable',
        },
      ]),
    );
  });
  it('requires the saved nutrition parent for a pin fragment', () => {
    const nutrition = { kind: 'nutrition-plan-version', sourceId: planId, versionId };
    const pin = { kind: 'race-timing-pin-fragment', sourceId: eventId, revision: 1 };
    const rows = [
      eventRow(),
      row(nutrition, 2, [
        relation('immutable_version', 'nutrition_plan_version', [planId, versionId]),
      ]),
      row(pin, 3, [relation('pin_membership', 'nutrition_plan_version', [planId, versionId])]),
    ];
    expect(
      parseRaceManualReviewFullSqlObservationV2(observation(rows), [eventRef, nutrition, pin])
        .status,
    ).toBe('validated_structure');
    blocked(
      observation([
        eventRow(),
        row(pin, 2, [relation('pin_membership', 'nutrition_plan_version', [planId, versionId])]),
      ]),
      [eventRef, pin],
    );
  });
  it('preserves opaque intake IDs and numeric checkin revisions', () => {
    const intake = { kind: 'intake-revision', sourceId: '섭취 "opaque\\id', revisionId: versionId };
    const check = { kind: 'checkin-revision', sourceId: planId, revision: 2 };
    const rows = [
      eventRow(),
      row(intake, 2, [
        relation('immutable_revision', 'intake_entry_revision', [intake.sourceId, versionId]),
        relation('current_head', 'intake_entry', [intake.sourceId]),
      ]),
      row(check, 3, [
        relation('immutable_revision', 'check_in_revision', [planId, 2]),
        relation('current_head', 'check_in', [planId]),
      ]),
    ];
    expect(
      parseRaceManualReviewFullSqlObservationV2(observation(rows), [eventRef, intake, check])
        .status,
    ).toBe('validated_structure');
  });
  it('bounds relation visits across groups rather than per group only', () => {
    const template = { kind: 'workout-template-version', sourceId: planId, versionId };
    const relations = [
      relation('immutable_version', 'supplementary_routine_version', [planId, versionId]),
      ...Array.from({ length: 4999 }, (_, n) =>
        relation('target', 'supplementary_routine_target_ref', [versionId, String(n)]),
      ),
    ];
    blocked(observation([eventRow(), row(template, 2, relations)]), [eventRef, template]);
  });
  it('rejects oversized decoded metadata before schema access', () => {
    expect(
      parseRaceManualReviewFullSqlObservationV2(observation(), [
        { ...eventRef, sourceId: 'x'.repeat(4194305) },
      ]),
    ).toMatchObject({ status: 'blocked', reason: 'decoded_bound' });
  });
  it('rejects accessors, cycles and sparse arrays safely', () => {
    const accessor = { ...observation() };
    Object.defineProperty(accessor, 'rows', {
      enumerable: true,
      get() {
        throw Error('must not execute');
      },
    });
    blocked(accessor);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    blocked(cyclic);
    blocked(observation(), Array(1));
  });
});

describe('exact owned SQL protocol capability selection', () => {
  function port(value: unknown, failure?: Error) {
    const calls: { sql: string; values: unknown[] | undefined }[] = [];
    const tx: Transaction = {
      athleteId: 'synthetic',
      async query(sql, values) {
        calls.push({ sql, values });
        if (failure) throw failure;
        return { rows: [{ available: value }], rowCount: 1 };
      },
    };
    return { tx, calls };
  }
  it('selects only finite v3 symbols with actual EXECUTE capability and charges the same budget', async () => {
    const p = port(true),
      budget = { bytes: 10n, sources: 3 };
    expect(await selectRaceManualOwnedProtocolIn(p.tx, budget, 'observer')).toBe(
      'public.observe_manual_review_multi_owned_source_bindings_v3',
    );
    expect(await selectRaceManualOwnedProtocolIn(p.tx, budget, 'store')).toBe(
      'public.store_manual_race_multi_owned_chain_v3',
    );
    expect(budget).toEqual({ bytes: 138n, sources: 5 });
    expect(p.calls[0]?.sql).toContain('has_function_privilege');
    expect(p.calls[0]?.values).toEqual([
      'public.observe_manual_review_multi_owned_source_bindings_v3(jsonb)',
    ]);
  });
  it('valid false alone selects historical symbols', async () => {
    const p = port(false),
      budget = { bytes: 0n, sources: 0 };
    expect(await selectRaceManualOwnedProtocolIn(p.tx, budget, 'observer')).toBe(
      'public.observe_manual_review_full_owned_source_bindings_v2',
    );
    expect(await selectRaceManualOwnedProtocolIn(p.tx, budget, 'store')).toBe(
      'public.store_manual_race_chain_v2',
    );
  });
  it.each([null, 'false', 0, {}, undefined])(
    'malformed capability %s cannot trigger fallback',
    async (value) => {
      const p = port(value);
      await expect(
        selectRaceManualOwnedProtocolIn(p.tx, { bytes: 0n, sources: 0 }, 'observer'),
      ).rejects.toThrow();
      expect(p.calls).toHaveLength(1);
    },
  );
  it('actual query errors propagate without fallback calls', async () => {
    const failure = Error('synthetic permission failure'),
      p = port(true, failure);
    await expect(
      selectRaceManualOwnedProtocolIn(p.tx, { bytes: 0n, sources: 0 }, 'store'),
    ).rejects.toBe(failure);
    expect(p.calls).toHaveLength(1);
  });
  it('reserves bytes and visits before querying capability', async () => {
    for (const budget of [
      { bytes: 4194304n, sources: 0 },
      { bytes: 0n, sources: 5000 },
    ]) {
      const p = port(true);
      await expect(selectRaceManualOwnedProtocolIn(p.tx, budget, 'observer')).rejects.toThrow();
      expect(p.calls).toHaveLength(0);
    }
  });
});

describe('explicit multi-owned SQL v3 structural companion', () => {
  const otherRef = {
    kind: 'race-event',
    sourceId: 'dddddddd-1234-4123-8123-abcdefabcdef',
    revision: 2,
  };
  function multi() {
    return observation([
      eventRow(),
      row(otherRef, 2, [relation('current_body', 'race_event', [otherRef.sourceId, 2])]),
    ]);
  }
  it('new named parser accepts exact two-race wire2 while old V2 remains single-race', () => {
    const refs = [eventRef, otherRef],
      raw = multi();
    expect(parseRaceManualReviewFullSqlObservationV2(raw, refs)).toMatchObject({
      status: 'blocked',
      reason: 'invalid_expected_refs',
    });
    expect(parseRaceManualReviewMultiOwnedSqlObservationV3(raw, refs)).toMatchObject({
      status: 'validated_structure',
      authority: 'none',
      sourceAuthentication: 'unverified',
      freshness: 'not_checked',
      approvalAllowed: false,
      observation: { bindingVersion: 2 },
    });
  });
  it('both parsers preserve legitimate single-race structural compatibility', () => {
    expect(parseRaceManualReviewMultiOwnedSqlObservationV3(observation(), [eventRef])).toEqual(
      parseRaceManualReviewFullSqlObservationV2(observation(), [eventRef]),
    );
  });
  it('rejects missing, duplicate, extra and wrong revision roster correspondence', () => {
    for (const [raw, refs] of [
      [multi(), [eventRef]],
      [multi(), [eventRef, eventRef]],
      [multi(), [eventRef, { ...otherRef, revision: 3 }]],
      [observation(), [eventRef, otherRef]],
      [observation([]), []],
    ]) {
      expect(parseRaceManualReviewMultiOwnedSqlObservationV3(raw, refs).status).toBe('blocked');
    }
  });
  it('does not infer authority from a primary flag or authenticate foreign-looking tenant metadata', () => {
    expect(
      parseRaceManualReviewMultiOwnedSqlObservationV3({ ...multi(), primaryEvent: eventRef }, [
        eventRef,
        otherRef,
      ]).status,
    ).toBe('blocked');
    expect(
      parseRaceManualReviewMultiOwnedSqlObservationV3({ ...multi(), athleteId: 'forged' }, [
        eventRef,
        otherRef,
      ]),
    ).toMatchObject({
      status: 'validated_structure',
      authority: 'none',
      sourceAuthentication: 'unverified',
    });
  });
});

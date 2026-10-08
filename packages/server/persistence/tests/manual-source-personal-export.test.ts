import { expect, it, vi } from 'vitest';
import { planSnapshotSchema } from '@workout/contracts/planning';
import {
  mapManualSourcePersonalExportV1,
  isRenderedTrainingBeforeSource,
  readManualSourcePersonalExportV1In,
} from '../src/manual-source-personal-export.js';
import type { Transaction } from '../src/database.js';
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
const at = '2026-10-08T00:00:00.123456Z';
function first<T>(rows: T[]): T {
  const v = rows[0];
  if (v === undefined) throw Error('FIXTURE');
  return v;
}
const nutrition = { schemaVersion: 1, origins: [], lineage: [] };
function manual() {
  return {
    schemaVersion: 1,
    chains: [
      {
        evidenceId: id(1),
        decisionId: id(2),
        proposalId: id(3),
        savedRefCount: 1,
        savedParentCount: 1,
        savedSuppressionCount: 1,
        body: { state: 'purged', eventId: id(4), occurredAt: at },
        preparation: null,
      },
    ],
    refs: [
      {
        evidenceId: id(1),
        ordinal: 1,
        identity: { kind: 'race-event', sourceId: id(5), revision: 1 },
        dtoDigest: 'a'.repeat(64),
        copiedLocations: ['private.context.event'],
        sourceKind: null,
        trainingAggregateId: null,
        parentCoverage: 'saved_parents',
        existence: { basis: 'export_snapshot', state: 'deleted' },
        location: { state: 'unavailable', reason: 'payload_purged' },
      },
    ],
    parents: [
      {
        evidenceId: id(1),
        ordinal: 1,
        edge: {
          family: 'race-event',
          sourceId: id(5),
          versionKey: '1',
          role: 'source',
          membershipKey: null,
        },
      },
    ],
    suppressions: [
      {
        evidenceId: id(1),
        eventId: id(4),
        occurredAt: at,
        recordVersion: 4,
        kind: 'race_event_deleted',
        matchedRefOrdinals: [1],
      },
    ],
  };
}
it('preserves genuine-shaped saved ordinal/parent/event microseconds without raw copied paths or hash authority', () => {
  const output = mapManualSourcePersonalExportV1(manual(), nutrition);
  expect(output.sourceAuthentication).toBe('not_authenticated');
  expect(output.manualSavedSourceRefs[0]?.existence.state).toBe('deleted');
  expect(output.manualSavedSourceSuppressions[0]?.occurredAt).toBe(at);
  expect(JSON.stringify(output)).not.toContain('private.context');
  expect(JSON.stringify(output)).not.toContain('dtoDigest');
});
it('preserves absence as unavailable, not deletion', () => {
  const m = manual();
  first(m.refs).existence.state = 'unavailable';
  expect(
    mapManualSourcePersonalExportV1(m, nutrition).manualSavedSourceRefs[0]?.existence.state,
  ).toBe('unavailable');
});
it('rejects orphan parents and unmatched suppression ordinals', () => {
  const m = manual();
  first(m.parents).ordinal = 2;
  expect(() => mapManualSourcePersonalExportV1(m, nutrition)).toThrow('CORRUPT');
  const n = manual();
  first(n.suppressions).matchedRefOrdinals = [2];
  expect(() => mapManualSourcePersonalExportV1(n, nutrition)).toThrow('CORRUPT');
});
it('rejects invented body restoration, unknown identity fields and malformed parent versions', () => {
  const m = manual();
  first(m.chains).body.state = 'present';
  expect(() => mapManualSourcePersonalExportV1(m, nutrition)).toThrow('CORRUPT');
  expect(() =>
    mapManualSourcePersonalExportV1({ ...manual(), rawCredential: 'secret' }, nutrition),
  ).toThrow('CORRUPT');
  const n = manual();
  first(n.parents).edge.versionKey = 'not-a-revision';
  expect(() => mapManualSourcePersonalExportV1(n, nutrition)).toThrow('CORRUPT');
});
it('does not execute accessors at the unknown JSON boundary', () => {
  let invoked = 0;
  const raw = Object.defineProperty({}, 'chains', {
    enumerable: true,
    get() {
      invoked++;
      throw Error('GETTER');
    },
  });
  expect(() => mapManualSourcePersonalExportV1(raw, nutrition)).toThrow('CORRUPT');
  expect(invoked).toBe(0);
});
it('checks availability and shares actual measured response bytes across both RPCs once', async () => {
  const limits: unknown[] = [];
  const debits: number[] = [];
  const measured = [
    Buffer.byteLength(JSON.stringify(manual()), 'utf8') + 128,
    Buffer.byteLength(JSON.stringify(nutrition), 'utf8') + 32,
  ];
  let body = 0;
  const tx: Transaction = {
    athleteId: id(20),
    query: vi.fn(async (sql, values) => {
      if (sql.startsWith('SELECT to_regprocedure'))
        return { rows: [{ installed: true, executable: true }], rowCount: 1 };
      limits.push(values?.[0]);
      body++;
      return {
        rows: [{ bytes: String(measured[body - 1]), source: body === 1 ? manual() : nutrition }],
        rowCount: 1,
      };
    }),
  };
  await readManualSourcePersonalExportV1In(tx, 10000, (n) => debits.push(n));
  expect(limits).toEqual([10000, 10000 - first(measured)]);
  expect(debits).toEqual(measured);
});
it('unavailable capability returns failure before any source RPC', async () => {
  const query = vi.fn(async () => ({
    rows: [{ installed: false, executable: false }],
    rowCount: 1,
  }));
  await expect(readManualSourcePersonalExportV1In({ athleteId: id(20), query })).rejects.toThrow(
    'UNSUPPORTED',
  );
  expect(query).toHaveBeenCalledTimes(1);
});
it('refuses a NULL over-budget response without calling the second family', async () => {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith('SELECT to_regprocedure')
      ? [{ installed: true, executable: true }]
      : [{ bytes: '1001', source: null }],
    rowCount: 1,
  }));
  await expect(
    readManualSourcePersonalExportV1In({ athleteId: id(20), query }, 1000),
  ).rejects.toThrow('TOO_LARGE');
  expect(query).toHaveBeenCalledTimes(2);
});
it('redacts nonmanual source identifiers while preserving each saved ordinal and source revision', () => {
  const m = manual();
  const row = first(m.refs),
    edge = first(m.parents).edge;
  const value = {
    ...m,
    refs: [
      {
        ...row,
        sourceKind: 'fit',
        identity: {
          kind: 'manual-activity-source',
          sourceId: id(5),
          sourceRecordId: 'provider-private-id',
          sourceRevision: 7,
        },
      },
    ],
    parents: [
      {
        ...first(m.parents),
        edge: {
          ...edge,
          family: 'activity',
          versionKey: JSON.stringify(['fit', 'provider-private-id', 7]),
        },
      },
    ],
  };
  const output = mapManualSourcePersonalExportV1(value, nutrition);
  expect(JSON.stringify(output)).not.toContain('provider-private-id');
  expect(output.manualSavedSourceRefs[0]?.ordinal).toBe(1);
  expect(output.manualSavedSourceParents[0]?.identity).toMatchObject({
    family: 'activity',
    sourceId: id(5),
    version: { kind: 'source_revision', source: { kind: 'fit', sourceRevision: 7 } },
  });
});
it('rejects invalid shared byte bounds before any query', async () => {
  const query = vi.fn();
  for (const limit of [0, -1, NaN, 1.5, 8388609]) {
    await expect(
      readManualSourcePersonalExportV1In({ athleteId: id(20), query }, limit),
    ).rejects.toThrow('CORRUPT');
  }
  expect(query).not.toHaveBeenCalled();
});
it('preserves measured callback budget exhaustion as TOO_LARGE and stops the second family', async () => {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith('SELECT to_regprocedure')
      ? [{ installed: true, executable: true }]
      : [{ bytes: String(Buffer.byteLength(JSON.stringify(manual()), 'utf8')), source: manual() }],
    rowCount: 1,
  }));
  const { RetainedPersonalExportError } = await import('../src/retained-personal-export.js');
  await expect(
    readManualSourcePersonalExportV1In({ athleteId: id(20), query }, 10000, () => {
      throw new RetainedPersonalExportError('TOO_LARGE');
    }),
  ).rejects.toThrow('TOO_LARGE');
  expect(query).toHaveBeenCalledTimes(2);
});
it.each(['1', '0'])(
  'rejects under-reported/zero response bytes %s before debit or next RPC',
  async (bytes) => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.startsWith('SELECT to_regprocedure')
        ? [{ installed: true, executable: true }]
        : [{ bytes, source: manual() }],
      rowCount: 1,
    }));
    const debit = vi.fn();
    await expect(
      readManualSourcePersonalExportV1In({ athleteId: id(20), query }, 8388608, debit),
    ).rejects.toThrow('CORRUPT');
    expect(query).toHaveBeenCalledTimes(2);
    expect(debit).not.toHaveBeenCalled();
  },
);
it('rejects null, accessor and overly deep source responses without executing getters or charging', async () => {
  let getters = 0;
  const getter = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      getters++;
      throw Error('GETTER');
    },
  });
  let deep: unknown = 'leaf';
  for (let depth = 0; depth < 66; depth++) deep = { child: deep };
  for (const source of [null, getter, deep]) {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.startsWith('SELECT to_regprocedure')
        ? [{ installed: true, executable: true }]
        : [{ bytes: '8388608', source }],
      rowCount: 1,
    }));
    const debit = vi.fn();
    await expect(
      readManualSourcePersonalExportV1In({ athleteId: id(20), query }, 8388608, debit),
    ).rejects.toThrow('CORRUPT');
    expect(query).toHaveBeenCalledTimes(2);
    expect(debit).not.toHaveBeenCalled();
  }
  expect(getters).toBe(0);
});
it('checks compact bytes of the second family against the actual inherited remainder', async () => {
  const firstBytes = Buffer.byteLength(JSON.stringify(manual()), 'utf8');
  let body = 0;
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT to_regprocedure'))
      return { rows: [{ installed: true, executable: true }], rowCount: 1 };
    body++;
    return {
      rows: [
        { bytes: body === 1 ? String(firstBytes) : '1', source: body === 1 ? manual() : nutrition },
      ],
      rowCount: 1,
    };
  });
  const debits: number[] = [];
  await expect(
    readManualSourcePersonalExportV1In({ athleteId: id(20), query }, firstBytes + 1, (n) =>
      debits.push(n),
    ),
  ).rejects.toThrow('CORRUPT');
  expect(debits).toEqual([firstBytes]);
  expect(query).toHaveBeenCalledTimes(4);
});

function trainingSnapshot(sourceId = 'opaque-training-原文', version = 2) {
  return planSnapshotSchema.parse({
    id: sourceId,
    version,
    createdAt: '2026-10-08T00:00:00.000Z',
    draft: {
      title: 'Frozen current',
      timezone: 'UTC',
      sessions: [],
      periods: ['season', 'wave', 'phase', 'block'].map((level, index, ids) => ({
        id: level,
        parentId: index ? ids[index - 1] : null,
        level,
        title: level,
        startDate: '2026-10-01',
        endDateExclusive: '2026-11-01',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
    },
  });
}
it('identifies only exact frozen current training before, not historical sourcePlan copies', () => {
  const snapshot = trainingSnapshot(),
    current = { aggregateId: id(30), snapshot };
  expect(
    isRenderedTrainingBeforeSource(
      current,
      structuredClone(snapshot),
      { sourceId: snapshot.id, version: snapshot.version },
      current.aggregateId,
    ),
  ).toBe(true);
  for (const ref of [
    { sourceId: 'opaque-training-historical', version: 1 },
    { sourceId: snapshot.id, version: 1 },
  ])
    expect(isRenderedTrainingBeforeSource(current, snapshot, ref, current.aggregateId)).toBe(false);
  expect(
    isRenderedTrainingBeforeSource(
      current,
      snapshot,
      { sourceId: snapshot.id, version: snapshot.version },
      null,
    ),
  ).toBe(false);
  expect(
    isRenderedTrainingBeforeSource(
      null,
      null,
      { sourceId: snapshot.id, version: snapshot.version },
      current.aggregateId,
    ),
  ).toBe(false);
});
it('rejects wrong aggregate and mismatched captured/projection training bodies', () => {
  const snapshot = trainingSnapshot(),
    current = { aggregateId: id(30), snapshot };
  const ref = { sourceId: snapshot.id, version: snapshot.version };
  expect(() => isRenderedTrainingBeforeSource(current, snapshot, ref, id(31))).toThrow('CORRUPT');
  const wrong = structuredClone(snapshot);
  wrong.draft.title = 'Different frozen body';
  expect(() => isRenderedTrainingBeforeSource(current, wrong, ref, current.aggregateId)).toThrow(
    'CORRUPT',
  );
  expect(() => isRenderedTrainingBeforeSource(null, snapshot, ref, current.aggregateId)).toThrow(
    'CORRUPT',
  );
});

import { describe, expect, it } from 'vitest';
import type { Transaction } from '../src/database.js';
import { readManualPooledPersonalExportBatchV1In } from '../src/manual-pooled-personal-export-batch-reader-v1.js';
import { createRaceManualPooledTransportFixtureV1 } from './race-manual-pooled-test-fixtures-v1.js';
import { encodeRaceManualReviewPooledRetainedPayloadV1 } from '../src/race-manual-review-pooled-retained-payload-v1.js';
import { toRaceManualReviewPooledDatabaseEnvelopeV1 } from '../src/race-manual-review-pooled-database-envelope-v1.js';
import { mapManualSourcePersonalExportV1 } from '../src/manual-source-personal-export.js';
import { renderRaceManualInternalPersonalExport } from '../src/race-manual-internal-personal-export-renderer.js';
function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error('FIXTURE_REQUIRED');
  return value;
}
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
const nutrition = { schemaVersion: 1, origins: [], lineage: [] };
function fixture(mode: 'legacy' | 'pooled' = 'pooled') {
  const f = createRaceManualPooledTransportFixtureV1(),
    logical = f.logical;
  if (logical.state !== 'present') throw Error('FIXTURE_PRESENT');
  const ids = { evidenceId: id(30), decisionId: id(31), proposalId: id(32) },
    createdAt = '2026-10-08T00:00:00.123456Z';
  const result = {
    schemaVersion: 2,
    ...ids,
    candidateDigest: logical.minimalAudit.candidateDigest,
    createdAt,
    applicable: false,
    approvalAllowed: false,
  };
  const payload =
    mode === 'pooled'
      ? toRaceManualReviewPooledDatabaseEnvelopeV1(
          encodeRaceManualReviewPooledRetainedPayloadV1(logical),
        )
      : logical;
  const old = {
    schemaVersion: 1,
    chains: [
      {
        ...ids,
        createdAt,
        originalResult: result,
        bodyState: 'present',
        preparation: logical.payload.preparation,
        purge: null,
      },
    ],
    candidates: [],
    approvalResults: [],
    approvalHistory: [],
  };
  const parents = logical.payload.inventory.refs.map((r, index) => {
    const i = r.identity;
    if (
      i.kind !== 'race-event' &&
      i.kind !== 'food-definition-version' &&
      i.kind !== 'nutrition-plan-version'
    )
      throw Error('UNSUPPORTED_PURE_FIXTURE_KIND');
    return {
      evidenceId: ids.evidenceId,
      ordinal: index + 1,
      edge: {
        family:
          i.kind === 'race-event'
            ? 'race-event'
            : i.kind === 'food-definition-version'
              ? 'food-definition'
              : 'nutrition-plan',
        sourceId: i.sourceId,
        versionKey: i.kind === 'race-event' ? String(i.revision) : i.versionId,
        role: 'source',
        membershipKey: null,
      },
    };
  });
  const metadata = {
    schemaVersion: 1,
    chains: [
      {
        ...ids,
        savedRefCount: logical.payload.inventory.refs.length,
        savedParentCount: parents.length,
        savedSuppressionCount: 0,
        body: { state: 'present' },
        preparation: logical.payload.preparation,
      },
    ],
    refs: logical.payload.inventory.refs.map((r, i) => ({
      evidenceId: ids.evidenceId,
      ordinal: i + 1,
      identity: r.identity,
      dtoDigest: r.dtoDigest,
      copiedLocations: r.copiedLocations,
      trainingAggregateId: null,
      sourceKind: null,
      parentCoverage: 'saved_parents',
      existence: { basis: 'export_snapshot', state: 'present' },
      location: { state: 'unavailable', reason: 'private_source_not_rendered' },
    })),
    parents,
    suppressions: [],
  };
  const { preparation: discarded, ...row } = required(metadata.chains[0]);
  void discarded;
  const source = {
    batchVersion: 2,
    internal: {
      ...old,
      schemaVersion: 2,
      chains: [
        {
          ...ids,
          createdAt,
          originalResult: result,
          bodyState: 'present',
          payloadEncoding: mode === 'pooled' ? 'pooled-database-envelope-v1' : 'legacy-retained-v2',
          payload,
          purge: null,
        },
      ],
    },
    sourceMetadata: {
      ...metadata,
      schemaVersion: 2,
      chains: [
        {
          ...row,
          payloadBinding: {
            state: 'present',
            digestMethod: 'postgres-retained-envelope-jsonb-v1',
            digest: 'b'.repeat(64),
          },
        },
      ],
    },
    publicMetadata: {
      schemaVersion: 2,
      status: 'ready',
      sources: [],
      approvalHistory: [],
      commandResults: [],
      trainingAggregateMappings: [],
    },
  };
  return {
    observed: {
      source,
      athleteId: logical.payload.preparation.context.athleteId,
      payloadBindings: [{ evidenceId: ids.evidenceId, digest: 'b'.repeat(64) }],
    },
    old,
    metadata,
  };
}
function mock(
  observed: unknown,
  options: {
    installed?: boolean;
    reported?: number;
    accessor?: boolean;
    nutritionValue?: unknown;
  } = {},
) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tx: Transaction = {
    athleteId: 'synthetic',
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('to_regprocedure'))
        return { rows: [{ installed: options.installed ?? true, executable: true }], rowCount: 1 };
      const source = sql.includes('pooled_personal_export')
        ? observed
        : (options.nutritionValue ?? nutrition);
      const bytes = options.reported ?? Buffer.byteLength(JSON.stringify(source), 'utf8');
      if (options.accessor)
        return {
          rows: [
            Object.defineProperty({ bytes: String(bytes) }, 'source', {
              enumerable: true,
              get() {
                throw Error('GETTER_EXECUTED');
              },
            }),
          ],
          rowCount: 1,
        };
      return { rows: [{ bytes: String(bytes), source }], rowCount: 1 };
    },
  };
  return { tx, calls };
}
describe('one-copy pooled personal export batch reader (pure wire fixtures, no DB authority)', () => {
  for (const mode of ['legacy', 'pooled'] as const)
    it(`${mode} exact output equals historical projection and source census`, async () => {
      const f = fixture(mode),
        m = mock(f.observed),
        charges: number[] = [];
      const actual = await readManualPooledPersonalExportBatchV1In(m.tx, 8388608, (n) =>
        charges.push(n),
      );
      expect(actual.internal).toEqual(renderRaceManualInternalPersonalExport(f.old));
      expect(actual.sources).toEqual(mapManualSourcePersonalExportV1(f.metadata, nutrition));
      expect(actual.manual.manualRaceReviews).toEqual([]);
      expect(charges).toEqual([
        Buffer.byteLength(JSON.stringify(f.observed), 'utf8'),
        Buffer.byteLength(JSON.stringify(nutrition), 'utf8'),
      ]);
      const second = m.calls.find((c) => c.sql.includes('read_nutrition_disconnection'));
      expect(second?.values).toEqual([8388608 - (charges[0] ?? 0)]);
      expect(
        m.calls.some(
          (c) =>
            c.sql.includes('read_race_manual_personal_export_v1(') ||
            c.sql.includes('read_manual_race_internal_personal_export_v1(') ||
            c.sql.includes('read_manual_race_retained_source_batch_v1('),
        ),
      ).toBe(false);
    });
  it('different genuine SQL family ordering joins exact evidence census without reordering either array', async () => {
    const v = fixture().observed;
    const second = structuredClone(required(v.source.internal.chains[0]));
    second.evidenceId = id(40);
    second.decisionId = id(41);
    second.proposalId = id(42);
    Object.assign(second.originalResult, {
      evidenceId: id(40),
      decisionId: id(41),
      proposalId: id(42),
    });
    v.source.internal.chains.push(second);
    v.payloadBindings.push({ evidenceId: id(40), digest: 'b'.repeat(64) });
    const metadata = structuredClone(required(v.source.sourceMetadata.chains[0]));
    Object.assign(metadata, { evidenceId: id(40), decisionId: id(41), proposalId: id(42) });
    v.source.sourceMetadata.chains.unshift(metadata);
    v.source.sourceMetadata.refs.push(
      ...structuredClone(v.source.sourceMetadata.refs).map((r) => ({ ...r, evidenceId: id(40) })),
    );
    v.source.sourceMetadata.parents.push(
      ...structuredClone(v.source.sourceMetadata.parents).map((r) => ({
        ...r,
        evidenceId: id(40),
      })),
    );
    const result = await readManualPooledPersonalExportBatchV1In(mock(v).tx);
    expect(result.internal.manualInternalChains.map((c) => c.evidenceId)).toEqual([id(30), id(40)]);
    expect(result.sources.manualSourceChains.map((c) => c.evidenceId)).toEqual([id(40), id(30)]);
    expect(
      result.sources.manualSavedSourceRefs
        .filter((r) => r.evidenceId === id(40))
        .map((r) => r.ordinal),
    ).toEqual(
      v.source.sourceMetadata.refs.filter((r) => r.evidenceId === id(40)).map((r) => r.ordinal),
    );
    const duplicate = structuredClone(v);
    duplicate.source.sourceMetadata.chains[1] = structuredClone(metadata);
    await expect(readManualPooledPersonalExportBatchV1In(mock(duplicate).tx)).rejects.toMatchObject(
      { code: 'CORRUPT' },
    );
    const wrongWrapper = structuredClone(v);
    wrongWrapper.payloadBindings.reverse();
    await expect(
      readManualPooledPersonalExportBatchV1In(mock(wrongWrapper).tx),
    ).rejects.toMatchObject({ code: 'CORRUPT' });
  });
  it('true empty census is distinct from absent capability', async () => {
    const observed = {
      source: {
        batchVersion: 2,
        internal: {
          schemaVersion: 2,
          chains: [],
          candidates: [],
          approvalResults: [],
          approvalHistory: [],
        },
        sourceMetadata: { schemaVersion: 2, chains: [], refs: [], parents: [], suppressions: [] },
        publicMetadata: {
          schemaVersion: 2,
          status: 'ready',
          sources: [],
          approvalHistory: [],
          commandResults: [],
          trainingAggregateMappings: [],
        },
      },
      athleteId: 'empty',
      payloadBindings: [],
    };
    expect(
      (await readManualPooledPersonalExportBatchV1In(mock(observed).tx)).internal
        .manualInternalChains,
    ).toEqual([]);
    const unavailable = mock(observed, { installed: false });
    await expect(readManualPooledPersonalExportBatchV1In(unavailable.tx)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    expect(unavailable.calls).toHaveLength(1);
  });
  for (const mutate of [
    'binding',
    'namespace',
    'tenant',
    'encoding',
    'ordinal',
    'publicSubset',
  ] as const)
    it(`rejects ${mutate} before nutrition family`, async () => {
      const v = fixture().observed;
      if (mutate === 'binding') required(v.payloadBindings[0]).digest = 'c'.repeat(64);
      if (mutate === 'namespace')
        Object.assign(required(v.source.sourceMetadata.chains[0]).payloadBinding, {
          digestMethod: 'dto-object-key-canonical-sha256-v1',
        });
      if (mutate === 'tenant') v.athleteId = 'foreign';
      if (mutate === 'encoding') required(v.source.internal.chains[0]).payloadEncoding = 'unknown';
      if (mutate === 'ordinal') required(v.source.sourceMetadata.refs[0]).ordinal = 5000;
      if (mutate === 'publicSubset')
        Object.assign(v.source.publicMetadata, {
          sources: [
            { candidateId: id(88), evidenceId: id(30), reference: {}, bodyState: 'present' },
          ],
        });
      const m = mock(v);
      await expect(readManualPooledPersonalExportBatchV1In(m.tx)).rejects.toMatchObject({
        code: 'CORRUPT',
      });
      // Some source-only correspondence checks occur after the bounded nutrition read;
      // both fail atomically and never return a partial export.
      if (mutate !== 'ordinal')
        expect(m.calls.some((c) => c.sql.includes('read_nutrition_disconnection'))).toBe(false);
    });
  for (const reported of [0, 1])
    it(`rejects reported bytes ${reported} without debit or next body`, async () => {
      const m = mock(fixture().observed, { reported });
      let charged = 0;
      await expect(
        readManualPooledPersonalExportBatchV1In(m.tx, 8388608, (n) => {
          charged += n;
        }),
      ).rejects.toMatchObject({ code: 'CORRUPT' });
      expect(charged).toBe(0);
      expect(m.calls).toHaveLength(2);
    });
  it('rejects getter/deep/oversized payloads and invalid limits', async () => {
    const f = fixture().observed;
    await expect(
      readManualPooledPersonalExportBatchV1In(mock(f, { accessor: true }).tx),
    ).rejects.toMatchObject({ code: 'CORRUPT' });
    const huge = mock({ x: 'x'.repeat(8388609) });
    await expect(readManualPooledPersonalExportBatchV1In(huge.tx)).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
    for (const limit of [0, -1, NaN, 8388609]) {
      const m = mock(f);
      await expect(readManualPooledPersonalExportBatchV1In(m.tx, limit)).rejects.toMatchObject({
        code: 'CORRUPT',
      });
      expect(m.calls).toEqual([]);
    }
  });
  it('purged unknown encoding preserves minimal original fact and never decodes a body', async () => {
    const v = fixture().observed;
    const eventId = id(90),
      purgedAt = '2026-10-08T01:00:00.123456Z';
    Object.assign(required(v.source.internal.chains[0]), {
      bodyState: 'purged',
      payload: null,
      payloadEncoding: null,
      purge: { purgeEventId: eventId, purgedAt },
    });
    Object.assign(required(v.source.sourceMetadata.chains[0]), {
      body: { state: 'purged', eventId, occurredAt: purgedAt },
      payloadBinding: {
        state: 'purged',
        digestMethod: 'postgres-retained-envelope-jsonb-v1',
        digest: null,
      },
    });
    Object.assign(required(v.payloadBindings[0]), { digest: null });
    required(v.source.sourceMetadata.chains[0]).savedSuppressionCount = 1;
    Object.assign(v.source.sourceMetadata, {
      suppressions: [
        {
          evidenceId: id(30),
          eventId,
          occurredAt: purgedAt,
          recordVersion: 1,
          kind: 'race_event_deleted',
          matchedRefOrdinals: [1],
        },
      ],
    });
    for (const r of v.source.sourceMetadata.refs)
      Object.assign(r, { location: { state: 'unavailable', reason: 'payload_purged' } });
    const out = await readManualPooledPersonalExportBatchV1In(mock(v).tx);
    expect(out.internal.manualInternalChains[0]?.body).toEqual({
      state: 'purged',
      purgedAt,
      purgeEventId: eventId,
    });
    expect(
      out.sources.manualSavedSourceRefs.every(
        (r) => r.location.state === 'unavailable' && r.location.reason === 'payload_purged',
      ),
    ).toBe(true);
    expect(JSON.stringify(out)).not.toContain('sourcePool');
  });
  it('exact remaining budget rejects second family before transfer and output has no mutable input alias', async () => {
    const f = fixture(),
      bytes = Buffer.byteLength(JSON.stringify(f.observed), 'utf8');
    const m = mock(f.observed);
    await expect(readManualPooledPersonalExportBatchV1In(m.tx, bytes)).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
    expect(m.calls.filter((c) => c.sql.includes('AS source'))).toHaveLength(1);
    const out = await readManualPooledPersonalExportBatchV1In(mock(f.observed).tx);
    const saved = JSON.stringify(out);
    required(f.observed.source.internal.chains[0]).originalResult.createdAt =
      '2026-10-09T00:00:00.123456Z';
    expect(JSON.stringify(out)).toBe(saved);
  });
  it('hostile driver error/getter is sanitized without execution', async () => {
    let getters = 0;
    const malicious = Object.defineProperty({}, 'code', {
      get() {
        getters++;
        throw Error('SECRET_SQL_DETAIL');
      },
    });
    const tx: Transaction = {
      athleteId: 'synthetic',
      async query() {
        throw malicious;
      },
    };
    await expect(readManualPooledPersonalExportBatchV1In(tx)).rejects.toMatchObject({
      code: 'CORRUPT',
    });
    expect(getters).toBe(0);
  });
  it('shared callback exhaustion is TOO_LARGE and prevents nutrition response', async () => {
    const m = mock(fixture().observed);
    const { RetainedPersonalExportError } = await import('../src/retained-personal-export.js');
    await expect(
      readManualPooledPersonalExportBatchV1In(m.tx, 8388608, () => {
        throw new RetainedPersonalExportError('TOO_LARGE');
      }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(m.calls).toHaveLength(2);
  });
});

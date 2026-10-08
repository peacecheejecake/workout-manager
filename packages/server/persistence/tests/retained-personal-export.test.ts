import { expect, it } from 'vitest';
import { checkInDefinition } from '@workout/contracts/check-ins';
import type { Transaction } from '../src/database.js';
import {
  mapCheckInTemplatePersonalExportV1,
  mapRaceManualPersonalExportV1,
  readCheckInTemplatePersonalExportV1In,
  readRaceManualPersonalExportV1In,
  RetainedPersonalExportError,
} from '../src/retained-personal-export.js';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const at = '2026-10-08T00:00:00.123456Z';
function template() {
  const body = {
    templateId: id(1),
    versionId: id(2),
    version: 1,
    previousVersionId: null,
    previousVersion: null,
    createdAt: at,
    content: {
      definitionVersion: checkInDefinition.version,
      source: checkInDefinition.source,
      method: checkInDefinition.method,
      title: '직접 보고',
      instructions: null,
      fields: ['note', 'fatigue', 'bodyLocation', 'discomfort'],
    },
  };
  return {
    schemaVersion: 1,
    status: 'ready',
    data: {
      checkInTemplateVersions: [
        {
          template_id: id(1),
          version_id: id(2),
          version: 1,
          previous_version_id: null,
          previous_version: null,
          created_at: at,
          record_json: body,
        },
      ],
      checkInTemplateHeads: [{ template_id: id(1), version_id: id(2), version: 1 }],
    },
  };
}
function manual() {
  const reference = {
    schemaVersion: 1,
    candidateId: id(1),
    applicationDigest: 'a'.repeat(64),
    chain: {
      evidenceId: id(2),
      decisionId: id(3),
      proposalId: id(4),
      readonlyCandidateDigest: 'b'.repeat(64),
    },
    createdAt: at,
  };
  return {
    schemaVersion: 1,
    status: 'ready',
    sources: [{ reference, bodyState: 'purged', candidate: null, preparation: null }],
    approvalHistory: [],
    commandResults: [
      {
        operation: 'review',
        candidateId: id(1),
        result: { status: 'reviewed', reference, bodyState: 'present' },
      },
    ],
  };
}
function transaction(
  options: {
    source?: unknown;
    bytes?: string;
    installed?: boolean;
    executable?: boolean;
    error?: unknown;
  } = {},
) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tx: Transaction = {
    athleteId: 'server-derived-tenant',
    async query(sql, values) {
      calls.push({ sql, values });
      if (options.error !== undefined) throw options.error;
      if (sql.includes('to_regprocedure'))
        return {
          rows: [{ installed: options.installed ?? true, executable: options.executable ?? true }],
          rowCount: 1,
        };
      const source = options.source === undefined ? template() : options.source;
      return {
        rows: [
          { bytes: options.bytes ?? String(Buffer.byteLength(JSON.stringify(source))), source },
        ],
        rowCount: 1,
      };
    },
  };
  return { tx, calls };
}
function corrupt(operation: () => unknown) {
  expect(operation).toThrowError(new RetainedPersonalExportError('CORRUPT'));
}
it('preserves original template content, exact physical tuple and microseconds', () => {
  const input = template();
  expect(mapCheckInTemplatePersonalExportV1(input)).toEqual(input.data);
  const first = input.data.checkInTemplateVersions[0];
  if (!first) throw Error('Expected original version');
  first.version_id = id(3);
  corrupt(() => mapCheckInTemplatePersonalExportV1(input));
});
it('projects purged source to contentless fact while preserving original successful receipt', () => {
  const input = manual();
  const first = input.sources[0];
  if (!first) throw Error('Expected original source');
  const result = mapRaceManualPersonalExportV1(input);
  expect(result.manualRaceReviews).toEqual([
    { reference: first.reference, createdAt: at, bodyState: 'purged', preview: null },
  ]);
  expect(result.manualRaceCommandResults).toEqual(input.commandResults);
});
it('requires explicit ready collections and rejects private and unsupported fields', () => {
  for (const raw of [
    null,
    {},
    { ...template(), status: 'unsupported' },
    { ...template(), secret: 'private' },
    { ...manual(), sources: undefined },
    { ...manual(), basis: {} },
  ])
    corrupt(() => mapCheckInTemplatePersonalExportV1(raw));
  corrupt(() => mapRaceManualPersonalExportV1({ ...manual(), basis: {} }));
});
it('rejects resurrection and incomplete present bodies using existing source codec', () => {
  const input = manual();
  corrupt(() =>
    mapRaceManualPersonalExportV1({ ...input, sources: [{ ...input.sources[0], candidate: {} }] }),
  );
  corrupt(() =>
    mapRaceManualPersonalExportV1({
      ...input,
      sources: [{ ...input.sources[0], bodyState: 'present' }],
    }),
  );
});
it('rejects duplicate candidate sources instead of silently deduplicating', () => {
  const input = manual();
  corrupt(() =>
    mapRaceManualPersonalExportV1({ ...input, sources: [...input.sources, ...input.sources] }),
  );
});
it('does not execute getters and sanitizes reflective exceptions', () => {
  let visits = 0;
  const getter = Object.defineProperty({}, 'status', {
    enumerable: true,
    get() {
      visits++;
      return 'ready';
    },
  });
  corrupt(() => mapCheckInTemplatePersonalExportV1(getter));
  expect(visits).toBe(0);
  corrupt(() =>
    mapCheckInTemplatePersonalExportV1(
      new Proxy(
        {},
        {
          ownKeys() {
            throw Error('private');
          },
        },
      ),
    ),
  );
});
it('rejects nonplain arrays, cycles, sparse arrays and nonfinite values', () => {
  class OtherArray extends Array<unknown> {}
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const raw of [new OtherArray(), cycle, Array(2), { value: NaN }])
    corrupt(() => mapRaceManualPersonalExportV1(raw));
});
it('rejects oversized ingress before schema/body projection', () => {
  expect(() =>
    mapRaceManualPersonalExportV1({ text: 'x'.repeat(8 * 1024 * 1024 + 1) }),
  ).toThrowError(new RetainedPersonalExportError('TOO_LARGE'));
});
it('uses one fixed bounded RPC call without athlete arguments or writes', async () => {
  const { tx, calls } = transaction();
  expect(await readCheckInTemplatePersonalExportV1In(tx)).toEqual(template().data);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.values).toEqual(['public.read_check_in_template_personal_export_v1(integer)']);
  expect(calls[1]?.values).toEqual([8 * 1024 * 1024]);
  expect(calls[1]?.sql.match(/read_check_in_template_personal_export_v1/g)).toHaveLength(1);
  expect(calls[1]?.sql).toContain('MATERIALIZED');
  expect(calls.every((call) => !/INSERT|UPDATE|DELETE/.test(call.sql))).toBe(true);
});
it('uses manual RPC and shared public projection', async () => {
  const { tx, calls } = transaction({ source: manual() });
  expect(await readRaceManualPersonalExportV1In(tx)).toEqual(
    mapRaceManualPersonalExportV1(manual()),
  );
  expect(calls[0]?.values).toEqual(['public.read_race_manual_personal_export_v1(integer)']);
});
it('absent or denied capability is unavailable without calling source RPC', async () => {
  for (const options of [{ installed: false }, { executable: false }]) {
    const { tx, calls } = transaction(options);
    await expect(readCheckInTemplatePersonalExportV1In(tx)).rejects.toThrowError(
      new RetainedPersonalExportError('UNSUPPORTED'),
    );
    expect(calls).toHaveLength(1);
  }
});
it('invalid remaining budgets reject before SQL', async () => {
  for (const limit of [0, -1, 1.5, NaN, Infinity, 8388609]) {
    const { tx, calls } = transaction();
    await expect(readCheckInTemplatePersonalExportV1In(tx, limit)).rejects.toThrowError(
      new RetainedPersonalExportError('CORRUPT'),
    );
    expect(calls).toHaveLength(0);
  }
});
it('over-budget NULL gate rejects before parsing body and preserves the supplied remainder', async () => {
  const { tx, calls } = transaction({ bytes: '65', source: null });
  await expect(readCheckInTemplatePersonalExportV1In(tx, 64)).rejects.toThrowError(
    new RetainedPersonalExportError('TOO_LARGE'),
  );
  expect(calls[1]?.values).toEqual([64]);
});
it('rejects null/malformed measurement and underreported oversized local source', async () => {
  for (const options of [
    { bytes: '1', source: null },
    { bytes: '-1' },
    { bytes: '1', source: { text: 'x'.repeat(100) } },
  ]) {
    const { tx } = transaction(options);
    await expect(readCheckInTemplatePersonalExportV1In(tx, 64)).rejects.toBeInstanceOf(
      RetainedPersonalExportError,
    );
  }
});
it('sanitizes SQL failures and propagates failure for rollback', async () => {
  for (const [error, code] of [
    [{ code: '42501', message: 'private SQL' }, 'UNSUPPORTED'],
    [{ code: '42883' }, 'UNSUPPORTED'],
    [{ message: 'PERSONAL_EXPORT_TOO_LARGE' }, 'TOO_LARGE'],
    [Error('token private source'), 'CORRUPT'],
    [
      new Proxy(
        {},
        {
          get() {
            throw Error('secret');
          },
        },
      ),
      'CORRUPT',
    ],
  ]) {
    const { tx, calls } = transaction({ error });
    await expect(readCheckInTemplatePersonalExportV1In(tx)).rejects.toMatchObject({
      code,
      message: code,
    });
    expect(calls).toHaveLength(1);
  }
});

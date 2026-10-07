import { expect, it } from 'vitest';
import { checkInTemplateVersionSchema } from '@workout/contracts/check-in-templates';
import type { Transaction } from '../src/database.js';
import { captureCheckInTemplateSourceIn } from '../src/check-in-template-source.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const versionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const nextId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const record = checkInTemplateVersionSchema.parse({
  templateId: id,
  versionId,
  version: 1,
  previousVersionId: null,
  previousVersion: null,
  createdAt: '2026-10-08T09:00:00.123456+09:00',
  content: {
    definitionVersion: 'checkin-v1',
    source: 'user',
    method: 'self_report',
    title: '직접 보고',
    instructions: null,
    fields: ['note', 'fatigue'],
  },
});
const newer = checkInTemplateVersionSchema.parse({
  ...record,
  versionId: nextId,
  version: 2,
  previousVersionId: versionId,
  previousVersion: 1,
});
function response(version: unknown = record, head: unknown = record) {
  const version_text = version === null ? null : JSON.stringify(version);
  const head_text = head === null ? null : JSON.stringify(head);
  return {
    response_bytes: String(
      Buffer.byteLength(version_text ?? '') + Buffer.byteLength(head_text ?? ''),
    ),
    body_valid: true,
    within_budget: true,
    version_text,
    head_text,
  };
}
function database(row: Record<string, unknown> = response(), available = true) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tx: Transaction = {
    athleteId: 'tenant',
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [calls.length === 1 ? { available } : row], rowCount: 1 };
    },
  };
  return { tx, calls };
}
const request = { id, versionId };
const budget = () => ({ bytes: 0n, sources: 0 });
it('returns exact immutable self-report definition with null/order/µs preserved and no authority', async () => {
  const db = database();
  const b = budget();
  const result = await captureCheckInTemplateSourceIn(db.tx, request, b);
  expect(result).toMatchObject({
    state: 'current',
    record,
    authority: 'none',
    freshness: 'not_checked',
  });
  expect(b).toEqual({ bytes: 1024n + BigInt(response().response_bytes), sources: 1 });
  expect(db.calls).toHaveLength(2);
  expect(db.calls[1]?.sql).toContain('observed AS MATERIALIZED');
  expect(db.calls.every((call) => !/INSERT|UPDATE|DELETE/.test(call.sql))).toBe(true);
});
it('uses historical body rather than replacing it with the newer head', async () => {
  const result = await captureCheckInTemplateSourceIn(
    database(response(record, newer)).tx,
    request,
    budget(),
  );
  expect(result).toMatchObject({
    state: 'historical',
    record,
    currentHead: { versionId: nextId, version: 2 },
  });
});
it('normalizes UUID case before the narrow tenant-derived readers', async () => {
  const db = database();
  const result = await captureCheckInTemplateSourceIn(
    db.tx,
    { id: id.toUpperCase(), versionId: versionId.toUpperCase() },
    budget(),
  );
  expect(result.requested).toEqual(request);
  expect(db.calls[1]?.values?.slice(0, 2)).toEqual([id, versionId]);
});
it.each([null, newer])(
  'honestly preserves missing/foreign exact body with observed head %j',
  async (head) => {
    const result = await captureCheckInTemplateSourceIn(
      database(response(null, head)).tx,
      request,
      budget(),
    );
    expect(result).toMatchObject({
      state: 'unavailable',
      reason: 'owned_version_unavailable',
      record: null,
    });
  },
);
it('returns unavailable only for explicit missing/denied reader capability', async () => {
  const db = database(response(), false);
  expect(await captureCheckInTemplateSourceIn(db.tx, request, budget())).toMatchObject({
    reason: 'reader_unavailable',
  });
  expect(db.calls).toHaveLength(1);
  expect(db.calls[0]?.sql).toContain('has_function_privilege');
});
it.each([
  response(record, null),
  response(newer, record),
  response(record, { ...record, templateId: nextId }),
  response(record, { ...record, versionId: nextId }),
  response(record, { ...record, content: { ...record.content, title: 'changed immutable body' } }),
  response({ ...record, templateId: nextId }),
  response({ ...record, extra: true }),
  response({ ...record, content: { ...record.content, fields: ['note', 'note'] } }),
])('rejects malformed/mismatched/headless immutable correspondence', async (row) => {
  await expect(
    captureCheckInTemplateSourceIn(database(row).tx, request, budget()),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});
it('rejects malformed JSON or a mismatched response byte declaration', async () => {
  const malformed = { ...response(), version_text: '{' };
  malformed.response_bytes = String(1 + Buffer.byteLength(malformed.head_text ?? ''));
  for (const row of [malformed, { ...response(), response_bytes: '0' }])
    await expect(
      captureCheckInTemplateSourceIn(database(row).tx, request, budget()),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});
it('keeps permission/fence SQL failures thrown so the enclosing transaction rolls back', async () => {
  const error = new Error('permission denied');
  const tx: Transaction = {
    athleteId: 'tenant',
    async query() {
      throw error;
    },
  };
  await expect(captureCheckInTemplateSourceIn(tx, request, budget())).rejects.toBe(error);
});
it('rejects invalid input/accessors without executing a getter or querying', async () => {
  let reads = 0;
  const accessor = {
    get id() {
      reads++;
      return id;
    },
    versionId,
  };
  const db = database();
  for (const ref of [accessor, { ...request, extra: true }, { id: 'opaque', versionId }])
    await expect(captureCheckInTemplateSourceIn(db.tx, ref, budget())).rejects.toMatchObject({
      code: 'INVALID_CONTEXT',
    });
  expect(reads).toBe(0);
  expect(db.calls).toHaveLength(0);
});
it.each([
  { bytes: -1n, sources: 0 },
  { bytes: 0n, sources: NaN },
  { bytes: 0n, sources: -1 },
])('rejects invalid shared counters before any query', async (b) => {
  const db = database();
  await expect(captureCheckInTemplateSourceIn(db.tx, request, b)).rejects.toMatchObject({
    code: 'INVALID_CONTEXT',
  });
  expect(db.calls).toHaveLength(0);
});
it('reserves visited-source and capability overhead before transport', async () => {
  for (const b of [
    { bytes: 4194304n, sources: 0 },
    { bytes: 0n, sources: 5000 },
  ]) {
    const db = database();
    await expect(captureCheckInTemplateSourceIn(db.tx, request, b)).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    });
    expect(db.calls).toHaveLength(0);
  }
});
it('rejects a naturally gated response without accepting null as absence', async () => {
  const row = {
    ...response(),
    response_bytes: '1024',
    within_budget: false,
    version_text: null,
    head_text: null,
  };
  const db = database(row);
  const b = { bytes: 4194304n - 1024n - 64n, sources: 0 };
  await expect(captureCheckInTemplateSourceIn(db.tx, request, b)).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
  });
  expect(db.calls[1]?.values?.[2]).toBe('64');
});
it('rejects inconsistent gate flags and per-body contract limit failures', async () => {
  for (const row of [
    { ...response(), within_budget: false },
    { ...response(), body_valid: false },
  ])
    await expect(
      captureCheckInTemplateSourceIn(database(row).tx, request, budget()),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});

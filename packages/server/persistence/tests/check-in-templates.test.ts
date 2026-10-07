import { randomUUID } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import { createCheckInTemplateRepository } from '../src/check-in-templates.js';
import type { Database, Transaction } from '../src/database.js';
const content = {
  definitionVersion: 'checkin-v1' as const,
  source: 'user' as const,
  method: 'self_report' as const,
  title: 'User prompts',
  instructions: null,
  fields: ['fatigue', 'note'] as ('fatigue' | 'note')[],
};
function command() {
  return { idempotencyKey: randomUUID(), templateId: randomUUID(), expectedVersion: 0, content };
}
function record(input: ReturnType<typeof command>) {
  return {
    templateId: input.templateId,
    versionId: randomUUID(),
    version: 1,
    previousVersionId: null,
    previousVersion: null,
    createdAt: '2026-10-08T00:00:00.000Z',
    content: input.content,
  };
}
function result(value: unknown) {
  return {
    rows: [{ bytes: String(Buffer.byteLength(JSON.stringify(value))), value }],
    rowCount: 1,
  };
}
function database(query: Transaction['query']): Database {
  const tenant: Database['tenant'] = (athleteId, operation) => operation({ athleteId, query });
  return { tenant, exclusiveTenant: tenant, close: async () => undefined };
}
it('SQL receipt-first returns the original version despite fresh generated ID/time on retry', async () => {
  const input = command(),
    saved = record(input),
    query = vi.fn<Transaction['query']>().mockResolvedValueOnce(result(saved)),
    now = vi.fn(() => new Date('2026-10-09T00:00:00Z')),
    createId = vi.fn(() => randomUUID());
  expect(
    await createCheckInTemplateRepository(database(query), { now, createId }).save(
      'synthetic',
      input,
    ),
  ).toEqual(saved);
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[0]).toContain('public.save_check_in_template_v1($1::jsonb)');
  const raw = JSON.parse(String(query.mock.calls[0]?.[1]?.[0]));
  expect(raw).toMatchObject(input);
  expect(raw.createdAt).toBe('2026-10-09T00:00:00.000Z');
  expect(raw.versionId).not.toBe(saved.versionId);
});
it('sends exactly public command plus generated version/time to the fixed SQL protocol', async () => {
  const input = command(),
    saved = record(input),
    generated = randomUUID(),
    query = vi.fn<Transaction['query']>().mockResolvedValueOnce(result(saved));
  expect(
    await createCheckInTemplateRepository(database(query), {
      now: () => new Date(saved.createdAt),
      createId: () => generated,
    }).save('synthetic', input),
  ).toEqual(saved);
  expect(JSON.parse(String(query.mock.calls[0]?.[1]?.[0]))).toEqual({
    ...input,
    versionId: generated,
    createdAt: saved.createdAt,
  });
});
it.each(['athleteId', 'observedAt', 'versionId', 'authority'])(
  'rejects unknown %s before DB',
  async (field) => {
    const query = vi.fn<Transaction['query']>();
    await expect(
      createCheckInTemplateRepository(database(query)).save('synthetic', {
        ...command(),
        [field]: 'forged',
      }),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  },
);
it('rejects caller accessors without executing them', async () => {
  const getter = vi.fn(),
    input = command(),
    query = vi.fn<Transaction['query']>();
  Object.defineProperty(input, 'content', { get: getter, enumerable: true });
  await expect(
    createCheckInTemplateRepository(database(query)).save('synthetic', input),
  ).rejects.toThrow('CHECK_IN_TEMPLATE_BOUND');
  expect(getter).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});
it('rejects oversized primitive before SQL', async () => {
  const query = vi.fn<Transaction['query']>();
  await expect(
    createCheckInTemplateRepository(database(query)).save(
      'synthetic',
      'x'.repeat(4 * 1024 * 1024 + 1),
    ),
  ).rejects.toThrow('CHECK_IN_TEMPLATE_BOUND');
  expect(query).not.toHaveBeenCalled();
});
it('maps finite SQL conflicts while preserving unrelated permission errors', async () => {
  const input = command(),
    known = Object.assign(new Error('CHECKIN_TEMPLATE_STALE_VERSION'), { code: 'P0001' }),
    query = vi
      .fn<Transaction['query']>()
      .mockRejectedValueOnce(known)
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: '42501' })),
    repo = createCheckInTemplateRepository(database(query));
  await expect(repo.save('synthetic', input)).rejects.toMatchObject({
    code: 'CHECK_IN_TEMPLATE_VERSION_CONFLICT',
  });
  await expect(repo.save('synthetic', input)).rejects.toMatchObject({ code: '42501' });
});
it('exact read matches both IDs and rejects wrong storage identity', async () => {
  const input = command(),
    saved = record(input),
    query = vi
      .fn<Transaction['query']>()
      .mockResolvedValueOnce(result(saved))
      .mockResolvedValueOnce(result({ ...saved, templateId: randomUUID() })),
    repo = createCheckInTemplateRepository(database(query));
  expect(
    await repo.readExact('synthetic', input.templateId.toUpperCase(), saved.versionId),
  ).toEqual(saved);
  await expect(repo.readExact('synthetic', input.templateId, saved.versionId)).rejects.toThrow(
    'CHECK_IN_TEMPLATE_INVALID_RESPONSE',
  );
});
it('retained empty read and list never perform app admission', async () => {
  const query = vi
      .fn<Transaction['query']>()
      .mockResolvedValueOnce(result(null))
      .mockResolvedValueOnce(result([])),
    repo = createCheckInTemplateRepository(database(query));
  expect(await repo.readHead('synthetic', randomUUID())).toBeNull();
  expect(await repo.list('synthetic', { limit: 10, offset: 0 })).toEqual({ items: [] });
  expect(query.mock.calls.every(([sql]) => !sql.includes('require_app'))).toBe(true);
});
it('list enforces requested row bound and rejects duplicate storage roster', async () => {
  const a = record(command()),
    b = record(command()),
    records = [a, b].sort((x, y) => (x.templateId < y.templateId ? -1 : 1)),
    query = vi
      .fn<Transaction['query']>()
      .mockResolvedValueOnce(result(records.slice(0, 1)))
      .mockResolvedValueOnce(result([a, a])),
    repo = createCheckInTemplateRepository(database(query));
  expect(await repo.list('synthetic', { limit: 1, offset: 0 })).toEqual({
    items: records.slice(0, 1),
  });
  await expect(repo.list('synthetic', { limit: 2, offset: 0 })).rejects.toThrow(
    'CHECK_IN_TEMPLATE_INVALID_RESPONSE',
  );
});
it('response bytes are checked before malformed body decode', async () => {
  const query = vi.fn<Transaction['query']>().mockResolvedValueOnce({
    rows: [{ bytes: String(4 * 1024 * 1024 + 1), value: { bad: true } }],
    rowCount: 1,
  });
  await expect(
    createCheckInTemplateRepository(database(query)).readHead('synthetic', randomUUID()),
  ).rejects.toThrow('CHECK_IN_TEMPLATE_BOUND');
});
it('rejects list caller fields and invalid exact identity before SQL', async () => {
  const query = vi.fn<Transaction['query']>(),
    repo = createCheckInTemplateRepository(database(query));
  await expect(repo.list('synthetic', { limit: 101, offset: 0 })).rejects.toThrow();
  await expect(repo.readExact('synthetic', 'opaque', randomUUID())).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});

it('rejects same-template storage response from a different immutable version', async () => {
  const input = command(),
    saved = record(input),
    query = vi
      .fn<Transaction['query']>()
      .mockResolvedValueOnce(result({ ...saved, versionId: randomUUID() }));
  await expect(
    createCheckInTemplateRepository(database(query)).readExact(
      'synthetic',
      saved.templateId,
      saved.versionId,
    ),
  ).rejects.toThrow('CHECK_IN_TEMPLATE_INVALID_RESPONSE');
});
it.each(['hole', 'custom_prototype'] as const)(
  'rejects nonplain field array %s before SQL',
  async (kind) => {
    const input = command(),
      query = vi.fn<Transaction['query']>();
    if (kind === 'hole') delete input.content.fields[0];
    else Object.setPrototypeOf(input.content.fields, { inherited: true });
    await expect(
      createCheckInTemplateRepository(database(query)).save('synthetic', input),
    ).rejects.toThrow('CHECK_IN_TEMPLATE_BOUND');
    expect(query).not.toHaveBeenCalled();
  },
);

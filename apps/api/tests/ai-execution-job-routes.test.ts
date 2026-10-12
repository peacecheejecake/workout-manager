import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiExecutionJobError } from '@workout/server-persistence/ai-execution-jobs';
import {
  aiExecutionJobStatusCode,
  registerAiExecutionJobRoutes,
  type AiExecutionJobService,
} from '../src/ai-execution-job-routes.js';
import { ProductRequestError } from '../src/product-boundary.js';

const threadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const evidenceSnapshotId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const jobId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const runId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const body = {
  commandVersion: 1,
  evidenceSnapshotId,
  expectedConversationRevision: 1,
  purpose: 'coaching',
  settings: {
    revision: 1,
    catalogRevision: 1,
    policyVersion: 'policy:1',
    disclosureVersion: 'disclosure:1',
  },
};
const job = {
  schemaVersion: 1,
  jobId,
  runId,
  threadId,
  evidenceSnapshotId,
  commandVersion: 1,
  purpose: 'coaching',
  payloadClassification: 'health',
  selection: { providerId: 'openai', modelId: 'gpt-6.1-sol' },
  settingsRevision: 1,
  catalogRevision: 1,
  policyVersion: 'policy:1',
  disclosureVersion: 'disclosure:1',
  recipient: { recipientId: 'openai', disclosureVersion: 'disclosure:1' },
  binding: {
    adapterBindingVersion: 'synthetic:1',
    vendorModelRef: 'synthetic:sol',
    priceModelRef: 'gpt-6.1-sol',
    priceVersion: 'synthetic:price:1',
    tokenizerVersion: 'synthetic:tokenizer:1',
  },
  selectionDigest: 'a'.repeat(64),
  createdAt: '2026-10-13T00:00:00.000Z',
  runStatus: { kind: 'queued' },
  disposition: null,
  dispatchAuthority: 'none',
};
const apps: ReturnType<typeof Fastify>[] = [];
function setup(service: Partial<AiExecutionJobService> = {}) {
  const port = {
    create: vi.fn().mockResolvedValue(job),
    read: vi.fn().mockResolvedValue(job),
    ...service,
  };
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    error instanceof ProductRequestError
      ? reply.code(error.statusCode).send({ error: { code: error.code } })
      : reply.code(500).send({ error: { code: 'INTERNAL' } }),
  );
  registerAiExecutionJobRoutes(app, port, () => ({
    athleteId: 'owner',
    sessionId: 'current',
    csrfToken: 'c'.repeat(43),
    method: 'cookie',
  }));
  apps.push(app);
  return { app, port };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('AI execution job API boundary', () => {
  it('passes the idempotency header as part of the versioned command and returns no-store', async () => {
    const { app, port } = setup();
    const response = await app.inject({
      method: 'POST',
      url: `/coaching-threads/${threadId}/ai-execution-jobs`,
      headers: { 'idempotency-key': 'synthetic-key' },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ jobId, dispatchAuthority: 'none' });
    expect(port.create).toHaveBeenCalledWith('owner', threadId, {
      ...body,
      idempotencyKey: 'synthetic-key',
    });
  });
  it('rejects browser-forged selection, permissions, model or missing key before the service', async () => {
    const { app, port } = setup();
    for (const [payload, headers] of [
      [
        { ...body, selection: { providerId: 'openai', modelId: 'gpt-6-luna' } },
        { 'idempotency-key': 'k' },
      ],
      [{ ...body, permissions: { app: true } }, { 'idempotency-key': 'k' }],
      [{ ...body, commandVersion: 2 }, { 'idempotency-key': 'k' }],
      [{ ...body, retrieval: { kind: 'none' } }, { 'idempotency-key': 'k' }],
      [body, {}],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/coaching-threads/${threadId}/ai-execution-jobs`,
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(port.create).not.toHaveBeenCalled();
  });
  it('maps stable repository codes and never exposes internal failures', async () => {
    const cases: [string, number][] = [
      ['THREAD_NOT_FOUND', 404],
      ['EVIDENCE_UNAVAILABLE', 422],
      ['SYNTHETIC_PAYLOAD_REQUIRED', 422],
      ['RESTORE_PROCESSING_CLOSED', 503],
      ['BINDING_REQUIRED', 503],
      ['IDEMPOTENCY_CONFLICT', 409],
      ['PERMISSION_REQUIRED', 409],
      ['STALE_METADATA', 409],
    ];
    for (const [code, status] of cases) {
      const { app } = setup({
        create: vi.fn().mockRejectedValue(new AiExecutionJobError(code as never)),
      });
      const response = await app.inject({
        method: 'POST',
        url: `/coaching-threads/${threadId}/ai-execution-jobs`,
        headers: { 'idempotency-key': 'k' },
        payload: body,
      });
      expect([response.statusCode, response.json()]).toEqual([status, { error: { code } }]);
      expect(aiExecutionJobStatusCode(code as never)).toBe(status);
    }
    const { app } = setup({ create: vi.fn().mockRejectedValue(new Error('secret detail')) });
    const failed = await app.inject({
      method: 'POST',
      url: `/coaching-threads/${threadId}/ai-execution-jobs`,
      headers: { 'idempotency-key': 'k' },
      payload: body,
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('secret');
  });
  it('refuses a service response for another thread or purpose', async () => {
    const { app } = setup({
      create: vi.fn().mockResolvedValue({ ...job, purpose: 'synthetic_comparison' }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/coaching-threads/${threadId}/ai-execution-jobs`,
      headers: { 'idempotency-key': 'k' },
      payload: body,
    });
    expect(response.statusCode).toBe(500);
  });
  it('reads one job, 404s when absent and validates the path', async () => {
    const read = vi.fn().mockResolvedValue(job);
    const { app } = setup({ read });
    expect(
      (await app.inject({ method: 'GET', url: `/ai-execution-jobs/${jobId}` })).json(),
    ).toEqual(job);
    read.mockResolvedValueOnce(null);
    expect(
      (await app.inject({ method: 'GET', url: `/ai-execution-jobs/${jobId}` })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/ai-execution-jobs/not-a-uuid' })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: `/ai-execution-jobs/${jobId}?debug=1` })).statusCode,
    ).toBe(400);
  });
});

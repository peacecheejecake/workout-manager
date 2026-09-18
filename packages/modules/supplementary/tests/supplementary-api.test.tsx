import { describe, expect, it } from 'vitest';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { createSupplementaryApi } from '../src/supplementary-api';
import type { SupplementaryRequestError } from '../src/supplementary-api';

describe('supplementary API', () => {
  it('sends a set revision with path ownership and idempotency header, excluding both from body', async () => {
    const calls: Parameters<AuthenticatedTransport['request']>[0][] = [];
    const transport: AuthenticatedTransport = {
      async request(input) {
        calls.push(input);
        return { status: 409, body: { error: { code: 'REVISION_CONFLICT' } }, traceId: null };
      },
    };
    const api = createSupplementaryApi(transport);
    const executionId = '11111111-1111-4111-8111-111111111111';
    const logId = '22222222-2222-4222-8222-222222222222';
    await expect(
      api.deleteSet({
        schemaVersion: 2,
        executionId,
        logId,
        expectedRevision: 2,
        idempotencyKey: 'stable_key_01',
        confirmed: true,
        reason: '잘못된 기록',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'REVISION_CONFLICT',
    } satisfies Partial<SupplementaryRequestError>);
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      path: `/bff/v1/supplementary/executions/${executionId}/sets/${logId}`,
      idempotencyKey: 'stable_key_01',
      body: { schemaVersion: 2, expectedRevision: 2, confirmed: true, reason: '잘못된 기록' },
    });
    expect(calls[0]?.body).not.toHaveProperty('executionId');
    expect(calls[0]?.body).not.toHaveProperty('logId');
    expect(calls[0]?.body).not.toHaveProperty('idempotencyKey');
  });

  it('lists without unsupported query parameters', async () => {
    const paths: string[] = [];
    const transport: AuthenticatedTransport = {
      async request(input) {
        paths.push(input.path);
        return { status: 200, body: { items: [], hasMore: false }, traceId: null };
      },
    };
    const api = createSupplementaryApi(transport);
    await Promise.all([
      api.listExercises(),
      api.listRoutines(),
      api.listExecutions(),
      api.listSets('11111111-1111-4111-8111-111111111111'),
      api.listTimers('11111111-1111-4111-8111-111111111111'),
    ]);
    expect(paths.every((path) => !path.includes('?'))).toBe(true);
  });
});

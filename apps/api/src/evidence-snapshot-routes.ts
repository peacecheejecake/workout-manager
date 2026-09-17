import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  coreEvidenceCaptureSchema,
  coreEvidenceSnapshotSchema,
  coreEvidenceSnapshotListQuerySchema,
  coreEvidenceSnapshotListSchema,
} from '@workout/contracts/evidence-snapshots';
import {
  CoreEvidenceSnapshotError,
  type CoreEvidenceSnapshotRepository,
} from '@workout/server-persistence/evidence-snapshots';
import type { Principal } from './ports.js';
import { input, command, emptyQuery, ProductRequestError } from './product-boundary.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const threadParams = z.strictObject({ threadId: uuid });
const snapshotParams = z.strictObject({ snapshotId: uuid });
function execute<T>(operation: () => Promise<T>) {
  return command(operation, (error) => {
    if (!(error instanceof CoreEvidenceSnapshotError)) return undefined;
    return new ProductRequestError(
      error.code === 'THREAD_NOT_FOUND' ? 404 : error.code === 'EVIDENCE_TOO_LARGE' ? 413 : 409,
      error.code,
    );
  });
}
export function registerCoreEvidenceSnapshotRoutes(
  routes: FastifyInstance,
  repository: CoreEvidenceSnapshotRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.post(
    '/coaching-threads/:threadId/evidence-snapshots',
    { bodyLimit: 16 * 1024 },
    async (request) => {
      input(emptyQuery, request.query);
      const { threadId } = input(threadParams, request.params);
      const body = input(coreEvidenceCaptureSchema.omit({ idempotencyKey: true }), request.body);
      const payload = input(coreEvidenceCaptureSchema, {
        ...body,
        idempotencyKey: request.headers['idempotency-key'],
      });
      return coreEvidenceSnapshotSchema.parse(
        await execute(() => repository.capture(principal(request).athleteId, threadId, payload)),
      );
    },
  );
  routes.get('/coaching-threads/:threadId/evidence-snapshots', async (request) => {
    const { threadId } = input(threadParams, request.params);
    const query = input(coreEvidenceSnapshotListQuerySchema, request.query);
    const result = await execute(() =>
      repository.list(principal(request).athleteId, threadId, query),
    );
    if (!result) throw new ProductRequestError(404, 'THREAD_NOT_FOUND');
    return coreEvidenceSnapshotListSchema.parse(result);
  });
  routes.get('/evidence-snapshots/:snapshotId', async (request) => {
    input(emptyQuery, request.query);
    const { snapshotId } = input(snapshotParams, request.params);
    const result = await execute(() => repository.read(principal(request).athleteId, snapshotId));
    if (!result) throw new ProductRequestError(404, 'EVIDENCE_SNAPSHOT_NOT_FOUND');
    return coreEvidenceSnapshotSchema.parse(result);
  });
}

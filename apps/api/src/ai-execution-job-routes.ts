import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  aiExecutionJobV1Schema,
  aiExecutionRunCommandV1Schema,
  type AiExecutionJobV1,
  type AiExecutionRunCommandV1,
} from '@workout/contracts/ai-execution-jobs';
import {
  AiExecutionJobError,
  type AiExecutionJobErrorCode,
  type AiExecutionJobRepository,
} from '@workout/server-persistence/ai-execution-jobs';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

// M2-05a: store an immutable execution selection only. The response never means
// a provider was called, budget was reserved or a plan proposal was approved.
// Root registers this inside the authenticated /bff/v1 plugin (session + CSRF).

export interface AiExecutionJobService {
  create(athleteId: string, threadId: string, command: AiExecutionRunCommandV1): Promise<unknown>;
  read(athleteId: string, jobId: string): Promise<unknown>;
}

const notFound = new Set<AiExecutionJobErrorCode>(['THREAD_NOT_FOUND', 'NOT_FOUND']);
const unprocessable = new Set<AiExecutionJobErrorCode>([
  'EVIDENCE_UNAVAILABLE',
  'UNSUPPORTED_EVIDENCE_VERSION',
  'INVALID_INTENT',
  'SELECTION_REQUIRED',
  'WRONG_PURPOSE',
  'NOT_SELECTABLE',
  'SYNTHETIC_PAYLOAD_REQUIRED',
]);
const unavailable = new Set<AiExecutionJobErrorCode>([
  'RESTORE_PROCESSING_CLOSED',
  'UNAVAILABLE',
  'MODEL_UNAVAILABLE',
  'BINDING_REQUIRED',
  'INVALID_REGISTRY',
  'INVALID_CATALOG',
  'INVALID_CLASSIFICATION',
]);
/** Stable status by code; internal integrity failures stay 500 (never mapped). */
export function aiExecutionJobStatusCode(code: AiExecutionJobErrorCode): number {
  if (notFound.has(code)) return 404;
  if (unprocessable.has(code)) return 422;
  if (unavailable.has(code)) return 503;
  return 409;
}
function execute<T>(operation: () => Promise<T>): Promise<T> {
  return command(operation, (error) =>
    error instanceof AiExecutionJobError
      ? new ProductRequestError(aiExecutionJobStatusCode(error.code), error.code)
      : undefined,
  );
}

const uuid = z.uuid().transform((value) => value.toLowerCase());
const threadParams = z.strictObject({ threadId: uuid });
const jobParams = z.strictObject({ jobId: uuid });

export function createAiExecutionJobService(
  repository: AiExecutionJobRepository,
): AiExecutionJobService {
  return {
    create: (athleteId, threadId, body) => repository.create(athleteId, threadId, body),
    read: (athleteId, jobId) => repository.read(athleteId, jobId),
  };
}

export function registerAiExecutionJobRoutes(
  routes: FastifyInstance,
  service: AiExecutionJobService,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.post(
    '/coaching-threads/:threadId/ai-execution-jobs',
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      input(emptyQuery, request.query);
      const { threadId } = input(threadParams, request.params);
      const body = input(
        aiExecutionRunCommandV1Schema.omit({ idempotencyKey: true }),
        request.body,
      );
      const payload = input(aiExecutionRunCommandV1Schema, {
        ...body,
        idempotencyKey: request.headers['idempotency-key'],
      });
      const job: AiExecutionJobV1 = aiExecutionJobV1Schema.parse(
        await execute(() => service.create(principal(request).athleteId, threadId, payload)),
      );
      if (
        job.threadId !== threadId ||
        job.evidenceSnapshotId !== payload.evidenceSnapshotId ||
        job.purpose !== payload.purpose ||
        job.settingsRevision !== payload.settings.revision
      )
        throw new Error('AI_EXECUTION_JOB_RESPONSE_INVALID');
      return job;
    },
  );
  routes.get('/ai-execution-jobs/:jobId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    input(emptyQuery, request.query);
    const { jobId } = input(jobParams, request.params);
    const result = await execute(() => service.read(principal(request).athleteId, jobId));
    if (result === null) throw new ProductRequestError(404, 'JOB_NOT_FOUND');
    const job = aiExecutionJobV1Schema.parse(result);
    if (job.jobId !== jobId) throw new Error('AI_EXECUTION_JOB_RESPONSE_INVALID');
    return job;
  });
}

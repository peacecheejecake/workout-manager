import { z } from 'zod';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  trainingCandidateApprovalBodyV1Schema,
  trainingCandidateBundleV1Schema,
  trainingCandidatePartialRequestV1Schema,
  trainingCandidateStatusV1Schema,
  type TrainingCandidatePartialRequestV1,
} from '@workout/contracts/coaching-candidates';
import { planReadSchema, planSnapshotSchema } from '@workout/contracts/planning';

const candidateIdSchema = z.uuid().transform((value) => value.toLowerCase());
const knownErrors = new Set([
  'CANDIDATE_UNAVAILABLE',
  'CANDIDATE_NOT_APPROVABLE',
  'INVALID_PARTIAL_SELECTION',
  'PLAN_VERSION_MISMATCH',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
]);

export class CandidateRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function createCandidateApi(transport: AuthenticatedTransport) {
  async function request<T>(
    method: TransportRequest['method'],
    path: string,
    schema: z.ZodType<T>,
    body: TransportRequest['body'] = null,
    idempotencyKey: string | null = null,
    signal?: AbortSignal,
  ): Promise<T> {
    let raw: unknown;
    try {
      raw = await transport.request({
        method,
        path,
        body,
        idempotencyKey,
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new Error('CANDIDATE_TRANSPORT_UNCONFIRMED');
    }
    const envelope = transportReplySchema.safeParse(raw);
    if (!envelope.success) throw new Error('CANDIDATE_RESPONSE_INVALID');
    const reply = envelope.data;
    if (reply.status < 200 || reply.status >= 300) {
      const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(reply.body);
      throw new CandidateRequestError(
        reply.status,
        parsed.success && knownErrors.has(parsed.data.error.code)
          ? parsed.data.error.code
          : 'REQUEST_FAILED',
      );
    }
    const parsed = schema.safeParse(reply.body);
    if (!parsed.success) throw new Error('CANDIDATE_RESPONSE_INVALID');
    return parsed.data;
  }
  const path = (id: string) =>
    `/bff/v1/coaching-candidates/${encodeURIComponent(candidateIdSchema.parse(id))}`;
  const runPath = (id: string) =>
    `/bff/v1/coaching-runs/${encodeURIComponent(candidateIdSchema.parse(id))}/candidates`;
  return {
    async peers(runId: string, signal?: AbortSignal) {
      const normalized = candidateIdSchema.parse(runId);
      const peers = await request(
        'GET',
        runPath(normalized),
        z.array(trainingCandidateBundleV1Schema).max(100),
        null,
        null,
        signal,
      );
      if (peers.some((peer) => peer.candidate.runId !== normalized))
        throw new Error('CANDIDATE_RESPONSE_MISMATCH');
      return peers;
    },
    async read(id: string, signal?: AbortSignal) {
      const normalized = candidateIdSchema.parse(id);
      const bundle = await request(
        'GET',
        path(normalized),
        trainingCandidateBundleV1Schema,
        null,
        null,
        signal,
      );
      if (bundle.candidate.id !== normalized) throw new Error('CANDIDATE_RESPONSE_MISMATCH');
      return bundle;
    },
    async status(id: string, signal?: AbortSignal) {
      const normalized = candidateIdSchema.parse(id);
      const status = await request(
        'GET',
        `${path(normalized)}/status`,
        trainingCandidateStatusV1Schema,
        null,
        null,
        signal,
      );
      if (status.candidateId !== normalized) throw new Error('CANDIDATE_RESPONSE_MISMATCH');
      return status;
    },
    plan(signal?: AbortSignal) {
      return request('GET', '/bff/v1/plans/current', planReadSchema, null, null, signal);
    },
    async partial(id: string, input: TrainingCandidatePartialRequestV1, signal?: AbortSignal) {
      const normalized = candidateIdSchema.parse(id);
      const { idempotencyKey, ...body } = trainingCandidatePartialRequestV1Schema.parse(input);
      const bundle = await request(
        'POST',
        `${path(normalized)}/partials`,
        trainingCandidateBundleV1Schema,
        body,
        idempotencyKey,
        signal,
      );
      if (bundle.candidate.parentCandidateId !== normalized)
        throw new Error('CANDIDATE_RESPONSE_MISMATCH');
      return bundle;
    },
    async approve(
      id: string,
      expectedDigest: string,
      idempotencyKey: string,
      signal?: AbortSignal,
    ) {
      const body = trainingCandidateApprovalBodyV1Schema.parse({
        schemaVersion: 1,
        expectedDigest,
        confirmed: true,
      });
      return request(
        'POST',
        `${path(id)}/approve`,
        planSnapshotSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
  };
}

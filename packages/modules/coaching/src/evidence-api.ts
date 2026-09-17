import { z } from 'zod';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  coreEvidenceCaptureSchema,
  coreEvidenceSnapshotSchema,
  coreEvidenceSnapshotListSchema,
  coreEvidenceSnapshotListQuerySchema,
  type CoreEvidenceCapture,
  type CoreEvidenceSnapshotListQuery,
} from '@workout/contracts/evidence-snapshots';
export class EvidenceRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const uuid = z.uuid().transform((value) => value.toLowerCase());
const known = new Set([
  'THREAD_NOT_FOUND',
  'EVIDENCE_SNAPSHOT_NOT_FOUND',
  'EVIDENCE_TOO_LARGE',
  'CONVERSATION_REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_REQUEST',
  'SESSION_CHANGED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
]);
export function createEvidenceApi(transport: AuthenticatedTransport) {
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    body: TransportRequest['body'] = null,
    key: string | null = null,
  ): Promise<T> {
    let raw: unknown;
    try {
      raw = await transport.request({
        path,
        method: body === null ? 'GET' : 'POST',
        body,
        idempotencyKey: key,
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new Error('EVIDENCE_TRANSPORT_UNCONFIRMED');
    }
    const envelope = transportReplySchema.safeParse(raw);
    if (!envelope.success) throw new Error('EVIDENCE_RESPONSE_INVALID');
    const reply = envelope.data;
    if (reply.status < 200 || reply.status >= 300) {
      const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(reply.body);
      throw new EvidenceRequestError(
        reply.status,
        error.success && known.has(error.data.error.code)
          ? error.data.error.code
          : 'REQUEST_FAILED',
      );
    }
    const parsed = schema.safeParse(reply.body);
    if (!parsed.success) throw new Error('EVIDENCE_RESPONSE_INVALID');
    return parsed.data;
  }
  return {
    async list(
      threadId: string,
      input: Partial<CoreEvidenceSnapshotListQuery>,
      signal?: AbortSignal,
    ) {
      const thread = uuid.parse(threadId),
        query = coreEvidenceSnapshotListQuerySchema.parse(input);
      const result = await request(
        `/bff/v1/coaching-threads/${encodeURIComponent(thread)}/evidence-snapshots?${new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) })}`,
        coreEvidenceSnapshotListSchema,
        signal,
      );
      if (
        result.items.length > query.limit ||
        result.items.some((item) => item.threadId !== thread)
      )
        throw new Error('EVIDENCE_RESPONSE_MISMATCH');
      return result;
    },
    async read(threadId: string, snapshotId: string, signal?: AbortSignal) {
      const thread = uuid.parse(threadId),
        id = uuid.parse(snapshotId);
      const result = await request(
        `/bff/v1/evidence-snapshots/${encodeURIComponent(id)}`,
        coreEvidenceSnapshotSchema,
        signal,
      );
      if (result.threadId !== thread || result.id !== id)
        throw new Error('EVIDENCE_RESPONSE_MISMATCH');
      return result;
    },
    async capture(threadId: string, input: CoreEvidenceCapture, signal?: AbortSignal) {
      const thread = uuid.parse(threadId),
        { idempotencyKey, ...body } = coreEvidenceCaptureSchema.parse(input);
      const result = await request(
        `/bff/v1/coaching-threads/${encodeURIComponent(thread)}/evidence-snapshots`,
        coreEvidenceSnapshotSchema,
        signal,
        body,
        idempotencyKey,
      );
      if (result.threadId !== thread) throw new Error('EVIDENCE_RESPONSE_MISMATCH');
      if (
        result.status === 'available' &&
        (result.body.thread.revision !== body.expectedConversationRevision ||
          result.body.window.from !== body.window.from ||
          result.body.window.toExclusive !== body.window.toExclusive ||
          result.body.window.timezone !== body.window.timezone)
      )
        throw new Error('EVIDENCE_RESPONSE_MISMATCH');
      return result;
    },
  };
}

import type { z } from 'zod';
import {
  transportReplySchema,
  transportRequestDtoSchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  gallerySubtitleAttachBodyV1Schema,
  gallerySubtitleAttachResultV1Schema,
  gallerySubtitleDetachBodyV1Schema,
  gallerySubtitleDetachResultV1Schema,
  gallerySubtitleIdempotencyHeaderV1Schema,
  gallerySubtitleReadRequestV1Schema,
  gallerySubtitleReadResultV1Schema,
} from '@workout/contracts/gallery-subtitles-v1';

export type GallerySubtitlesErrorCode =
  'INVALID_INPUT' | 'INVALID_REPLY' | 'REQUEST_FAILED' | 'TRANSPORT_FAILED' | 'ABORTED';
export type GallerySubtitlesMutationOutcome =
  'not_applicable' | 'not_sent' | 'rejected' | 'uncertain';

/** No server text, error bodies, source bytes, labels or credentials are retained. */
export class GallerySubtitlesRequestError extends Error {
  constructor(
    readonly code: GallerySubtitlesErrorCode,
    readonly status: number | null = null,
    readonly mutationOutcome: GallerySubtitlesMutationOutcome = 'not_applicable',
  ) {
    super(code);
    this.name = 'GallerySubtitlesRequestError';
  }
}

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: GallerySubtitlesErrorCode,
  outcome: GallerySubtitlesMutationOutcome,
): T {
  try {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch {
    // Descriptor/proxy/schema failures are also untrusted boundary failures.
  }
  throw new GallerySubtitlesRequestError(code, null, outcome);
}

function envelope(raw: unknown) {
  if (typeof raw !== 'object' || raw === null || Object.getPrototypeOf(raw) !== Object.prototype)
    throw new Error('INVALID_REPLY');
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== 3 || !['status', 'body', 'traceId'].every((key) => keys.includes(key)))
    throw new Error('INVALID_REPLY');
  function field(key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      throw new Error('INVALID_REPLY');
    return descriptor.value;
  }
  return { status: field('status'), body: field('body'), traceId: field('traceId') };
}

/** Authentication/policy/storage authority belong to the injected transport and server. */
export function createGallerySubtitlesApi(transport: AuthenticatedTransport) {
  async function request<T>(
    path: string,
    method: TransportRequest['method'],
    body: unknown,
    key: string | null,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const mutation = method !== 'GET';
    const before = mutation ? 'not_sent' : 'not_applicable';
    const after = mutation ? 'uncertain' : 'not_applicable';
    if (signal !== undefined && !(signal instanceof AbortSignal))
      throw new GallerySubtitlesRequestError('INVALID_INPUT', null, before);
    if (signal?.aborted) throw new GallerySubtitlesRequestError('ABORTED', null, before);
    const dto = parse(
      transportRequestDtoSchema,
      { path, method, body, idempotencyKey: key },
      'INVALID_INPUT',
      before,
    );
    let raw: unknown;
    try {
      raw = await transport.request({ ...dto, ...(signal === undefined ? {} : { signal }) });
    } catch {
      throw new GallerySubtitlesRequestError(
        signal?.aborted ? 'ABORTED' : 'TRANSPORT_FAILED',
        null,
        after,
      );
    }
    if (signal?.aborted) throw new GallerySubtitlesRequestError('ABORTED', null, after);
    let fields: ReturnType<typeof envelope>;
    try {
      fields = envelope(raw);
    } catch {
      throw new GallerySubtitlesRequestError('INVALID_REPLY', null, after);
    }
    const status = parse(transportReplySchema.shape.status, fields.status, 'INVALID_REPLY', after);
    parse(transportReplySchema.shape.traceId, fields.traceId, 'INVALID_REPLY', after);
    if (status !== 200) {
      if (status >= 200 && status < 300)
        throw new GallerySubtitlesRequestError('INVALID_REPLY', status, after);
      const outcome =
        mutation && [400, 401, 403, 404, 409, 413, 422].includes(status) ? 'rejected' : after;
      // Error body is intentionally never traversed, even for 409.
      throw new GallerySubtitlesRequestError('REQUEST_FAILED', status, outcome);
    }
    const value = parse(schema, fields.body, 'INVALID_REPLY', after);
    parse(transportReplySchema, { ...fields, body: value }, 'INVALID_REPLY', after);
    return value;
  }
  function identity(raw: unknown, outcome: GallerySubtitlesMutationOutcome) {
    return parse(gallerySubtitleReadRequestV1Schema, raw, 'INVALID_INPUT', outcome);
  }
  function key(raw: unknown) {
    return parse(gallerySubtitleIdempotencyHeaderV1Schema, raw, 'INVALID_INPUT', 'not_sent')[
      'idempotency-key'
    ];
  }
  return {
    async read(raw: unknown, signal?: AbortSignal) {
      const input = identity(raw, 'not_applicable');
      const query = new URLSearchParams({ accessRevision: String(input.accessRevision) });
      return request(
        `/bff/v1/gallery/media/${input.mediaItemId}/subtitles?${query.toString()}`,
        'GET',
        null,
        null,
        gallerySubtitleReadResultV1Schema.refine(
          (reply) =>
            reply.mediaItemId.toLowerCase() === input.mediaItemId &&
            reply.accessRevision === input.accessRevision,
        ),
        signal,
      );
    },
    async attach(
      rawMediaItemId: unknown,
      rawBody: unknown,
      rawHeader: unknown,
      signal?: AbortSignal,
    ) {
      const body = parse(gallerySubtitleAttachBodyV1Schema, rawBody, 'INVALID_INPUT', 'not_sent');
      const input = identity(
        { mediaItemId: rawMediaItemId, accessRevision: body.expectedAccessRevision },
        'not_sent',
      );
      return request(
        `/bff/v1/gallery/media/${input.mediaItemId}/subtitles`,
        'POST',
        body,
        key(rawHeader),
        gallerySubtitleAttachResultV1Schema.refine(
          (reply) =>
            reply.mediaItemId === input.mediaItemId &&
            reply.accessRevision === body.expectedAccessRevision + 1 &&
            reply.trackRevision === 1,
        ),
        signal,
      );
    },
    async detach(
      rawMediaItemId: unknown,
      rawTrackId: unknown,
      rawBody: unknown,
      rawHeader: unknown,
      signal?: AbortSignal,
    ) {
      const body = parse(gallerySubtitleDetachBodyV1Schema, rawBody, 'INVALID_INPUT', 'not_sent');
      const input = identity(
        { mediaItemId: rawMediaItemId, accessRevision: body.expectedAccessRevision },
        'not_sent',
      );
      const target = identity(
        { mediaItemId: rawTrackId, accessRevision: body.expectedTrackRevision },
        'not_sent',
      );
      if (target.mediaItemId !== body.trackId)
        throw new GallerySubtitlesRequestError('INVALID_INPUT', null, 'not_sent');
      return request(
        `/bff/v1/gallery/media/${input.mediaItemId}/subtitles/${target.mediaItemId}`,
        'DELETE',
        body,
        key(rawHeader),
        gallerySubtitleDetachResultV1Schema.refine(
          (reply) =>
            reply.mediaItemId === input.mediaItemId &&
            reply.trackId === target.mediaItemId &&
            reply.accessRevision === body.expectedAccessRevision + 1 &&
            reply.trackRevision === body.expectedTrackRevision + 1,
        ),
        signal,
      );
    },
  };
}
export type GallerySubtitlesApi = ReturnType<typeof createGallerySubtitlesApi>;

/**
 * Viewer read port over the authenticated BFF. Only finite statuses are mapped:
 * 503 means the server has no subtitle storage configured, 409 means the access
 * revision moved. Every other failure stays a load failure; 404 is not reported
 * as a confirmed missing/none state because error bodies are never read.
 */
export function createGallerySubtitlesReader(transport: AuthenticatedTransport) {
  const api = createGallerySubtitlesApi(transport);
  return {
    async read(input: {
      mediaItemId: string;
      accessRevision: number;
      signal: AbortSignal;
    }): Promise<unknown> {
      const { mediaItemId, accessRevision, signal } = input;
      try {
        return await api.read({ mediaItemId, accessRevision }, signal);
      } catch (error) {
        if (
          error instanceof GallerySubtitlesRequestError &&
          error.code === 'REQUEST_FAILED' &&
          (error.status === 503 || error.status === 409)
        )
          return {
            schemaVersion: 1,
            mediaItemId,
            accessRevision,
            status: 'unavailable',
            reason: error.status === 503 ? 'reader_unavailable' : 'stale_response',
          };
        throw error;
      }
    },
  };
}

import {
  privateUrlResourceAppendVersionSchema,
  privateUrlResourceCreateSchema,
  privateUrlResourceIngestionRecordSchema,
  type PrivateUrlResourceFailure,
} from '@workout/contracts/resources';
import { ResourceNotFoundError } from '@workout/server-persistence/resources';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const resourceParamsSchema = z.strictObject({
  resourceId: z.uuid().transform((value) => value.toLowerCase()),
});
const ingestionParamsSchema = z.strictObject({
  ingestionId: z.uuid().transform((value) => value.toLowerCase()),
});
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const URL_COMMAND_BODY_LIMIT = 24 * 1024;

type IngestionState =
  'queued' | 'fetching' | 'parsing' | 'finalized' | 'bookmark_only' | 'failed' | 'cancelled';

export interface ResourceUrlIngestionRouteRecord {
  requestId: string;
  operation: 'create' | 'append';
  resourceId: string;
  versionId: string;
  state: IngestionState;
  displayUrl: string;
  failureCode: string | null;
  failurePhase: 'fetch' | 'parse' | null;
  retryable: boolean;
  failedAt: string | null;
  retryAt: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceUrlIngestionRouteRepository {
  reserveCreate(
    athleteId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<ResourceUrlIngestionRouteRecord>;
  reserveAppend(
    athleteId: string,
    resourceId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<ResourceUrlIngestionRouteRecord>;
  get(athleteId: string, ingestionId: string): Promise<ResourceUrlIngestionRouteRecord>;
  cancel(athleteId: string, ingestionId: string): Promise<boolean>;
}

function execute<T>(operation: () => Promise<T>) {
  return command(operation, (error) => {
    if (error instanceof ResourceNotFoundError)
      return new ProductRequestError(404, 'RESOURCE_URL_INGESTION_NOT_FOUND');
    if (error instanceof Error && error.message === 'URL_INGESTION_QUOTA_EXCEEDED')
      return new ProductRequestError(409, 'URL_INGESTION_QUOTA_EXCEEDED');
    return undefined;
  });
}

function urlCommandInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProductRequestError(422, 'INVALID_RESOURCE_URL_INGESTION');
  return parsed.data;
}

function fetchFailureCode(
  code: string,
): Extract<PrivateUrlResourceFailure, { stage: 'fetch' }>['code'] {
  switch (code) {
    case 'URL_NOT_ALLOWED':
      return 'blocked_host';
    case 'DNS_ADDRESS_REJECTED':
    case 'REMOTE_ADDRESS_MISMATCH':
      return 'blocked_address';
    case 'REDIRECT_REJECTED':
      return 'redirect_blocked';
    case 'REDIRECT_LIMIT_EXCEEDED':
      return 'redirect_limit';
    case 'FETCH_TIMEOUT':
      return 'timeout';
    case 'COMPRESSED_RESPONSE_TOO_LARGE':
    case 'DECODED_RESPONSE_TOO_LARGE':
    case 'DECOMPRESSION_LIMIT':
    case 'RESPONSE_HEADERS_TOO_LARGE':
      return 'response_too_large';
    case 'UNSUPPORTED_CONTENT_TYPE':
    case 'UNSUPPORTED_CONTENT_ENCODING':
      return 'unsupported_media_type';
    case 'HTTP_STATUS_REJECTED':
      return 'http_status';
    default:
      return 'network_error';
  }
}

function parseFailureCode(
  code: string,
): Extract<PrivateUrlResourceFailure, { stage: 'parse' }>['code'] {
  switch (code) {
    case 'PARSER_INPUT_TOO_LARGE':
      return 'input_too_large';
    case 'PARSER_INVALID_UTF8':
      return 'malformed';
    case 'PARSER_OUTPUT_TOO_LARGE':
    case 'PARSER_FRAGMENT_LIMIT':
      return 'output_too_large';
    case 'PARSER_COMPLEXITY_LIMIT':
      return 'unsupported';
    case 'PARSER_TIMEOUT':
      return 'timeout';
    case 'NO_EXTRACTABLE_TEXT':
      return 'no_extractable_text';
    default:
      return 'internal_error';
  }
}

function publicRecord(record: ResourceUrlIngestionRouteRecord) {
  const lifecycle = {
    contentStatus: record.state,
    displayUrl: record.displayUrl,
    attempt: record.attemptCount,
    retryAt: record.retryAt,
    indexStatus: 'not_indexed' as const,
    ...(record.state === 'failed'
      ? {
          failure: {
            stage: record.failurePhase ?? 'fetch',
            code:
              record.failurePhase === 'parse'
                ? parseFailureCode(record.failureCode ?? '')
                : fetchFailureCode(record.failureCode ?? ''),
            retryable: record.retryable,
            failedAt: record.failedAt ?? record.updatedAt,
          },
        }
      : {}),
  };
  return privateUrlResourceIngestionRecordSchema.parse({
    schemaVersion: 1,
    ingestionId: record.requestId,
    operation: record.operation,
    resourceId: record.resourceId,
    versionId: record.versionId,
    lifecycle,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function registerResourceUrlRoutes(
  routes: FastifyInstance,
  repository: ResourceUrlIngestionRouteRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.post(
    '/resources/url-ingestions',
    { bodyLimit: URL_COMMAND_BODY_LIMIT },
    async (request) => {
      input(emptyQuery, request.query);
      const body = urlCommandInput(
        privateUrlResourceCreateSchema.omit({ idempotencyKey: true }),
        request.body,
      );
      const key = input(idempotencyKeySchema, request.headers['idempotency-key']);
      return publicRecord(
        await execute(() => repository.reserveCreate(principal(request).athleteId, body, key)),
      );
    },
  );

  routes.post(
    '/resources/:resourceId/url-ingestions',
    { bodyLimit: URL_COMMAND_BODY_LIMIT },
    async (request) => {
      input(emptyQuery, request.query);
      const { resourceId } = input(resourceParamsSchema, request.params);
      const body = urlCommandInput(
        privateUrlResourceAppendVersionSchema.omit({ idempotencyKey: true }),
        request.body,
      );
      const key = input(idempotencyKeySchema, request.headers['idempotency-key']);
      return publicRecord(
        await execute(() =>
          repository.reserveAppend(principal(request).athleteId, resourceId, body, key),
        ),
      );
    },
  );

  routes.get('/resources/url-ingestions/:ingestionId', async (request) => {
    input(emptyQuery, request.query);
    const { ingestionId } = input(ingestionParamsSchema, request.params);
    return publicRecord(
      await execute(() => repository.get(principal(request).athleteId, ingestionId)),
    );
  });

  routes.delete('/resources/url-ingestions/:ingestionId', async (request) => {
    input(emptyQuery, request.query);
    if (request.body !== undefined) throw new ProductRequestError(400, 'INVALID_REQUEST');
    const { ingestionId } = input(ingestionParamsSchema, request.params);
    const athleteId = principal(request).athleteId;
    const cancelled = await execute(() => repository.cancel(athleteId, ingestionId));
    if (!cancelled) throw new ProductRequestError(404, 'RESOURCE_URL_INGESTION_NOT_FOUND');
    return publicRecord(await execute(() => repository.get(athleteId, ingestionId)));
  });
}

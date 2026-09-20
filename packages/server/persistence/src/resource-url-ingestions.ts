import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';

import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';
import { ResourceNotFoundError } from './resources.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const idempotencyKey = z
  .string()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);
const metadataSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  category: z.enum(['paper', 'guide', 'note', 'race_material']),
  metadata: z.record(z.string(), z.unknown()).default({}),
  tags: z.array(z.string().min(1).max(100)).max(20).default([]),
  favorite: z.boolean().default(false),
  url: z.string(),
});
const appendSchema = z.strictObject({
  expectedCurrentVersionId: uuid,
  url: z.string().optional(),
});
const state = z.enum([
  'queued',
  'fetching',
  'parsing',
  'finalized',
  'bookmark_only',
  'failed',
  'cancelled',
]);
const rowSchema = z.object({
  request_id: uuid,
  resource_id: uuid,
  version_id: uuid,
  operation: z.enum(['create', 'append']),
  state,
  display_url: z.string(),
  failure_code: z.string().nullable(),
  failure_phase: z.enum(['fetch', 'parse']).nullable(),
  failure_retryable: z.boolean(),
  failed_at: z.union([z.date(), z.string()]).nullable(),
  retry_at: z.union([z.date(), z.string()]).nullable(),
  attempt_count: z.number().int(),
  created_at: z.union([z.date(), z.string()]),
  updated_at: z.union([z.date(), z.string()]),
});
const instant = (value: Date | string) =>
  (value instanceof Date ? value : new Date(value)).toISOString();

const publicReservationColumns = `request_id,resource_id,version_id,operation,state,display_url,
  failure_code,failure_phase,failure_retryable,failed_at,retry_at,attempt_count,created_at,updated_at`;

export type ResourceUrlIngestionReservation = {
  requestId: string;
  resourceId: string;
  versionId: string;
  operation: 'create' | 'append';
  state: z.infer<typeof state>;
  displayUrl: string;
  failureCode: string | null;
  failurePhase: 'fetch' | 'parse' | null;
  retryable: boolean;
  failedAt: string | null;
  retryAt: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ResourceUrlIngestionLease = {
  athleteId: string;
  requestId: string;
  attemptNo: number;
  phase: 'fetch' | 'parse';
  leaseToken: string;
  requestedUrl: string;
  displayUrl: string;
  resourceId: string;
  versionId: string;
  rawTemporaryRef: string;
  rawStorageRef: string | null;
  rawMediaType: 'text/html' | 'application/xhtml+xml' | 'text/plain' | 'text/markdown' | null;
  parsedTemporaryRef: string;
};

export type ResourceUrlFragment = {
  ordinal: number;
  kind: 'html_block' | 'markdown_paragraph' | 'plain_paragraph';
  headingPath: string[];
  paragraphIndex?: number;
  text: string;
  startOffset: number;
  endOffset: number;
  pageNumber?: number;
};

function safeUrl(raw: string) {
  const hasControlCharacter = [...raw].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (
    raw !== raw.trim() ||
    hasControlCharacter ||
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(raw) ||
    Buffer.byteLength(raw, 'utf8') > 2048
  )
    throw new Error('INVALID_RESOURCE_URL');
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      Buffer.byteLength(parsed.href, 'utf8') > 2048
    )
      throw new Error('INVALID_RESOURCE_URL');
    return { requestedUrl: raw, displayUrl: `${parsed.origin}${parsed.pathname}` };
  } catch {
    throw new Error('INVALID_RESOURCE_URL');
  }
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function reservation(row: z.infer<typeof rowSchema>): ResourceUrlIngestionReservation {
  return {
    requestId: row.request_id,
    resourceId: row.resource_id,
    versionId: row.version_id,
    operation: row.operation,
    state: row.state,
    displayUrl: row.display_url,
    failureCode: row.failure_code,
    failurePhase: row.failure_phase,
    retryable: row.failure_retryable,
    failedAt: row.failed_at === null ? null : instant(row.failed_at),
    retryAt: row.retry_at === null ? null : instant(row.retry_at),
    attemptCount: row.attempt_count,
    createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at),
  };
}

async function reserve(
  tx: Transaction,
  operation: 'create' | 'append',
  resourceId: string,
  input: z.infer<typeof metadataSchema> | z.infer<typeof appendSchema>,
  key: string,
) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
  const append = operation === 'append' ? appendSchema.parse(input) : null;
  const prior = await tx.query(
    `SELECT ${publicReservationColumns} FROM resource_url_ingestion
     WHERE athlete_id=$1 AND idempotency_key=$2`,
    [tx.athleteId, key],
  );
  if (prior.rows[0]) {
    const internal = await tx.query('SELECT * FROM public.resource_url_request_by_key($1)', [key]);
    const replayUrl = safeUrl(z.string().parse(input.url ?? internal.rows[0]?.['requested_url']));
    const replayRequest = {
      operation,
      resourceId: operation === 'append' ? resourceId : null,
      input: { ...input, url: replayUrl.requestedUrl },
    };
    if (internal.rows[0]?.['request_digest'] !== digest(replayRequest))
      throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
    return reservation(rowSchema.parse(prior.rows[0]));
  }
  let resolvedUrl = input.url;
  if (append) {
    const head = await tx.query('SELECT * FROM public.current_resource_url_request($1)', [
      resourceId,
    ]);
    if (!head.rows[0]) throw new ResourceNotFoundError();
    if (head.rows[0]['current_version_id'] !== append.expectedCurrentVersionId)
      throw new PersistenceConflict('REVISION_CONFLICT');
    resolvedUrl ??= z.string().parse(head.rows[0]['requested_url']);
  }
  const url = safeUrl(z.string().parse(resolvedUrl));
  const resolvedInput = { ...input, url: url.requestedUrl };
  const request = {
    operation,
    resourceId: operation === 'append' ? resourceId : null,
    input: resolvedInput,
  };
  const requestDigest = digest(request);
  const counts = await tx.query(
    `SELECT count(*) FILTER (WHERE state IN ('queued','fetching','parsing'))::integer AS active,
      count(*) FILTER (WHERE state IN ('queued','fetching','parsing','failed','cancelled'))::integer AS retained
     FROM resource_url_ingestion WHERE athlete_id=$1`,
    [tx.athleteId],
  );
  if (Number(counts.rows[0]?.['active']) >= 20 || Number(counts.rows[0]?.['retained']) >= 100)
    throw new Error('URL_INGESTION_QUOTA_EXCEEDED');
  const requestId = randomUUID();
  const versionId = randomUUID();
  const createdAt = instant(
    z
      .union([z.date(), z.string()])
      .parse((await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at']),
  );
  const expiresAt = new Date(new Date(createdAt).getTime() + 30 * 60_000).toISOString();
  const create = operation === 'create' ? metadataSchema.parse(input) : null;
  const prefix = `private/v1/tenants/${tx.athleteId}/resources/${resourceId}/url-ingestions/${requestId}`;
  const inserted = await tx.query(
    `INSERT INTO resource_url_ingestion
     (athlete_id,request_id,idempotency_key,request_digest,operation,resource_id,version_id,
      expected_current_version_id,requested_url,display_url,title,category,metadata,tags,favorite,state,
      raw_temporary_ref,parsed_temporary_ref,created_at,updated_at,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,'queued',$16,$17,$18,$18,$19)
     RETURNING ${publicReservationColumns}`,
    [
      tx.athleteId,
      requestId,
      key,
      requestDigest,
      operation,
      resourceId,
      versionId,
      append?.expectedCurrentVersionId ?? null,
      url.requestedUrl,
      url.displayUrl,
      create?.title ?? null,
      create?.category ?? null,
      JSON.stringify(create?.metadata ?? {}),
      JSON.stringify(create?.tags ?? []),
      create?.favorite ?? false,
      `${prefix}/temporary/raw`,
      `${prefix}/temporary/parsed`,
      createdAt,
      expiresAt,
    ],
  );
  await enqueue(tx, {
    id: randomUUID(),
    idempotencyKey: `resource:url:request:${key}`,
    topic: 'resource.url_ingestion_requested',
    payload: { requestId, resourceId, versionId, operation },
  });
  return reservation(rowSchema.parse(inserted.rows[0]));
}

export function createResourceUrlIngestionRepository(database: Database) {
  return {
    reserveCreate(athleteId: string, raw: unknown, rawKey: string) {
      const input = metadataSchema.parse(raw);
      const resourceId = randomUUID();
      return database.tenant(uuid.parse(athleteId), (tx) =>
        reserve(tx, 'create', resourceId, input, idempotencyKey.parse(rawKey)),
      );
    },
    reserveAppend(athleteId: string, rawResourceId: string, raw: unknown, rawKey: string) {
      const input = appendSchema.parse(raw);
      return database.tenant(uuid.parse(athleteId), (tx) =>
        reserve(tx, 'append', uuid.parse(rawResourceId), input, idempotencyKey.parse(rawKey)),
      );
    },
    get(athleteId: string, rawRequestId: string) {
      return database.tenant(uuid.parse(athleteId), async (tx) => {
        const result = await tx.query(
          `SELECT ${publicReservationColumns} FROM resource_url_ingestion
           WHERE athlete_id=$1 AND request_id=$2`,
          [tx.athleteId, uuid.parse(rawRequestId)],
        );
        if (!result.rows[0]) throw new ResourceNotFoundError();
        return reservation(rowSchema.parse(result.rows[0]));
      });
    },
    cancel(athleteId: string, rawRequestId: string, code = 'USER_CANCELLED') {
      const requestId = uuid.parse(rawRequestId);
      const failure = z
        .string()
        .regex(/^[A-Z0-9_:-]+$/)
        .max(100)
        .parse(code);
      return database.tenant(uuid.parse(athleteId), async (tx) => {
        const result = await tx.query(
          'SELECT public.cancel_resource_url_ingestion($1,$2) AS cancelled',
          [requestId, failure],
        );
        return result.rows[0]?.['cancelled'] === true;
      });
    },
  };
}

const leaseSchema = z.object({
  athlete_id: z.string(),
  request_id: uuid,
  attempt_no: z.number().int(),
  phase: z.enum(['fetch', 'parse']),
  lease_token: uuid,
  requested_url: z.string(),
  display_url: z.string(),
  resource_id: uuid,
  version_id: uuid,
  raw_temporary_ref: z.string(),
  raw_storage_ref: z.string().nullable(),
  raw_media_type: z
    .enum(['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown'])
    .nullable(),
  parsed_temporary_ref: z.string(),
});

export function createResourceUrlIngestionWorkerRepository(options: {
  connectionString: string;
  workerId?: string;
}) {
  const pool = new Pool({ connectionString: options.connectionString, max: 2 });
  const workerId = uuid.parse(options.workerId ?? randomUUID());
  const booleanCall = async (sql: string, values: unknown[], column: string) =>
    (await pool.query(sql, values)).rows[0]?.[column] === true;
  return {
    async lease(durationSeconds = 60): Promise<ResourceUrlIngestionLease | null> {
      const duration = z.number().int().min(1).max(300).parse(durationSeconds);
      const result = await pool.query('SELECT * FROM public.lease_resource_url_ingestion($1,$2)', [
        workerId,
        `${duration} seconds`,
      ]);
      if (!result.rows[0]) return null;
      const row = leaseSchema.parse(result.rows[0]);
      return {
        athleteId: row.athlete_id,
        requestId: row.request_id,
        attemptNo: row.attempt_no,
        phase: row.phase,
        leaseToken: row.lease_token,
        requestedUrl: row.requested_url,
        displayUrl: row.display_url,
        resourceId: row.resource_id,
        versionId: row.version_id,
        rawTemporaryRef: row.raw_temporary_ref,
        rawStorageRef: row.raw_storage_ref,
        rawMediaType: row.raw_media_type,
        parsedTemporaryRef: row.parsed_temporary_ref,
      };
    },
    recordHop(
      lease: ResourceUrlIngestionLease,
      input: {
        index: number;
        displayUrl: string;
        urlDigest: string;
        responseStatus?: number;
        resolvedAddresses: string[];
        policyVersion: string;
      },
    ) {
      return booleanCall(
        'SELECT public.record_resource_url_hop($1,$2,$3,$4,$5,$6,$7::inet[],$8) AS recorded',
        [
          lease.requestId,
          lease.leaseToken,
          z.number().int().min(0).max(5).parse(input.index),
          z.string().min(1).max(2048).parse(input.displayUrl),
          z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(input.urlDigest),
          input.responseStatus ?? null,
          z.array(z.ipv4().or(z.ipv6())).min(1).max(8).parse(input.resolvedAddresses),
          z.string().min(1).max(100).parse(input.policyVersion),
        ],
        'recorded',
      );
    },
    prepareRaw(
      lease: ResourceUrlIngestionLease,
      input: { storageRef: string; sha256: string; sizeBytes: number; mediaType: string },
    ) {
      return booleanCall(
        'SELECT public.prepare_resource_url_raw($1,$2,$3,$4,$5,$6) AS prepared',
        [
          lease.requestId,
          lease.leaseToken,
          input.storageRef,
          input.sha256,
          input.sizeBytes,
          input.mediaType,
        ],
        'prepared',
      );
    },
    markRawPublished(lease: ResourceUrlIngestionLease) {
      return booleanCall(
        'SELECT public.mark_resource_url_raw_published($1,$2) AS published',
        [lease.requestId, lease.leaseToken],
        'published',
      );
    },
    prepareParsed(
      lease: ResourceUrlIngestionLease,
      input: {
        storageRef: string;
        sha256: string;
        sizeBytes: number;
        text: string;
        fragments: ResourceUrlFragment[];
        parserName: string;
        parserVersion: string;
      },
    ) {
      const fragments = z
        .array(
          z.strictObject({
            ordinal: z.number().int().min(0).max(999),
            kind: z.enum(['html_block', 'markdown_paragraph', 'plain_paragraph']),
            headingPath: z.array(z.string().trim().min(1).max(200)).max(8),
            paragraphIndex: z.number().int().min(0).max(999).optional(),
            text: z.string().min(1).max(8192),
            startOffset: z.number().int().min(0).max(65535),
            endOffset: z.number().int().min(1).max(65536),
            pageNumber: z.number().int().min(1).max(10000).optional(),
          }),
        )
        .min(1)
        .max(1000)
        .superRefine((items, context) => {
          items.forEach((item, index) => {
            if (item.ordinal !== index)
              context.addIssue({ code: 'custom', path: [index, 'ordinal'], message: 'ordinal' });
            if (item.kind === 'html_block' && item.paragraphIndex !== undefined)
              context.addIssue({
                code: 'custom',
                path: [index, 'paragraphIndex'],
                message: 'kind',
              });
            if (item.kind !== 'html_block' && item.paragraphIndex === undefined)
              context.addIssue({
                code: 'custom',
                path: [index, 'paragraphIndex'],
                message: 'kind',
              });
            if (item.kind === 'plain_paragraph' && item.headingPath.length !== 0)
              context.addIssue({ code: 'custom', path: [index, 'headingPath'], message: 'kind' });
          });
        })
        .parse(input.fragments);
      return booleanCall(
        'SELECT public.prepare_resource_url_parsed($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) AS prepared',
        [
          lease.requestId,
          lease.leaseToken,
          input.storageRef,
          input.sha256,
          input.sizeBytes,
          z.string().min(1).max(65536).parse(input.text),
          JSON.stringify(fragments),
          input.parserName,
          input.parserVersion,
        ],
        'prepared',
      );
    },
    markParsedPublished(lease: ResourceUrlIngestionLease) {
      return booleanCall(
        'SELECT public.mark_resource_url_parsed_published($1,$2) AS published',
        [lease.requestId, lease.leaseToken],
        'published',
      );
    },
    abandonPublishedObject(lease: ResourceUrlIngestionLease, storageRef: string) {
      return booleanCall(
        'SELECT public.enqueue_abandoned_resource_url_object($1,$2,$3,$4) AS queued',
        [
          z.string().min(1).max(200).parse(lease.athleteId),
          lease.requestId,
          lease.resourceId,
          z.string().min(1).max(1024).parse(storageRef),
        ],
        'queued',
      );
    },
    async finalize(lease: ResourceUrlIngestionLease) {
      const result = await pool.query(
        'SELECT * FROM public.finalize_resource_url_ingestion($1,$2)',
        [lease.requestId, lease.leaseToken],
      );
      if (!result.rows[0]) return null;
      return z.object({ resource_id: uuid, version_id: uuid }).parse(result.rows[0]);
    },
    fail(
      lease: ResourceUrlIngestionLease,
      code: string,
      options: { retryable?: boolean; retryAfterSeconds?: number } = {},
    ) {
      const retryable = options.retryable ?? false;
      const retryAfterSeconds = z
        .number()
        .int()
        .min(0)
        .max(86400)
        .parse(options.retryAfterSeconds ?? 0);
      return booleanCall(
        'SELECT public.fail_resource_url_ingestion($1,$2,$3,$4,$5) AS failed',
        [
          lease.requestId,
          lease.leaseToken,
          z
            .string()
            .regex(/^[A-Z0-9_:-]+$/)
            .max(100)
            .parse(code),
          retryable,
          `${retryAfterSeconds} seconds`,
        ],
        'failed',
      );
    },
    bookmarkOnly(lease: ResourceUrlIngestionLease, parser: { name: string; version: string }) {
      return booleanCall(
        'SELECT public.mark_resource_url_bookmark_only($1,$2,$3,$4) AS marked',
        [
          lease.requestId,
          lease.leaseToken,
          z.string().trim().min(1).max(100).parse(parser.name),
          z.string().trim().min(1).max(100).parse(parser.version),
        ],
        'marked',
      );
    },
    async reap(limit = 100) {
      const result = await pool.query(
        'SELECT public.reap_resource_url_ingestions($1) AS affected',
        [z.number().int().min(1).max(100).parse(limit)],
      );
      return z.coerce.number().int().parse(result.rows[0]?.['affected']);
    },
    close: () => pool.end(),
  };
}

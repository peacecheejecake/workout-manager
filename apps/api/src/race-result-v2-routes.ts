import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  RACE_RESULT_V2_MAX_BYTES,
  raceResultValuesV2Schema,
  raceResultCreateV2CommandSchema,
  raceResultUpdateV2CommandSchema,
  raceResultReadV2CommandSchema,
  raceResultListV2QuerySchema,
  raceResultCompatibleReadSchema,
  raceResultMixedListV2PageSchema,
  raceResultV2CommandResultSchema,
} from '@workout/contracts/race-result-v2';
import { raceResultUpdateCommandSchema } from '@workout/contracts/race-commands';
import {
  RaceResultV2Error,
  type RaceResultV2Repository,
} from '@workout/server-persistence/race-result-v2';
import { RaceResultProofError } from '@workout/server-persistence/race-result-proofs';
import { RaceRepositoryError } from '@workout/server-persistence/races';
import type { Principal } from './ports.js';
import { command, input, ProductRequestError } from './product-boundary.js';

const key = raceResultUpdateCommandSchema.shape.idempotencyKey;
const body = z.strictObject({
  schemaVersion: z.literal(2),
  values: raceResultValuesV2Schema,
  idempotencyKey: key.optional(),
});
const updateBody = body.extend({
  expectedRevision: raceResultUpdateCommandSchema.shape.expectedRevision,
});
const wireQuery = z.strictObject({
  schemaVersion: z.literal('2'),
  limit: z
    .string()
    .max(3)
    .regex(/^[1-9][0-9]*$/)
    .optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
const readQuery = z.strictObject({ schemaVersion: z.literal('2') });
function query(raw: unknown) {
  const wire = input(wireQuery, raw);
  let cursor: unknown = null;
  if (wire.cursor !== undefined) {
    try {
      cursor = JSON.parse(wire.cursor);
    } catch {
      throw new ProductRequestError(400, 'INVALID_REQUEST');
    }
  }
  return input(raceResultListV2QuerySchema, {
    schemaVersion: 2,
    ...(wire.limit === undefined ? {} : { limit: Number(wire.limit) }),
    cursor,
  });
}
function headerKey(request: FastifyRequest, supplied: string | undefined) {
  const header = input(key, request.headers['idempotency-key']);
  if (supplied !== undefined && supplied !== header)
    throw new ProductRequestError(400, 'INVALID_REQUEST');
  return header;
}
function translate(error: unknown): ProductRequestError | undefined {
  if (error instanceof RaceRepositoryError) {
    switch (error.code) {
      case 'RACE_NOT_FOUND':
      case 'RACE_REFERENCE_UNAVAILABLE':
      case 'RACE_CURSOR_UNAVAILABLE':
        return new ProductRequestError(404, error.code);
      case 'RACE_CURSOR_KIND_MISMATCH':
      case 'RACE_CURSOR_STALE':
      case 'RACE_PLAN_IMPACT_REQUIRED':
      case 'RACE_REVISION_LIMIT':
        return new ProductRequestError(409, error.code);
    }
  }
  if (error instanceof RaceResultProofError) {
    switch (error.code) {
      case 'INVALID_PROOFS':
        return new ProductRequestError(400, error.code);
      case 'PROOF_UNAVAILABLE':
        return new ProductRequestError(404, error.code);
      case 'STALE_PROOF_ACCESS':
        return new ProductRequestError(409, error.code);
      case 'INVALID_PROOF_SOURCE':
        return undefined;
    }
  }
  if (error instanceof RaceResultV2Error && error.code === 'RACE_RESULT_READ_LIMIT')
    return new ProductRequestError(413, error.code);
  return undefined;
}
/** Explicit preparation plugin. Register only inside the existing authenticated,
 * session-fresh/CSRF product boundary. This does not activate configured routes,
 * establish attachment truth, or grant official verification/PB authority. */
export function registerRaceResultV2Routes(
  routes: FastifyInstance,
  repo: RaceResultV2Repository,
  principal: (request: FastifyRequest) => Principal,
): void {
  routes.register(async (api) => {
    api.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'private, no-store');
    });
    api.get('/race-results/v2', async (request) => {
      const athlete = principal(request).athleteId;
      const parsed = query(request.query);
      return raceResultMixedListV2PageSchema.parse(
        await command(() => repo.list(athlete, parsed), translate),
      );
    });
    api.get('/race-results/v2/:id', async (request) => {
      const athlete = principal(request).athleteId;
      input(readQuery, request.query);
      const parsed = input(raceResultReadV2CommandSchema, {
        ...input(
          z.strictObject({ id: z.uuid().transform((value) => value.toLowerCase()) }),
          request.params,
        ),
        schemaVersion: 2,
      });
      const saved = await command(() => repo.read(athlete, parsed), translate);
      if (saved === null) throw new ProductRequestError(404, 'RACE_NOT_FOUND');
      const result = raceResultCompatibleReadSchema.parse(saved);
      z.literal(parsed.id).parse(result.id);
      return result;
    });
    api.post(
      '/race-results/v2',
      { bodyLimit: RACE_RESULT_V2_MAX_BYTES },
      async (request, reply) => {
        const athlete = principal(request).athleteId;
        input(z.strictObject({}), request.query);
        const parsed = input(body, request.body);
        const intent = input(raceResultCreateV2CommandSchema, {
          ...parsed,
          idempotencyKey: headerKey(request, parsed.idempotencyKey),
        });
        return reply
          .code(201)
          .send(
            raceResultV2CommandResultSchema.parse(
              await command(() => repo.create(athlete, intent), translate),
            ),
          );
      },
    );
    api.patch('/race-results/v2/:id', { bodyLimit: RACE_RESULT_V2_MAX_BYTES }, async (request) => {
      const athlete = principal(request).athleteId;
      input(z.strictObject({}), request.query);
      const { id } = input(
        z.strictObject({ id: z.uuid().transform((value) => value.toLowerCase()) }),
        request.params,
      );
      const parsed = input(updateBody, request.body);
      const intent = input(raceResultUpdateV2CommandSchema, {
        ...parsed,
        idempotencyKey: headerKey(request, parsed.idempotencyKey),
      });
      const result = raceResultV2CommandResultSchema.parse(
        await command(() => repo.update(athlete, id, intent), translate),
      );
      z.literal(id).parse(result.id);
      return result;
    });
  });
}

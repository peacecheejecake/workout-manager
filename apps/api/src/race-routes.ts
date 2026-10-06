import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  raceCommandResultSchema,
  raceEventCreateCommandSchema,
  raceEventUpdateCommandSchema,
  raceResultCreateCommandSchema,
  raceResultUpdateCommandSchema,
  trainingBestCreateCommandSchema,
  trainingBestUpdateCommandSchema,
  type RaceCommandResult,
} from '@workout/contracts/race-commands';
import {
  raceListQuerySchema,
  raceEventListPageSchema,
  raceResultListPageSchema,
  trainingBestListPageSchema,
  type RaceListQuery,
} from '@workout/contracts/race-queries';
import { raceEventSchema, raceResultSchema, trainingBestSchema } from '@workout/contracts/races';
import { RaceRepositoryError, type RaceRepository } from '@workout/server-persistence/races';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const paramsSchema = z.strictObject({ id: z.uuid().transform((value) => value.toLowerCase()) });
const wireListQuerySchema = z.strictObject({
  limit: z
    .string()
    .max(3)
    .regex(/^[1-9][0-9]*$/)
    .optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
function listQuery(value: unknown): RaceListQuery {
  const wire = input(wireListQuerySchema, value);
  let cursor: unknown = null;
  if (wire.cursor !== undefined) {
    try {
      cursor = JSON.parse(wire.cursor);
    } catch {
      throw new ProductRequestError(400, 'INVALID_REQUEST');
    }
  }
  return input(raceListQuerySchema, {
    ...(wire.limit === undefined ? {} : { limit: Number(wire.limit) }),
    cursor,
  });
}
function raceError(error: unknown): ProductRequestError | undefined {
  if (!(error instanceof RaceRepositoryError)) return undefined;
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
function execute<T>(operation: () => Promise<T>) {
  return command(operation, raceError);
}

/** Register beneath the existing authenticated product plugin. Authentication, cookie
 * CSRF and session freshness run before these handlers; ownership only comes from principal.
 * Saving an event does not approve Plan changes, verify an official result, or rank PBs.
 */
export function registerRaceRoutes(
  routes: FastifyInstance,
  races: RaceRepository,
  principal: (request: FastifyRequest) => Principal,
): void {
  routes.register(async (raceRoutes) => {
    raceRoutes.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'private, no-store');
    });
    function family<
      C extends { idempotencyKey: string },
      U extends { idempotencyKey: string },
      R extends { id: string },
      P,
    >(config: {
      path: string;
      createSchema: z.ZodType<C>;
      createBody: z.ZodType<Omit<C, 'idempotencyKey'>>;
      updateSchema: z.ZodType<U>;
      updateBody: z.ZodType<Omit<U, 'idempotencyKey'>>;
      readSchema: z.ZodType<R>;
      pageSchema: z.ZodType<P>;
      create: (athleteId: string, payload: C) => Promise<RaceCommandResult>;
      update: (athleteId: string, id: string, payload: U) => Promise<RaceCommandResult>;
      get: (athleteId: string, id: string) => Promise<R | null>;
      list: (athleteId: string, query: RaceListQuery) => Promise<P>;
    }) {
      raceRoutes.get(config.path, async (request) => {
        const athleteId = principal(request).athleteId;
        // A JSON cursor describes a position. The repository checks collection freshness
        // and live membership under this authenticated tenant; its shape grants no access.
        const query = listQuery(request.query);
        return config.pageSchema.parse(await execute(() => config.list(athleteId, query)));
      });
      raceRoutes.get(`${config.path}/:id`, async (request) => {
        const athleteId = principal(request).athleteId;
        input(emptyQuery, request.query);
        const { id } = input(paramsSchema, request.params);
        const stored = await execute(() => config.get(athleteId, id));
        if (stored === null) throw new ProductRequestError(404, 'RACE_NOT_FOUND');
        const result = config.readSchema.parse(stored);
        z.literal(id).parse(result.id);
        return result;
      });
      raceRoutes.post(config.path, { bodyLimit: 16 * 1024 }, async (request, reply) => {
        const athleteId = principal(request).athleteId;
        input(emptyQuery, request.query);
        const body = input(config.createBody, request.body);
        const payload = input(config.createSchema, {
          ...body,
          idempotencyKey: request.headers['idempotency-key'],
        });
        const result = raceCommandResultSchema.parse(
          await execute(() => config.create(athleteId, payload)),
        );
        return reply.code(201).send(result);
      });
      raceRoutes.patch(`${config.path}/:id`, { bodyLimit: 16 * 1024 }, async (request) => {
        const athleteId = principal(request).athleteId;
        input(emptyQuery, request.query);
        const { id } = input(paramsSchema, request.params);
        const body = input(config.updateBody, request.body);
        const payload = input(config.updateSchema, {
          ...body,
          idempotencyKey: request.headers['idempotency-key'],
        });
        const result = raceCommandResultSchema.parse(
          await execute(() => config.update(athleteId, id, payload)),
        );
        z.literal(id).parse(result.id);
        return result;
      });
    }
    family({
      path: '/races',
      createSchema: raceEventCreateCommandSchema,
      createBody: raceEventCreateCommandSchema.omit({ idempotencyKey: true }),
      updateSchema: raceEventUpdateCommandSchema,
      updateBody: raceEventUpdateCommandSchema.omit({ idempotencyKey: true }),
      readSchema: raceEventSchema,
      pageSchema: raceEventListPageSchema,
      create: (athlete, payload) => races.createRaceEvent(athlete, payload),
      update: (athlete, id, payload) => races.updateRaceEvent(athlete, id, payload),
      get: (athlete, id) => races.getRaceEvent(athlete, id),
      list: (athlete, query) => races.listRaceEvents(athlete, query),
    });
    family({
      path: '/race-results',
      createSchema: raceResultCreateCommandSchema,
      createBody: raceResultCreateCommandSchema.omit({ idempotencyKey: true }),
      updateSchema: raceResultUpdateCommandSchema,
      updateBody: raceResultUpdateCommandSchema.omit({ idempotencyKey: true }),
      readSchema: raceResultSchema,
      pageSchema: raceResultListPageSchema,
      create: (athlete, payload) => races.createRaceResult(athlete, payload),
      update: (athlete, id, payload) => races.updateRaceResult(athlete, id, payload),
      get: (athlete, id) => races.getRaceResult(athlete, id),
      list: (athlete, query) => races.listRaceResults(athlete, query),
    });
    family({
      path: '/training-bests',
      createSchema: trainingBestCreateCommandSchema,
      createBody: trainingBestCreateCommandSchema.omit({ idempotencyKey: true }),
      updateSchema: trainingBestUpdateCommandSchema,
      updateBody: trainingBestUpdateCommandSchema.omit({ idempotencyKey: true }),
      readSchema: trainingBestSchema,
      pageSchema: trainingBestListPageSchema,
      create: (athlete, payload) => races.createTrainingBest(athlete, payload),
      update: (athlete, id, payload) => races.updateTrainingBest(athlete, id, payload),
      get: (athlete, id) => races.getTrainingBest(athlete, id),
      list: (athlete, query) => races.listTrainingBests(athlete, query),
    });
  });
}

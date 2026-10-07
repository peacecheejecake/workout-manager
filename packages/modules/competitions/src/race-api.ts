import { z } from 'zod';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import {
  raceEventCreateCommandSchema,
  raceEventUpdateCommandSchema,
  raceEventDeleteCommandSchema,
  raceResultCreateCommandSchema,
  raceResultUpdateCommandSchema,
  raceResultDeleteCommandSchema,
  trainingBestCreateCommandSchema,
  trainingBestUpdateCommandSchema,
  trainingBestDeleteCommandSchema,
  raceCommandResultSchema,
} from '@workout/contracts/race-commands';
import { raceEventSchema, raceResultSchema, trainingBestSchema } from '@workout/contracts/races';
import {
  raceListQuerySchema,
  raceEventListPageSchema,
  raceResultListPageSchema,
  trainingBestListPageSchema,
  type RaceListQueryInput,
} from '@workout/contracts/race-queries';

import {
  RACE_RESULT_V2_MAX_BYTES,
  raceResultCompatibleReadSchema,
  raceResultMixedListV2PageSchema,
  raceResultReadV2CommandSchema,
  raceResultListV2QuerySchema,
  raceResultCreateV2CommandSchema,
  raceResultUpdateV2CommandSchema,
  raceResultV2CommandResultSchema,
} from '@workout/contracts/race-result-v2';

const errorSchema = z.object({
  error: z.object({
    code: z
      .string()
      .max(64)
      .regex(/^[A-Z][A-Z0-9_]*$/),
  }),
});
export class RaceRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'RaceRequestError';
  }
}

/** All inputs and successful DTOs are parsed. Athlete identity never travels in commands. */
export function createRaceApi(transport: AuthenticatedTransport) {
  async function request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    schema: z.ZodType<T>,
    body: unknown = null,
    idempotencyKey: string | null = null,
    signal?: AbortSignal,
    maximumReplyBytes?: number,
    enforceCancellation = false,
  ) {
    if (enforceCancellation) signal?.throwIfAborted();
    const reply = transportReplySchema.parse(
      await transport.request({
        path,
        method,
        body: body === null ? null : z.json().parse(body),
        idempotencyKey,
        ...(signal ? { signal } : {}),
      }),
    );
    if (enforceCancellation) signal?.throwIfAborted();
    if (reply.status < 200 || reply.status >= 300) {
      const error = errorSchema.safeParse(reply.body);
      throw new RaceRequestError(
        reply.status,
        error.success ? error.data.error.code : 'REQUEST_FAILED',
      );
    }
    if (maximumReplyBytes !== undefined) {
      // Bound the original reply before normalization. A V1 read may include its
      // finite relational identity overhead in addition to the stored 16KiB body.
      z.unknown()
        .superRefine((value, context) => {
          try {
            const json = JSON.stringify(value);
            if (json === undefined || new TextEncoder().encode(json).byteLength > maximumReplyBytes)
              context.addIssue({
                code: 'custom',
                message: 'Race result response exceeds its bound',
              });
          } catch {
            context.addIssue({ code: 'custom', message: 'Race result response must be JSON' });
          }
        })
        .parse(reply.body);
    }
    return schema.parse(reply.body);
  }
  function family<
    R extends { id: string },
    P,
    C extends { idempotencyKey: string },
    U extends { idempotencyKey: string },
    D extends { idempotencyKey: string },
  >(
    path: string,
    read: z.ZodType<R>,
    page: z.ZodType<P>,
    create: z.ZodType<C>,
    update: z.ZodType<U>,
    remove: z.ZodType<D>,
  ) {
    function command<T extends { idempotencyKey: string }>(
      method: 'POST' | 'PATCH' | 'DELETE',
      suffix: string,
      schema: z.ZodType<T>,
      input: T,
      signal?: AbortSignal,
    ) {
      const { idempotencyKey, ...body } = schema.parse(input);
      return request(path + suffix, method, raceCommandResultSchema, body, idempotencyKey, signal);
    }
    const suffix = (id: string) => `/${encodeURIComponent(z.uuid().parse(id))}`;
    return {
      list(input: RaceListQueryInput = {}, signal?: AbortSignal) {
        const query = raceListQuerySchema.parse(input);
        const search = new URLSearchParams({ limit: String(query.limit) });
        if (query.cursor !== null) search.set('cursor', JSON.stringify(query.cursor));
        return request(`${path}?${search}`, 'GET', page, null, null, signal);
      },
      read(id: string, signal?: AbortSignal) {
        return request(path + suffix(id), 'GET', read, null, null, signal).then((record) => {
          z.literal(id.toLowerCase()).parse(record.id);
          return record;
        });
      },
      create(input: C, signal?: AbortSignal) {
        return command('POST', '', create, input, signal);
      },
      update(id: string, input: U, signal?: AbortSignal) {
        return command('PATCH', suffix(id), update, input, signal).then((result) => {
          z.literal(id.toLowerCase()).parse(result.id);
          return result;
        });
      },
      delete(id: string, input: D, signal?: AbortSignal) {
        return command('DELETE', suffix(id), remove, input, signal).then((result) => {
          z.literal(id.toLowerCase()).parse(result.id);
          return result;
        });
      },
    };
  }
  const resultV2Path = '/bff/v1/race-results/v2';
  const resultsV2 = {
    list(input: z.input<typeof raceResultListV2QuerySchema>, signal?: AbortSignal) {
      const query = raceResultListV2QuerySchema.parse(input);
      const search = new URLSearchParams({ schemaVersion: '2', limit: String(query.limit) });
      if (query.cursor !== null) search.set('cursor', JSON.stringify(query.cursor));
      return request(
        `${resultV2Path}?${search}`,
        'GET',
        raceResultMixedListV2PageSchema,
        null,
        null,
        signal,
        undefined,
        true,
      );
    },
    read(input: z.input<typeof raceResultReadV2CommandSchema>, signal?: AbortSignal) {
      const command = raceResultReadV2CommandSchema.parse(input);
      return request(
        `${resultV2Path}/${encodeURIComponent(command.id)}?schemaVersion=2`,
        'GET',
        raceResultCompatibleReadSchema,
        null,
        null,
        signal,
        RACE_RESULT_V2_MAX_BYTES + 256,
        true,
      ).then((record) => {
        z.literal(command.id).parse(record.id);
        return record;
      });
    },
    create(input: z.input<typeof raceResultCreateV2CommandSchema>, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = raceResultCreateV2CommandSchema.parse(input);
      return request(
        resultV2Path,
        'POST',
        raceResultV2CommandResultSchema,
        body,
        idempotencyKey,
        signal,
        undefined,
        true,
      );
    },
    update(
      id: string,
      input: z.input<typeof raceResultUpdateV2CommandSchema>,
      signal?: AbortSignal,
    ) {
      const command = raceResultReadV2CommandSchema.parse({ schemaVersion: 2, id });
      const { idempotencyKey, ...body } = raceResultUpdateV2CommandSchema.parse(input);
      return request(
        `${resultV2Path}/${encodeURIComponent(command.id)}`,
        'PATCH',
        raceResultV2CommandResultSchema,
        body,
        idempotencyKey,
        signal,
        undefined,
        true,
      ).then((result) => {
        z.literal(command.id).parse(result.id);
        return result;
      });
    },
  };
  return {
    resultsV2,
    events: family(
      '/bff/v1/races',
      raceEventSchema,
      raceEventListPageSchema,
      raceEventCreateCommandSchema,
      raceEventUpdateCommandSchema,
      raceEventDeleteCommandSchema,
    ),
    results: family(
      '/bff/v1/race-results',
      raceResultSchema,
      raceResultListPageSchema,
      raceResultCreateCommandSchema,
      raceResultUpdateCommandSchema,
      raceResultDeleteCommandSchema,
    ),
    trainingBests: family(
      '/bff/v1/training-bests',
      trainingBestSchema,
      trainingBestListPageSchema,
      trainingBestCreateCommandSchema,
      trainingBestUpdateCommandSchema,
      trainingBestDeleteCommandSchema,
    ),
  };
}
export type RaceApi = ReturnType<typeof createRaceApi>;

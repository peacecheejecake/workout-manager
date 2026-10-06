import { z } from 'zod';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import { raceEventSchema, raceResultSchema, trainingBestSchema } from '@workout/contracts/races';
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
} from '@workout/contracts/race-commands';
import {
  raceListQuerySchema,
  raceEventListPageSchema,
  raceResultListPageSchema,
  trainingBestListPageSchema,
} from '@workout/contracts/race-queries';
import type { CompetitionRelations } from '@workout/modules-competitions/competition-workspace';

export type FixtureMode =
  | 'normal'
  | 'offline'
  | 'revision-conflict'
  | 'plan-impact'
  | 'consent-required'
  | 'unavailable'
  | 'cursor-stale'
  | 'hold-writes'
  | 'hold-reads';
export type FixtureAccount = 'synthetic-a' | 'synthetic-b';
const eventId = '10000000-0000-4000-8000-000000000001';
const activityId = '20000000-0000-4000-8000-000000000002';
const course = {
  courseId: '30000000-0000-4000-8000-000000000003',
  courseRevision: 2,
  revisionId: '40000000-0000-4000-8000-000000000004',
};
export const fixtureRelations: CompetitionRelations = {
  plans: [{ id: 'synthetic-plan-v1', label: '합성 10월 훈련 계획 · 승인 버전 1' }],
  courses: [{ ref: course, label: '합성 강변 코스 · 고정 버전 2' }],
  activities: [{ id: activityId, label: '합성 10월 10일 아침 달리기' }],
};
const event = raceEventSchema.parse({
  id: eventId,
  revision: 1,
  title: '합성 가을 10km 대회',
  localDate: '2026-10-10',
  localStartTime: '08:00:00',
  timezone: 'Asia/Seoul',
  locationName: '합성 출발점',
  distance: { kind: 'standard', class: '10k' },
  priority: 'A',
  participation: 'registered',
  officialUrl: 'https://example.invalid/race',
  course,
  targetSeconds: 3600,
  planVersionId: 'synthetic-plan-v1',
});
const result = raceResultSchema.parse({
  kind: 'race-result',
  id: '50000000-0000-4000-8000-000000000005',
  revision: 1,
  raceEventId: eventId,
  localDate: '2026-10-10',
  timezone: 'Asia/Seoul',
  source: {
    kind: 'official',
    authority: '합성 주최자',
    resultUrl: 'https://example.invalid/result',
    verifiedAt: null,
  },
  chipSeconds: 0,
  gunSeconds: null,
  officialDistanceMeters: 10000,
  deviceDistanceMeters: 10120,
  linkedActivityId: activityId,
  weatherNote: '합성 날씨 메모',
});
const best = trainingBestSchema.parse({
  kind: 'training-best',
  id: '60000000-0000-4000-8000-000000000006',
  revision: 1,
  observedAt: '2026-10-10T00:00:00.000Z',
  source: { kind: 'activity', activityId },
  basis: 'device-estimated-split',
  distanceMeters: 10000,
  elapsedSeconds: 3600,
});
function family<R extends { id: string; revision: number }, V extends object>(
  kind: 'race-event' | 'race-result' | 'training-best',
  read: z.ZodType<R>,
  page: z.ZodType,
  create: z.ZodType<{ values: V; idempotencyKey: string }>,
  update: z.ZodType<{ values: V; expectedRevision: number; idempotencyKey: string }>,
  remove: z.ZodType<{ expectedRevision: number; idempotencyKey: string }>,
  initial: readonly R[],
  normalize: (values: V) => object = (values) => values,
) {
  const records = new Map(initial.map((record) => [record.id, record]));
  const receipts = new Map<
    string,
    { fingerprint: string; result: { id: string; revision: number } }
  >();
  let collectionRevision = initial.length ? 1 : 0;
  function handle(request: TransportRequest, url: URL, id: string | undefined) {
    if (request.method === 'GET') {
      if (id) {
        const found = records.get(id);
        return found ? { status: 200, body: read.parse(found) } : failure(404, 'RACE_NOT_FOUND');
      }
      const query = raceListQuerySchema.parse({
        limit: Number(url.searchParams.get('limit') ?? 50),
        cursor: url.searchParams.has('cursor')
          ? JSON.parse(url.searchParams.get('cursor') ?? 'null')
          : null,
      });
      if (
        query.cursor &&
        (query.cursor.kind !== kind || query.cursor.collection.revision !== collectionRevision)
      )
        return failure(409, 'RACE_CURSOR_STALE');
      const after = query.cursor?.afterId ?? '';
      const candidates = [...records.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((record) => record.id > after);
      const items = candidates.slice(0, query.limit);
      const last = items.at(-1);
      const collection = collectionRevision
        ? { revision: collectionRevision, privacyGeneration: '0' }
        : null;
      return {
        status: 200,
        body: page.parse({
          schemaVersion: 1,
          kind,
          sort: 'id-asc',
          collection,
          items,
          nextCursor:
            candidates.length > items.length && last
              ? { kind, collection, afterId: last.id }
              : null,
        }),
      };
    }
    const payload = {
      ...z.record(z.string(), z.unknown()).parse(request.body),
      idempotencyKey: request.idempotencyKey,
    };
    const parsed =
      request.method === 'POST'
        ? create.parse(payload)
        : request.method === 'PATCH'
          ? update.parse(payload)
          : remove.parse(payload);
    const fingerprint = JSON.stringify([request.method, id ?? null, parsed]);
    const replay = receipts.get(parsed.idempotencyKey);
    if (replay)
      return replay.fingerprint === fingerprint
        ? { status: request.method === 'POST' ? 201 : 200, body: replay.result }
        : failure(409, 'IDEMPOTENCY_CONFLICT');
    const previous = id ? records.get(id) : undefined;
    if (request.method !== 'POST') {
      if (!previous) return failure(404, 'RACE_NOT_FOUND');
      if (!('expectedRevision' in parsed) || parsed.expectedRevision !== previous.revision)
        return failure(409, 'REVISION_CONFLICT');
    }
    const allocated = id ?? crypto.randomUUID();
    const revision = (previous?.revision ?? 0) + 1;
    if (request.method === 'DELETE') records.delete(allocated);
    else if ('values' in parsed)
      records.set(allocated, read.parse({ ...normalize(parsed.values), id: allocated, revision }));
    collectionRevision += 1;
    const result = { id: allocated, revision };
    receipts.set(parsed.idempotencyKey, { fingerprint, result });
    return { status: request.method === 'POST' ? 201 : 200, body: result };
  }
  return {
    handle,
    addRows(example: R) {
      for (let index = 1; index <= 51; index++) {
        const id = `71000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
        records.set(id, read.parse({ ...example, id, revision: 1 }));
      }
      collectionRevision += 1;
    },
    bump() {
      for (const [id, record] of records) {
        records.set(id, read.parse({ ...record, revision: record.revision + 1 }));
        collectionRevision += 1;
        break;
      }
    },
    clear() {
      records.clear();
      receipts.clear();
      collectionRevision += 1;
    },
  };
}
function failure(status: number, code: string) {
  return { status, body: { error: { code } } };
}
function account(seed: boolean) {
  return {
    races: family(
      'race-event',
      raceEventSchema,
      raceEventListPageSchema,
      raceEventCreateCommandSchema,
      raceEventUpdateCommandSchema,
      raceEventDeleteCommandSchema,
      seed ? [event] : [],
    ),
    'race-results': family(
      'race-result',
      raceResultSchema,
      raceResultListPageSchema,
      raceResultCreateCommandSchema,
      raceResultUpdateCommandSchema,
      raceResultDeleteCommandSchema,
      seed ? [result] : [],
      (values) => ({
        ...values,
        source:
          values.source.kind === 'official'
            ? { ...values.source, verifiedAt: null }
            : values.source,
      }),
    ),
    'training-bests': family(
      'training-best',
      trainingBestSchema,
      trainingBestListPageSchema,
      trainingBestCreateCommandSchema,
      trainingBestUpdateCommandSchema,
      trainingBestDeleteCommandSchema,
      seed ? [best] : [],
    ),
  };
}
/** Browser demonstration only: no persistence, authentication service, network or DB proof. */
export function createSyntheticFixture(onPendingChange: (pending: number) => void) {
  const accounts = { 'synthetic-a': account(true), 'synthetic-b': account(false) };
  let mode: FixtureMode = 'normal';
  const pending: (() => void)[] = [];
  return {
    setMode(next: FixtureMode) {
      mode = next;
    },
    release() {
      for (const finish of pending.splice(0)) finish();
      onPendingChange(0);
    },
    bump(who: FixtureAccount) {
      for (const family of Object.values(accounts[who])) family.bump();
    },
    addPage(who: FixtureAccount) {
      accounts[who].races.addRows(event);
    },
    clear(who: FixtureAccount) {
      for (const family of Object.values(accounts[who])) family.clear();
    },
    transport(who: FixtureAccount): AuthenticatedTransport {
      return {
        request: async (request) => {
          const captured = mode;
          const url = new URL(request.path, 'http://synthetic.invalid');
          const path = url.pathname.match(
            /^\/bff\/v1\/(races|race-results|training-bests)(?:\/([^/]+))?$/,
          );
          if (!path)
            return transportReplySchema.parse({
              ...failure(404, 'INVALID_REQUEST'),
              traceId: null,
            });
          if (
            (captured === 'hold-writes' && request.method !== 'GET') ||
            (captured === 'hold-reads' && request.method === 'GET')
          )
            await new Promise<void>((resolve) => {
              pending.push(resolve);
              onPendingChange(pending.length);
            });
          // Deliberately ignore AbortSignal in hold mode to exercise module late-result isolation.
          if (captured === 'offline') throw new Error('SYNTHETIC_OFFLINE');
          let reply;
          if (captured === 'unavailable' && request.method === 'GET')
            reply = failure(503, 'UNAVAILABLE');
          else if (captured === 'cursor-stale' && url.searchParams.has('cursor'))
            reply = failure(409, 'RACE_CURSOR_STALE');
          else if (request.method !== 'GET' && captured === 'revision-conflict')
            reply = failure(409, 'REVISION_CONFLICT');
          else if (request.method !== 'GET' && captured === 'plan-impact')
            reply = failure(409, 'RACE_PLAN_IMPACT_REQUIRED');
          else if (
            request.method !== 'GET' &&
            request.method !== 'DELETE' &&
            captured === 'consent-required'
          )
            reply = failure(403, 'APP_CONSENT_REQUIRED');
          else {
            const key = path[1];
            const id = path[2];
            if (key === 'races') reply = accounts[who].races.handle(request, url, id);
            else if (key === 'race-results')
              reply = accounts[who]['race-results'].handle(request, url, id);
            else reply = accounts[who]['training-bests'].handle(request, url, id);
          }
          return transportReplySchema.parse({ ...reply, traceId: null });
        },
      };
    },
  };
}

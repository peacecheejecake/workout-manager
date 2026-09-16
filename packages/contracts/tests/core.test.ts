import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  idSchema,
  localDateSchema,
  instantSchema,
  timeZoneSchema,
  localTimeSchema,
  revisionSchema,
} from '../src/primitives.js';
import {
  apiPathSchema,
  bridgeRequestSchema,
  bridgeReplySchema,
  planPeriodSchema,
  planningLensSchema,
  dayProjectionSchema,
  plannerEventSchema,
  workspaceSelectionSchema,
  metricEnvelopeSchema,
  injuryConcernSchema,
  connectionSchema,
  healthSampleBatchSchema,
  routeEstimateSchema,
  resourceLocatorSchema,
  retrievalManifestSchema,
  navigationIntentSchema,
  moduleManifestSchema,
  platformCapabilitiesSchema,
  transportRequestDtoSchema,
  coachingBasisV2Schema,
} from '../src/core.js';

const at = '2026-09-16T10:00:00Z';
const day = {
  date: '2026-09-16',
  timezone: 'Asia/Seoul',
  blockId: null,
  plannedSessionIds: ['session-1'],
  activityIds: [],
  knownRest: false,
};
const period = {
  id: 'block-1',
  planVersionId: 'plan-v1',
  parentId: null,
  level: 'block',
  title: 'Block',
  startDate: '2026-09-16',
  endDateExclusive: '2026-09-26',
  timezone: 'Asia/Seoul',
  intent: '',
  isPartial: false,
};
const metric = {
  id: 'metric-1',
  metricKey: 'rpe',
  unit: 'rpe',
  source: { kind: 'user_report', questionVersion: 'v1' },
  periodStart: at,
  periodEnd: at,
  receivedAt: at,
  evidenceIds: [],
  coverage: { observed: 1, expected: null, unit: 'reports' },
};

describe('wire primitives reject coercion and invalid calendar data', () => {
  it.each(['2026-02-29', '2024-02-30', '2026-13-01', '2026-9-1'])('rejects %s', (value) =>
    expect(localDateSchema.safeParse(value).success).toBe(false),
  );
  it('keeps leap dates, offsets and valid zero revisions', () => {
    expect(localDateSchema.parse('2024-02-29')).toBe('2024-02-29');
    expect(instantSchema.parse('2026-09-16T19:00:00+09:00')).toBe('2026-09-16T19:00:00+09:00');
    expect(revisionSchema.parse(0)).toBe(0);
    for (const bad of [-1, 0.5, '0', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(revisionSchema.safeParse(bad).success).toBe(false);
  });
  it('validates time zone and local time without interpreting local date as instant', () => {
    expect(timeZoneSchema.parse('Asia/Seoul')).toBe('Asia/Seoul');
    expect(timeZoneSchema.safeParse('Unknown/Zone').success).toBe(false);
    expect(localTimeSchema.parse('23:59:59')).toBe('23:59:59');
    expect(localTimeSchema.safeParse('24:00').success).toBe(false);
    expect(instantSchema.safeParse('2026-09-16T19:00:00').success).toBe(false);
    expect(idSchema.safeParse(' id ').success).toBe(false);
  });
});

describe('Host and bridge wire boundary', () => {
  it.each([
    'https://example.com/v1/test',
    '//example.com/v1/test',
    '/v1/../secrets',
    '/v1/%2e%2e/secrets',
    '/v1/%252e%252e/secrets',
    '/v1/a\\b',
    '/v1/test#fragment',
    '/v1/%3F/../secrets',
    '/v1/test?q=%ZZ',
  ])('rejects arbitrary/ambiguous path %s', (path) =>
    expect(apiPathSchema.safeParse(path).success).toBe(false),
  );
  it.each([
    '/bff/v1/resources?q=foam%20roller',
    '/bff/v1/resources?url=https%3A%2F%2Fexample.com%2Farticle%23section',
    '/v1/resources?q=%EB%A3%A8%ED%8B%B4',
    '/v1/resources?q=%252e%252e',
  ])('preserves encoded query values %s', (path) => {
    expect(apiPathSchema.parse(path)).toBe(path);
  });
  it('accepts intended API path and serializable envelope', () => {
    expect(
      transportRequestDtoSchema.parse({
        path: '/bff/v1/activities?from=2026-09-16',
        method: 'GET',
        body: null,
        idempotencyKey: null,
      }).body,
    ).toBeNull();
    expect(
      transportRequestDtoSchema.safeParse({
        path: '/v1/test',
        method: 'GET',
        body: undefined,
        idempotencyKey: null,
      }).success,
    ).toBe(false);
    expect(
      navigationIntentSchema.parse({
        module: 'routines',
        screen: 'library',
        params: {},
        replace: false,
      }).module,
    ).toBe('routines');
  });
  it('rejects unknown bridge methods, versions, scripts and missing capability entries', () => {
    expect(
      bridgeRequestSchema.parse({ version: 1, id: 'r1', method: 'media.pick', accept: 'image' })
        .method,
    ).toBe('media.pick');
    expect(
      bridgeRequestSchema.safeParse({ version: 1, id: 'r1', method: 'eval', script: '1' }).success,
    ).toBe(false);
    expect(
      bridgeRequestSchema.safeParse({ version: 2, id: 'r1', method: 'health.syncStatus' }).success,
    ).toBe(false);
    expect(
      bridgeRequestSchema.safeParse({
        version: 1,
        id: 'r1',
        method: 'share.open',
        title: 't',
        url: 'javascript:alert(1)',
      }).success,
    ).toBe(false);
    expect(
      bridgeReplySchema.safeParse({ version: 1, id: 'r1', ok: false, result: {} }).success,
    ).toBe(false);
    expect(platformCapabilitiesSchema.safeParse({}).success).toBe(false);
  });
  it('rejects duplicate module screens/capabilities', () => {
    const manifest = {
      id: 'activities',
      version: '1',
      routes: [{ screen: 'list', path: '/activities' }],
      requiredCapabilities: [],
      optionalCapabilities: [],
      contractVersion: '1',
    };
    expect(moduleManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      moduleManifestSchema.safeParse({
        ...manifest,
        routes: [...manifest.routes, ...manifest.routes],
      }).success,
    ).toBe(false);
  });
});

describe('plans and projections remain distinct from actuals', () => {
  it('accepts 10-day block and rejects empty/reversed period or self-parent', () => {
    expect(planPeriodSchema.parse(period).endDateExclusive).toBe('2026-09-26');
    for (const patch of [{ endDateExclusive: period.startDate }, { parentId: period.id }])
      expect(planPeriodSchema.safeParse({ ...period, ...patch }).success).toBe(false);
    expect(
      planningLensSchema.safeParse({ kind: 'rolling', anchorDate: day.date, days: 0 }).success,
    ).toBe(false);
    expect(planningLensSchema.parse({ kind: 'rolling', anchorDate: day.date, days: 10 }).kind).toBe(
      'rolling',
    );
  });
  it('preserves unknown and false without manufacturing actual activity', () => {
    expect(dayProjectionSchema.parse(day)).toEqual(day);
    expect(dayProjectionSchema.safeParse({ ...day, activityIds: ['a', 'a'] }).success).toBe(false);
    expect(
      plannerEventSchema(z.string()).parse({
        id: 'e',
        layer: 'draft',
        date: day.date,
        localStartTime: null,
        durationSeconds: null,
        payload: 'draft',
      }).durationSeconds,
    ).toBeNull();
    expect(
      workspaceSelectionSchema.safeParse({
        activityId: null,
        sessionId: null,
        range: { fromSeconds: 20, toSeconds: 10 },
        source: 'chart',
      }).success,
    ).toBe(false);
  });
});

describe('source metrics preserve availability and no invented probability', () => {
  it('accepts known zero separately from unavailable null', () => {
    expect(
      metricEnvelopeSchema.parse({
        ...metric,
        status: 'available',
        value: 0,
        scale: { min: 0, max: 10 },
        caveats: [],
      }).value,
    ).toBe(0);
    expect(
      metricEnvelopeSchema.parse({
        ...metric,
        status: 'not_observed',
        value: null,
        reason: 'No report',
      }).value,
    ).toBeNull();
    expect(
      metricEnvelopeSchema.safeParse({
        ...metric,
        status: 'not_observed',
        value: 0,
        reason: 'No report',
      }).success,
    ).toBe(false);
    expect(
      metricEnvelopeSchema.safeParse({
        ...metric,
        status: 'available',
        value: null,
        scale: null,
        caveats: [],
      }).success,
    ).toBe(false);
  });
  it('compares offset instants by time and rejects extra probability/secrets', () => {
    expect(
      metricEnvelopeSchema.safeParse({
        ...metric,
        periodStart: '2026-09-16T12:00:00+09:00',
        periodEnd: '2026-09-16T04:00:00Z',
        status: 'partial',
        value: 1,
        scale: null,
        caveats: [],
      }).success,
    ).toBe(true);
    expect(
      injuryConcernSchema.safeParse({
        state: 'unknown',
        signals: [],
        missingInformation: [],
        probability: 0.8,
      }).success,
    ).toBe(false);
    const c = {
      id: 'c',
      provider: 'garmin',
      status: 'pending',
      capabilities: {},
      lastSuccessfulImportAt: null,
      latestMeasurementAt: null,
    };
    expect(connectionSchema.safeParse(c).success).toBe(true);
    expect(connectionSchema.safeParse({ ...c, token: 'secret' }).success).toBe(false);
  });
});

describe('ingestion and resources enforce structure without pretending to authorize', () => {
  it('rejects duplicate samples and mixed sample/deletion entries', () => {
    const sample = {
      sourceSampleId: 's',
      type: 'heart_rate',
      observedFrom: at,
      observedTo: at,
      sourceRevision: '1',
      value: 100,
    };
    const batch = {
      schemaVersion: 1,
      installationId: 'i',
      batchId: 'b',
      samples: [sample],
      deletedSampleIds: [],
    };
    expect(healthSampleBatchSchema.safeParse(batch).success).toBe(true);
    expect(healthSampleBatchSchema.safeParse({ ...batch, samples: [sample, sample] }).success).toBe(
      false,
    );
    expect(healthSampleBatchSchema.safeParse({ ...batch, deletedSampleIds: ['s'] }).success).toBe(
      false,
    );
  });
  it('requires real geometry for computed route', () => {
    const route = {
      status: 'computed',
      provider: 'fixture',
      profile: 'walk',
      calculatedAt: at,
      geometry: {
        type: 'LineString',
        coordinates: [
          [127, 37],
          [128, 38],
        ],
      },
      distanceMeters: 100,
      elevationSource: null,
      warnings: [],
    };
    expect(routeEstimateSchema.safeParse(route).success).toBe(true);
    expect(routeEstimateSchema.safeParse({ ...route, geometry: null }).success).toBe(false);
    expect(routeEstimateSchema.safeParse({ ...route, status: 'failed' }).success).toBe(false);
  });
  it('rejects reversed locator and negative revisions', () => {
    expect(
      resourceLocatorSchema.safeParse({ kind: 'media', startSeconds: 20, endSeconds: 10 }).success,
    ).toBe(false);
    expect(
      retrievalManifestSchema.parse({
        authorizationRevision: 0,
        corpusRevision: 0,
        strategyVersion: '1',
        embeddingModelVersion: '1',
        passages: [],
      }).passages,
    ).toEqual([]);
    expect(
      coachingBasisV2Schema.safeParse({
        planVersionId: 'p',
        coachingDataRevision: -1,
        conversationRevision: 0,
        policyVersion: '1',
        evidenceSnapshotId: 'e',
        retrievalManifestId: null,
      }).success,
    ).toBe(false);
  });
});

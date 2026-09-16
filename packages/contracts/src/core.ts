import { z } from 'zod';
import {
  idSchema,
  localDateSchema,
  instantSchema,
  localTimeSchema,
  timeZoneSchema,
  revisionSchema,
  positiveIntegerSchema,
  nonNegativeNumberSchema,
  nonEmptyStringSchema,
  uniqueIdsSchema,
  httpsUrlSchema,
} from './primitives.js';

export const moduleIdSchema = z.enum([
  'dashboard',
  'planning',
  'activities',
  'coaching',
  'wellbeing',
  'courses',
  'competitions',
  'gallery',
  'resources',
  'identity',
  'settings',
  'connections',
  'nutrition',
  'supplementary',
  'routines',
  'recovery',
]);
export const navigationIntentSchema = z.strictObject({
  module: moduleIdSchema,
  screen: nonEmptyStringSchema,
  params: z.record(idSchema, z.string()),
  replace: z.boolean(),
});
export const capabilityNameSchema = z.enum([
  'healthkit.read',
  'healthkit.background',
  'media.pick',
  'share.native',
  'haptics',
  'notifications.native',
]);
export const capabilityStateSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('available'), version: nonEmptyStringSchema }),
  z.strictObject({ state: z.literal('unavailable'), reason: nonEmptyStringSchema }),
  z.strictObject({ state: z.literal('unknown'), reason: nonEmptyStringSchema }),
]);
export const platformCapabilitiesSchema = z.record(capabilityNameSchema, capabilityStateSchema);
/** Syntax boundary only. Hosts must additionally authorize each method/route. */
export const apiPathSchema = z.string().refine((value) => {
  try {
    if (/[\\\s#]/.test(value)) return false;
    // Query values may legitimately contain encoded spaces, URLs and fragments.
    decodeURIComponent(value); // Still reject malformed percent escapes anywhere.
    const decoded = decodeURIComponent(value.split('?')[0] ?? '');
    return (
      /^\/(?:bff\/v1|v1)\//.test(decoded) &&
      !/[\\\s#?]/.test(decoded) &&
      !decoded.includes('//') &&
      !decoded.split('/').some((part) => part === '.' || part === '..') &&
      !/%(?:2e|2f|5c)/i.test(decoded)
    );
  } catch {
    return false;
  }
}, 'Expected an allowlisted relative API path');
export const transportRequestDtoSchema = z.strictObject({
  path: apiPathSchema,
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  body: z.json().nullable(),
  idempotencyKey: idSchema.nullable(),
});
export const transportReplySchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  body: z.json(),
  traceId: idSchema.nullable(),
});
export const moduleManifestSchema = z
  .strictObject({
    id: moduleIdSchema,
    version: nonEmptyStringSchema,
    routes: z.array(
      z.strictObject({ screen: nonEmptyStringSchema, path: z.string().startsWith('/') }),
    ),
    requiredCapabilities: z.array(capabilityNameSchema),
    optionalCapabilities: z.array(capabilityNameSchema),
    contractVersion: nonEmptyStringSchema,
  })
  .refine(
    (v) =>
      new Set(v.routes.map((r) => r.screen)).size === v.routes.length &&
      new Set([...v.requiredCapabilities, ...v.optionalCapabilities]).size ===
        v.requiredCapabilities.length + v.optionalCapabilities.length,
    'Duplicate routes or capabilities',
  );
export const bridgeRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({
    version: z.literal(1),
    id: idSchema,
    method: z.literal('health.requestAuthorization'),
    types: z.array(nonEmptyStringSchema).min(1),
  }),
  z.strictObject({ version: z.literal(1), id: idSchema, method: z.literal('health.syncStatus') }),
  z.strictObject({
    version: z.literal(1),
    id: idSchema,
    method: z.literal('media.pick'),
    accept: z.enum(['image', 'video', 'both']),
  }),
  z.strictObject({
    version: z.literal(1),
    id: idSchema,
    method: z.literal('share.open'),
    title: nonEmptyStringSchema,
    url: httpsUrlSchema,
  }),
  z.strictObject({ version: z.literal(1), id: idSchema, method: z.literal('app.openSettings') }),
]);
export const bridgeReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ version: z.literal(1), id: idSchema, ok: z.literal(true), result: z.json() }),
  z.strictObject({
    version: z.literal(1),
    id: idSchema,
    ok: z.literal(false),
    code: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
  }),
]);
export const periodLevelSchema = z.enum(['season', 'wave', 'phase', 'block']);
export const planPeriodSchema = z
  .strictObject({
    id: idSchema,
    planVersionId: idSchema,
    parentId: idSchema.nullable(),
    level: periodLevelSchema,
    title: nonEmptyStringSchema,
    startDate: localDateSchema,
    endDateExclusive: localDateSchema,
    timezone: timeZoneSchema,
    intent: z.string(),
    isPartial: z.boolean(),
  })
  .refine((v) => v.startDate < v.endDateExclusive, 'Expected non-empty date interval')
  .refine((v) => v.id !== v.parentId, 'Period cannot parent itself');
export const dayProjectionSchema = z.strictObject({
  date: localDateSchema,
  timezone: timeZoneSchema,
  blockId: idSchema.nullable(),
  plannedSessionIds: uniqueIdsSchema,
  activityIds: uniqueIdsSchema,
  knownRest: z.boolean(),
});
export const planningLensSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('period'), periodId: idSchema }),
  z.strictObject({
    kind: z.literal('rolling'),
    anchorDate: localDateSchema,
    days: positiveIntegerSchema.max(3660),
  }),
  z
    .strictObject({
      kind: z.literal('calendar'),
      from: localDateSchema,
      toExclusive: localDateSchema,
    })
    .refine((v) => v.from < v.toExclusive, 'Expected non-empty date interval'),
]);
export function plannerEventSchema<T extends z.ZodType>(payload: T) {
  return z.strictObject({
    id: idSchema,
    layer: z.enum(['current', 'draft', 'proposal', 'actual']),
    date: localDateSchema,
    localStartTime: localTimeSchema.nullable(),
    durationSeconds: nonNegativeNumberSchema.nullable(),
    payload,
  });
}
export const workspaceSelectionSchema = z.strictObject({
  activityId: idSchema.nullable(),
  sessionId: idSchema.nullable(),
  range: z
    .strictObject({ fromSeconds: nonNegativeNumberSchema, toSeconds: nonNegativeNumberSchema })
    .refine((v) => v.fromSeconds <= v.toSeconds, 'Reversed selection')
    .nullable(),
  source: z.enum(['chart', 'map', 'table', 'calendar', 'orbit']),
});
export const metricSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('provider'),
    provider: z.enum(['garmin', 'apple']),
    originalKey: nonEmptyStringSchema,
  }),
  z.strictObject({ kind: z.literal('user_report'), questionVersion: nonEmptyStringSchema }),
  z.strictObject({
    kind: z.literal('derived'),
    definitionId: idSchema,
    definitionVersion: nonEmptyStringSchema,
  }),
]);
export const metricBasisSchema = z.strictObject({
  id: idSchema,
  metricKey: nonEmptyStringSchema,
  unit: nonEmptyStringSchema,
  source: metricSourceSchema,
  periodStart: instantSchema,
  periodEnd: instantSchema,
  receivedAt: instantSchema,
  evidenceIds: uniqueIdsSchema,
  coverage: z.strictObject({
    observed: nonNegativeNumberSchema,
    expected: nonNegativeNumberSchema.nullable(),
    unit: nonEmptyStringSchema,
  }),
});
const metricScaleSchema = z
  .strictObject({ min: z.number().finite(), max: z.number().finite() })
  .refine((v) => v.min <= v.max, 'Reversed metric scale');
export const metricEnvelopeSchema = z
  .union([
    metricBasisSchema.extend({
      status: z.enum(['available', 'partial', 'stale']),
      value: z.number().finite(),
      scale: metricScaleSchema.nullable(),
      caveats: z.array(z.string()),
    }),
    metricBasisSchema.extend({
      status: z.enum(['unsupported', 'not_observed', 'error']),
      value: z.null(),
      reason: nonEmptyStringSchema,
    }),
  ])
  .refine((v) => Date.parse(v.periodStart) <= Date.parse(v.periodEnd), 'Reversed metric interval');
export const injuryConcernSchema = z.strictObject({
  state: z.enum(['unknown', 'no_flag_in_available_data', 'needs_attention', 'needs_review']),
  signals: z.array(z.strictObject({ label: nonEmptyStringSchema, evidenceIds: uniqueIdsSchema })),
  missingInformation: z.array(nonEmptyStringSchema),
});
export const percentileMetadataSchema = z
  .strictObject({
    meaning: z.literal('relative_load_position_not_fatigue_or_injury_probability'),
    baselineFrom: localDateSchema,
    baselineToExclusive: localDateSchema,
    validWindows: revisionSchema,
    windowDays: positiveIntegerSchema,
    definitionVersion: nonEmptyStringSchema,
  })
  .refine((v) => v.baselineFrom < v.baselineToExclusive, 'Reversed baseline');
export const connectionSchema = z.strictObject({
  id: idSchema,
  provider: z.enum(['garmin', 'healthkit']),
  status: z.enum(['not_configured', 'pending', 'connected', 'reauthorize', 'revoked', 'error']),
  capabilities: z.record(nonEmptyStringSchema, capabilityStateSchema),
  lastSuccessfulImportAt: instantSchema.nullable(),
  latestMeasurementAt: instantSchema.nullable(),
});
export const healthSampleBatchSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    installationId: idSchema,
    batchId: idSchema,
    samples: z.array(
      z
        .strictObject({
          sourceSampleId: idSchema,
          type: nonEmptyStringSchema,
          observedFrom: instantSchema,
          observedTo: instantSchema,
          sourceRevision: nonEmptyStringSchema,
          value: z.json(),
        })
        .refine(
          (v) => Date.parse(v.observedFrom) <= Date.parse(v.observedTo),
          'Reversed sample interval',
        ),
    ),
    deletedSampleIds: uniqueIdsSchema,
  })
  .refine(
    (v) =>
      new Set(v.samples.map((s) => s.sourceSampleId)).size === v.samples.length &&
      !v.samples.some((s) => v.deletedSampleIds.includes(s.sourceSampleId)),
    'Duplicate or conflicting sample IDs',
  );
export const sourceSuppressionSchema = z.strictObject({
  provider: nonEmptyStringSchema,
  externalSubject: nonEmptyStringSchema,
  externalRecordId: nonEmptyStringSchema,
  suppressedAt: instantSchema,
  reason: z.enum(['user_local_delete', 'duplicate']),
});
export const routeEstimateSchema = z
  .strictObject({
    status: z.enum(['computed', 'partial', 'failed']),
    provider: nonEmptyStringSchema,
    profile: nonEmptyStringSchema,
    calculatedAt: instantSchema,
    geometry: z
      .strictObject({
        type: z.literal('LineString'),
        coordinates: z
          .array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]))
          .min(2),
      })
      .nullable(),
    distanceMeters: nonNegativeNumberSchema.nullable(),
    elevationSource: nonEmptyStringSchema.nullable(),
    warnings: z.array(nonEmptyStringSchema),
  })
  .refine(
    (v) => v.status !== 'computed' || (v.geometry !== null && v.distanceMeters !== null),
    'Computed route needs geometry and distance',
  )
  .refine(
    (v) => v.status !== 'failed' || (v.geometry === null && v.distanceMeters === null),
    'Failed route cannot claim computed results',
  );
export const resourceLocatorSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('pdf'),
      page: positiveIntegerSchema,
      startOffset: revisionSchema,
      endOffset: revisionSchema,
    })
    .refine((v) => v.startOffset <= v.endOffset, 'Reversed offsets'),
  z.strictObject({
    kind: z.literal('text'),
    headingPath: z.array(nonEmptyStringSchema),
    paragraph: positiveIntegerSchema,
  }),
  z
    .strictObject({
      kind: z.literal('media'),
      startSeconds: nonNegativeNumberSchema,
      endSeconds: nonNegativeNumberSchema,
    })
    .refine((v) => v.startSeconds <= v.endSeconds, 'Reversed media interval'),
]);
export const retrievedPassageSchema = z.strictObject({
  passageId: idSchema,
  resourceId: idSchema,
  resourceVersionId: idSchema,
  contentHash: nonEmptyStringSchema,
  text: z.string(),
  locator: resourceLocatorSchema,
  sourceTitle: nonEmptyStringSchema,
  language: nonEmptyStringSchema,
  reviewState: z.enum(['unreviewed', 'reviewed', 'retracted']),
  retrievedAt: instantSchema,
});
export const retrievalManifestSchema = z.strictObject({
  authorizationRevision: revisionSchema,
  corpusRevision: revisionSchema,
  strategyVersion: nonEmptyStringSchema,
  embeddingModelVersion: nonEmptyStringSchema,
  passages: z.array(retrievedPassageSchema),
});
export const coachingBasisV2Schema = z.strictObject({
  planVersionId: idSchema,
  coachingDataRevision: revisionSchema,
  conversationRevision: revisionSchema,
  policyVersion: nonEmptyStringSchema,
  evidenceSnapshotId: idSchema,
  retrievalManifestId: idSchema.nullable(),
});

export type ModuleId = z.infer<typeof moduleIdSchema>;
export type NavigationIntent = z.infer<typeof navigationIntentSchema>;
export type CapabilityName = z.infer<typeof capabilityNameSchema>;
export type CapabilityState = z.infer<typeof capabilityStateSchema>;
export type PlatformCapabilities = z.infer<typeof platformCapabilitiesSchema>;
export type TransportRequest = z.infer<typeof transportRequestDtoSchema> & { signal?: AbortSignal };
export interface AuthenticatedTransport {
  request(input: TransportRequest): Promise<z.infer<typeof transportReplySchema>>;
}
export interface HostContext {
  environment: 'web' | 'ios-webview' | 'android-webview';
  navigate(intent: NavigationIntent): void;
  transport: AuthenticatedTransport;
  capabilities: PlatformCapabilities;
  openExternal(url: string): Promise<void>;
  onForeground(listener: () => void): () => void;
}
export type ModuleManifest = z.infer<typeof moduleManifestSchema>;
export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;
export type BridgeReply = z.infer<typeof bridgeReplySchema>;
export type PeriodLevel = z.infer<typeof periodLevelSchema>;
export type PlanPeriod = z.infer<typeof planPeriodSchema>;
export type DayProjection = z.infer<typeof dayProjectionSchema>;
export type PlanningLens = z.infer<typeof planningLensSchema>;
export type PlannerEvent<TPayload> = Omit<
  z.infer<ReturnType<typeof plannerEventSchema>>,
  'payload'
> & { payload: TPayload };
export type WorkspaceSelection = z.infer<typeof workspaceSelectionSchema>;
export type MetricSource = z.infer<typeof metricSourceSchema>;
export type MetricBasis = z.infer<typeof metricBasisSchema>;
export type MetricEnvelope = z.infer<typeof metricEnvelopeSchema>;
export type InjuryConcern = z.infer<typeof injuryConcernSchema>;
export type PercentileMetadata = z.infer<typeof percentileMetadataSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type HealthSampleBatch = z.infer<typeof healthSampleBatchSchema>;
export type SourceSuppression = z.infer<typeof sourceSuppressionSchema>;
export type RouteEstimate = z.infer<typeof routeEstimateSchema>;
export type ResourceLocator = z.infer<typeof resourceLocatorSchema>;
export type RetrievedPassage = z.infer<typeof retrievedPassageSchema>;
export type RetrievalManifest = z.infer<typeof retrievalManifestSchema>;
export type CoachingBasisV2 = z.infer<typeof coachingBasisV2Schema>;

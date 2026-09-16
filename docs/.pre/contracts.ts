/** v0.2.3 contract sketch (ModuleId extended; legacy contracts preserved). Runtime validation/authorization still required.
 * No React/Next/ORM/native implementation types cross this boundary.
 */
export type Id = string;
export type LocalDate = string;
export type Instant = string;
export type ModuleId =
  | 'dashboard' | 'planning' | 'activities' | 'coaching' | 'wellbeing'
  | 'courses' | 'competitions' | 'gallery' | 'resources' | 'identity'
  | 'settings' | 'connections' | 'nutrition' | 'supplementary'
  | 'routines' | 'recovery';

export interface NavigationIntent {
  module: ModuleId;
  screen: string;
  params: Readonly<Record<string, string>>;
  replace: boolean;
}
export type CapabilityName =
  | 'healthkit.read' | 'healthkit.background' | 'media.pick'
  | 'share.native' | 'haptics' | 'notifications.native';
export type CapabilityState =
  | { state: 'available'; version: string }
  | { state: 'unavailable'; reason: string }
  | { state: 'unknown'; reason: string };
export type PlatformCapabilities = Readonly<Record<CapabilityName, CapabilityState>>;
export interface TransportRequest {
  path: string; // Runtime: relative allowlisted API path, never arbitrary origin.
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body: unknown | null;
  idempotencyKey: string | null;
  signal?: AbortSignal;
}
export interface AuthenticatedTransport {
  request(input: TransportRequest): Promise<{
    status: number; body: unknown; traceId: string | null;
  }>;
}
export interface HostContext {
  environment: 'web' | 'ios-webview' | 'android-webview';
  navigate(intent: NavigationIntent): void;
  transport: AuthenticatedTransport;
  capabilities: PlatformCapabilities;
  openExternal(url: string): Promise<void>;
  onForeground(listener: () => void): () => void;
}
export interface ModuleManifest {
  id: ModuleId;
  version: string;
  routes: ReadonlyArray<{ screen: string; path: string }>;
  requiredCapabilities: readonly CapabilityName[];
  optionalCapabilities: readonly CapabilityName[];
  contractVersion: string;
}
export type BridgeRequest =
  | { version: 1; id: Id; method: 'health.requestAuthorization'; types: string[] }
  | { version: 1; id: Id; method: 'health.syncStatus' }
  | { version: 1; id: Id; method: 'media.pick'; accept: 'image' | 'video' | 'both' }
  | { version: 1; id: Id; method: 'share.open'; title: string; url: string }
  | { version: 1; id: Id; method: 'app.openSettings' };
export type BridgeReply =
  | { version: 1; id: Id; ok: true; result: unknown }
  | { version: 1; id: Id; ok: false; code: string; message: string };

export type PeriodLevel = 'season' | 'wave' | 'phase' | 'block';
export interface PlanPeriod {
  id: Id;
  planVersionId: Id;
  parentId: Id | null;
  level: PeriodLevel;
  title: string;
  startDate: LocalDate;
  endDateExclusive: LocalDate;
  timezone: string;
  intent: string;
  isPartial: boolean;
}
export interface DayProjection {
  date: LocalDate;
  timezone: string;
  blockId: Id | null;
  plannedSessionIds: Id[];
  activityIds: Id[];
  knownRest: boolean; // false is not proof training occurred.
}
export type PlanningLens =
  | { kind: 'period'; periodId: Id }
  | { kind: 'rolling'; anchorDate: LocalDate; days: number }
  | { kind: 'calendar'; from: LocalDate; toExclusive: LocalDate };
export interface PlannerEvent<TPayload> {
  id: Id;
  layer: 'current' | 'draft' | 'proposal' | 'actual';
  date: LocalDate;
  localStartTime: string | null;
  durationSeconds: number | null;
  payload: TPayload;
}
export interface WorkspaceSelection {
  activityId: Id | null;
  sessionId: Id | null;
  range: { fromSeconds: number; toSeconds: number } | null;
  source: 'chart' | 'map' | 'table' | 'calendar' | 'orbit';
}

export type MetricSource =
  | { kind: 'provider'; provider: 'garmin' | 'apple'; originalKey: string }
  | { kind: 'user_report'; questionVersion: string }
  | { kind: 'derived'; definitionId: string; definitionVersion: string };
export interface MetricBasis {
  id: Id;
  metricKey: string;
  unit: string;
  source: MetricSource;
  periodStart: Instant;
  periodEnd: Instant;
  receivedAt: Instant;
  evidenceIds: readonly Id[];
  coverage: { observed: number; expected: number | null; unit: string };
}
export type MetricEnvelope = MetricBasis & (
  | { status: 'available' | 'partial' | 'stale'; value: number;
      scale: { min: number; max: number } | null; caveats: string[] }
  | { status: 'unsupported' | 'not_observed' | 'error'; value: null;
      reason: string }
);
export interface InjuryConcern {
  state: 'unknown' | 'no_flag_in_available_data' | 'needs_attention' | 'needs_review';
  signals: ReadonlyArray<{ label: string; evidenceIds: Id[] }>;
  missingInformation: string[];
  // Intentionally no probability field; absence of flags is not clearance.
}
export interface PercentileMetadata {
  meaning: 'relative_load_position_not_fatigue_or_injury_probability';
  baselineFrom: LocalDate;
  baselineToExclusive: LocalDate;
  validWindows: number;
  windowDays: number;
  definitionVersion: string;
}

export interface Connection {
  id: Id;
  provider: 'garmin' | 'healthkit';
  status: 'not_configured' | 'pending' | 'connected' | 'reauthorize' | 'revoked' | 'error';
  capabilities: Readonly<Record<string, CapabilityState>>;
  lastSuccessfulImportAt: Instant | null;
  latestMeasurementAt: Instant | null;
  // Credential reference remains server-only; never send secrets in this DTO.
}
export interface HealthSampleBatch {
  schemaVersion: 1;
  installationId: Id;
  batchId: Id;
  samples: ReadonlyArray<{
    sourceSampleId: string; type: string; observedFrom: Instant;
    observedTo: Instant; sourceRevision: string; value: unknown;
  }>;
  deletedSampleIds: readonly string[];
}
export interface SourceSuppression {
  provider: string;
  externalSubject: string;
  externalRecordId: string;
  suppressedAt: Instant;
  reason: 'user_local_delete' | 'duplicate';
}
export interface RouteEstimate {
  status: 'computed' | 'partial' | 'failed';
  provider: string;
  profile: string;
  calculatedAt: Instant;
  geometry: { type: 'LineString'; coordinates: readonly (readonly [number, number])[] } | null;
  distanceMeters: number | null;
  elevationSource: string | null;
  warnings: string[];
}

export type ResourceLocator =
  | { kind: 'pdf'; page: number; startOffset: number; endOffset: number }
  | { kind: 'text'; headingPath: string[]; paragraph: number }
  | { kind: 'media'; startSeconds: number; endSeconds: number };
export interface RetrievedPassage {
  passageId: Id;
  resourceId: Id;
  resourceVersionId: Id;
  contentHash: string;
  text: string;
  locator: ResourceLocator;
  sourceTitle: string;
  language: string;
  reviewState: 'unreviewed' | 'reviewed' | 'retracted';
  retrievedAt: Instant;
  // Retrieval/ACL checked server-side again before model use.
}
export interface RetrievalManifest {
  authorizationRevision: number;
  corpusRevision: number;
  strategyVersion: string;
  embeddingModelVersion: string;
  passages: readonly RetrievedPassage[];
}
export interface CoachingBasisV2 {
  planVersionId: Id;
  coachingDataRevision: number;
  conversationRevision: number;
  policyVersion: string;
  evidenceSnapshotId: Id;
  retrievalManifestId: Id | null;
}

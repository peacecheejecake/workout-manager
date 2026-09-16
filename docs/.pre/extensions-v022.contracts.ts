
/** v0.2.2 contract sketch. No runtime validator, API, UI or physiological model.
 * Planned targets are not actual observations. Numeric ranges need runtime checks.
 */
import type { Id, LocalDate, Instant, DayProjection } from './contracts';

export type LayoutMode = 'mobile' | 'tablet' | 'desktop';
export type ExtraModuleId = 'nutrition' | 'supplementary';
export interface IntegratedDayProjection extends DayProjection {
  schemaVersion: 2;
  nutritionPlanItemIds: readonly Id[];
  intakeEntryIds: readonly Id[];
  // Subset of plannedSessionIds, not additional sessions to double-count.
  supplementarySessionIds: readonly Id[];
}
export interface MetricDatum<U extends string> {
  value: number | null;
  unit: U;
  status: 'reported' | 'measured' | 'estimated' | 'unknown';
  evidenceIds: readonly Id[];
  // Runtime: unknown => null; other states require finite value and valid unit.
}
export interface NumericTarget<U extends string> {
  min: number; max: number; unit: U;
  basis: 'user_confirmed' | 'reviewed_rule' | 'draft_suggestion';
  evidenceIds: readonly Id[];
}
export interface NutrientSnapshot {
  energy: MetricDatum<'kcal'>;
  carbohydrate: MetricDatum<'g'>;
  protein: MetricDatum<'g'>;
  fat: MetricDatum<'g'>;
  fluid: MetricDatum<'mL'>;
  sodium: MetricDatum<'mg'>;
}
export type NutritionAnchor =
  | { kind: 'absolute'; date: LocalDate; localTime: string | null; timezone: string }
  | { kind: 'relative'; entity: 'session' | 'race'; entityId: Id;
      point: 'start' | 'end'; offsetMinutes: number };
export interface FoodPortion {
  foodVersionId: Id | null;
  description: string;
  quantity: number | null;
  unit: 'g' | 'mL' | 'serving' | 'piece' | 'unspecified';
  sourceBasis: 'per_100g' | 'per_100mL' | 'per_serving' | 'manual_total' | 'unknown';
  // Versioned food definition holds conversion, serving size and label provenance.
}
export interface NutritionPlanItem {
  id: Id; planVersionId: Id;
  category: 'meal' | 'snack' | 'before' | 'during' | 'after' | 'hydration';
  title: string; anchor: NutritionAnchor;
  foods: readonly FoodPortion[];
  targets: readonly { metric: keyof NutrientSnapshot; amount: NumericTarget<'kcal' | 'g' | 'mL' | 'mg'> }[];
  instructions: string;
  evidenceIds: readonly Id[];
  // Runtime checks metric-unit pair and unresolved anchor; never auto-populate actual.
}
export interface IntakeEntryRevision {
  intakeId: Id; revisionId: Id;
  occurredAt: Instant; recordedAt: Instant; timezone: string;
  foods: readonly FoodPortion[];
  nutrientTotal: NutrientSnapshot;
  plannedItemId: Id | null;
  relatedSessionIds: readonly Id[];
  relatedActivityIds: readonly Id[];
  source: 'user' | 'provider' | 'user_confirmed_extraction';
  sourceRecordId: string | null;
  notes: string | null;
}
export interface IntakeCoverage {
  from: Instant; toExclusive: Instant;
  status: 'unknown' | 'partial' | 'user_marked_complete';
  knownEntries: number; entriesWithUnknownNutrients: number;
}
export type ExerciseFamily =
  | 'resistance' | 'plyometric' | 'mobility' | 'balance_stability' | 'activation' | 'other';
export type Equipment = 'bodyweight' | 'dumbbell' | 'barbell' | 'machine' | 'band' | 'other';
export type Side = 'bilateral' | 'left' | 'right' | 'alternating' | 'unspecified';
export interface CountDefinition {
  kind: 'repetitions' | 'jumps' | 'landing_events' | 'foot_contacts';
  basis: 'total' | 'per_side' | 'unspecified';
  definitionId: Id;
}
export type ExternalResistance =
  | { kind: 'no_added_load' } // Not proof total physiological load is zero.
  | { kind: 'external' | 'weighted_bodyweight'; totalKg: MetricDatum<'kg'> }
  | { kind: 'assisted'; assistanceKg: MetricDatum<'kg'> }
  | { kind: 'band_or_machine_level'; setting: string; equipmentVersionId: Id | null }
  | { kind: 'unknown' };
export interface ExerciseDefinitionVersion {
  exerciseId: Id; versionId: Id; name: string;
  family: ExerciseFamily; equipment: readonly Equipment[];
  tags: readonly string[];
  countDefinitions: readonly CountDefinition[];
  mediaAssetIds: readonly Id[]; resourceVersionIds: readonly Id[];
  reviewState: 'unreviewed' | 'reviewed' | 'withdrawn';
}
export interface SetTarget {
  id: Id; exerciseVersionId: Id; side: Side;
  count: { target: NumericTarget<'count'>; definition: CountDefinition } | null;
  durationSeconds: NumericTarget<'s'> | null;
  externalResistance: ExternalResistance;
  restAfterSeconds: number | null;
  tempo: { eccentricSeconds: number | null; bottomSeconds: number | null;
    concentricSeconds: number | null; topSeconds: number | null; intent: string | null } | null;
  effort: { rir: number | null; rpe: number | null; scaleVersion: string } | null;
}
export interface SupplementaryWorkoutSpec {
  schemaVersion: 2; kind: 'supplementary';
  routineVersionId: Id | null;
  blocks: readonly {
    id: Id; mode: 'single' | 'superset' | 'circuit'; rounds: number;
    sets: readonly SetTarget[]; restBetweenRoundsSeconds: number | null;
  }[];
  // Distinct from legacy endurance WorkoutSpec; old clients need capability handling.
}
export interface SetLogRevision {
  logId: Id; revisionId: Id; activityId: Id; executionId: Id;
  targetSetId: Id | null; blockId: Id | null; roundIndex: number | null;
  exerciseVersionId: Id; side: Side;
  state: 'performed' | 'partial' | 'confirmed_skipped' | 'stopped' | 'unconfirmed';
  count: { actual: MetricDatum<'count'>; definition: CountDefinition } | null;
  durationSeconds: MetricDatum<'s'>;
  externalResistance: ExternalResistance;
  effort: { rir: number | null; rpe: number | null; scaleVersion: string };
  occurredAt: Instant; recordedAt: Instant;
  reason: string | null;
  // Log ID provides idempotency; recording is not a plan approval.
}
export interface ExecutionTimerState {
  startedAt: Instant; deadlineAt: Instant | null;
  pausedAt: Instant | null; remainingWhenPausedSeconds: number | null;
  status: 'running' | 'paused' | 'finished';
}
export interface TrainingDomainBasis {
  planVersionId: Id; activityDataRevision: number; exerciseCatalogRevision: number;
}
export interface NutritionDomainBasis {
  planVersionId: Id | null; intakeDataRevision: number; foodCatalogRevision: number;
}
export type JointDomains =
  | { scope: 'training'; training: TrainingDomainBasis; nutrition: null }
  | { scope: 'nutrition'; training: null; nutrition: NutritionDomainBasis }
  | { scope: 'combined'; training: TrainingDomainBasis; nutrition: NutritionDomainBasis };
export interface JointCoachingBasis {
  schemaVersion: 3;
  domains: JointDomains;
  // Optional read dependencies even when the write scope is only one domain.
  contextDependencies: readonly { kind: string; id: Id; revision: string }[];
  preferenceRevision: number; constraintRevision: number;
  conversationRevision: number; policyVersion: string; evidenceSnapshotId: Id;
}
export interface JointApprovalRequest {
  schemaVersion: 3;
  proposalId: Id; candidateId: Id; proposalDigest: string;
  expectedBasis: JointCoachingBasis;
  idempotencyKey: string;
  // Server validates authoritative basis; both plan updates are atomic if combined.
}

/** v0.2.3 design-only contracts. No API, runtime validator, timer or clinical model.
 * Values/IDs/ownership, finite recurrence and dependency validity require server checks.
 * Legacy v0.2.2 contracts remain unchanged; migrate through an explicit adapter.
 */
import type { Id, Instant, LocalDate, DayProjection } from './contracts';
import type { MetricDatum, NumericTarget, Side, ExerciseDefinitionVersion } from './extensions-v022.contracts';

export interface VersionRef { id: Id; versionId: Id }
export type PlanDomain = 'training' | 'nutrition' | 'recovery' | 'routine_schedule';
export interface DomainPlanRef { domain: PlanDomain; planId: Id; versionId: Id; itemId: Id }
export interface DependencyRef { kind: string; id: Id; revision: string }
export interface IntegratedDayV023 extends DayProjection {
  schemaVersion: 4;
  nutritionPlanItemIds: readonly Id[];
  intakeEntryIds: readonly Id[];
  recoveryPlanItemIds: readonly Id[];
  recoveryActionLogIds: readonly Id[];
  routineOccurrenceIds: readonly Id[];
  // Wrappers and subsets below are not additional exercise counts or durations.
  routineRunIds: readonly Id[];
  stretchingSessionIds: readonly Id[];
}

export type RoutineStepContent =
  | { kind: 'workout_template'; ref: VersionRef }
  | { kind: 'nutrition_template'; ref: VersionRef }
  | { kind: 'recovery_method'; ref: VersionRef }
  | { kind: 'checkin_template'; ref: VersionRef }
  | { kind: 'checklist'; prompt: string };
export type StepTiming =
  | { kind: 'ordered'; afterStepId: Id | null }
  | { kind: 'anchor_relative'; point: 'start' | 'end'; offsetMinutes: number }
  | { kind: 'user_scheduled' };
export interface RoutineBlueprintStep {
  id: Id; title: string; content: RoutineStepContent;
  timing: StepTiming;
  required: boolean;
  choiceGroupId: Id | null;
  // Required applies only to a selected alternative; no arbitrary code predicates.
}
export interface RoutineBlueprintVersion {
  schemaVersion: 4;
  routineId: Id; versionId: Id; title: string; intent: string;
  status: 'draft' | 'published' | 'archived';
  tags: readonly string[];
  steps: readonly RoutineBlueprintStep[];
  choiceGroups: readonly { id: Id; mode: 'one_of'; stepIds: readonly Id[] }[];
  estimatedDurationSeconds: number | null;
  createdAt: Instant;
  // This is composition, NOT v022's strength-only RoutineTemplateVersion.
}
export interface FiniteExpansionWindow {
  startDate: LocalDate; endDateExclusive: LocalDate; timezone: string;
  maxOccurrences: number;
}
export type RoutineScheduleRule =
  | { kind: 'dates'; dates: readonly LocalDate[]; localTime: string | null }
  | { kind: 'weekdays'; weekdays: readonly number[]; localTime: string | null }
  | { kind: 'every_n_days'; anchorDate: LocalDate; intervalDays: number; localTime: string | null }
  | { kind: 'period_days'; periodId: Id; offsetsDays: readonly number[]; localTime: string | null }
  | { kind: 'session_links'; sessionIds: readonly Id[]; point: 'start' | 'end'; offsetMinutes: number };
export interface RoutineScheduleVersion {
  schemaVersion: 4;
  id: Id; versionId: Id; blueprint: VersionRef;
  window: FiniteExpansionWindow; rule: RoutineScheduleRule;
  state: 'draft' | 'active' | 'paused' | 'ended';
  // Active/paused affects future canonical plans only through reviewed commands.
}
export interface RoutineOccurrence {
  id: Id; schedule: VersionRef; blueprint: VersionRef;
  anchorKey: string;
  scheduledAt: Instant | null;
  timingStatus: 'resolved' | 'unresolved';
  stepBindings: readonly { stepId: Id; plannedRef: DomainPlanRef }[];
  selectedChoices: Readonly<Record<Id, Id>>;
}
export type ActualRef =
  | { kind: 'activity'; id: Id; revisionId: Id; detailId: Id | null; allocationId: Id | null }
  | { kind: 'intake'; id: Id; revisionId: Id }
  | { kind: 'recovery_log'; id: Id; revisionId: Id }
  | { kind: 'checkin'; id: Id; revisionId: Id }
  | { kind: 'checklist_confirmation'; id: Id; revisionId: Id };
export type StepOutcome = 'pending' | 'in_progress' | 'partial' | 'performed'
  | 'confirmed_skipped' | 'stopped' | 'not_applicable';
export interface RoutineStepProgress {
  stepId: Id; revision: number; state: StepOutcome;
  actualRefs: readonly ActualRef[];
  occurredAt: Instant | null; recordedAt: Instant;
  reason: string | null;
}
export interface RoutineRun {
  id: Id; revision: number; blueprint: VersionRef;
  origin: { kind: 'planned'; occurrenceId: Id } | { kind: 'unplanned' };
  state: 'in_progress' | 'paused' | 'ended' | 'stopped';
  progress: readonly RoutineStepProgress[];
  selectedChoices: Readonly<Record<Id, Id>>;
  startedAt: Instant; endedAt: Instant | null;
  // No aggregate exercise duration/calories here. Ending is not all steps performed.
}

export type StretchMethod = 'static_hold' | 'dynamic_repetition' | 'other_reviewed';
export interface StretchExerciseVersion extends Omit<ExerciseDefinitionVersion, 'family'> {
  family: 'stretching';
  method: StretchMethod;
  movementMode: 'active' | 'passive' | 'unspecified';
  assistance: 'self' | 'equipment' | 'partner' | 'unspecified';
  bodyRegionTags: readonly string[];
  contextTags: readonly string[];
  instructionText: string;
  cautionText: string;
}
export interface StretchTarget {
  id: Id; exerciseVersionId: Id; side: Side;
  method: StretchMethod;
  holdSeconds: NumericTarget<'s'> | null;
  repetitions: NumericTarget<'count'> | null;
  countBasis: 'total' | 'per_side' | 'unspecified';
  restAfterSeconds: number | null;
  // Require method-consistent dimensions; no automatic target-to-actual copy.
}
export interface StretchLogRevision {
  id: Id; revisionId: Id; activityId: Id; executionId: Id;
  plannedTargetId: Id | null; exerciseVersionId: Id; side: Side;
  state: Exclude<StepOutcome, 'pending' | 'in_progress' | 'not_applicable'>;
  holdSeconds: MetricDatum<'s'>;
  repetitions: MetricDatum<'count'>;
  countBasis: 'total' | 'per_side' | 'unspecified';
  occurredAt: Instant; recordedAt: Instant;
  checkInIds: readonly Id[];
  reason: string | null;
  // Source records differentiate elapsed timer, confirmed holding and rest time.
}

export interface RecoveryMethodVersion {
  id: Id; versionId: Id; title: string;
  category: 'rest' | 'sleep_preparation' | 'relaxation' | 'manual_method'
    | 'compression' | 'thermal_method' | 'electrical_stimulation' | 'other';
  reviewState: 'unreviewed' | 'reviewed_for_stated_use' | 'withdrawn';
  intendedUse: string;
  applicability: readonly string[];
  cautions: readonly string[];
  resourceVersionIds: readonly Id[];
  reviewedAt: Instant | null;
  // A catalog entry is not an efficacy ranking, universal dose or device control.
}
export interface RecoveryPlanItem {
  id: Id; planVersionId: Id; strategy: VersionRef | null;
  method: VersionRef;
  scheduledAt: Instant | null;
  userInstructions: string;
  reviewAt: Instant | null;
  // Owns only nonexercise actions. Exercise/intake plans remain in their domains.
}
export interface RecoveryStrategyVersion {
  id: Id; versionId: Id; title: string; goal: string;
  startDate: LocalDate; endDateExclusive: LocalDate; timezone: string;
  selectedOptionId: Id | null;
  options: readonly {
    id: Id; title: string;
    actionRefs: readonly DomainPlanRef[];
    rationaleEvidenceIds: readonly Id[];
  }[];
  missingInformation: readonly string[];
  reassessment: readonly {
    id: Id;
    trigger: 'scheduled_checkin' | 'user_report_changed' | 'plan_changed' | 'source_withdrawn';
    plannedAt: Instant | null;
    description: string;
    policyVersion: string | null;
  }[];
}
export interface RecoveryActionLogRevision {
  id: Id; revisionId: Id; method: VersionRef;
  plannedItemId: Id | null;
  occurredAt: Instant; recordedAt: Instant;
  state: 'performed' | 'partial' | 'confirmed_skipped' | 'stopped' | 'unconfirmed';
  duration: MetricDatum<'s'>;
  beforeCheckInId: Id | null; afterCheckInId: Id | null;
  userNotes: string | null;
  // Optional quantitative conditions need method-specific validated schemas later.
  // A sleep-preparation log is not evidence that sleep happened.
}

export interface PlanHeadExpectation {
  domain: PlanDomain;
  aggregateId: Id; // Plan/schedule identity, also allocated for proposed creation.
  head: { kind: 'exists'; versionId: Id } | { kind: 'absent' };
  // Absent must be rechecked within the same transaction, not treated as wildcard.
}
export interface IntegratedCoachingBasisV023 {
  schemaVersion: 4;
  planHeads: readonly PlanHeadExpectation[];
  contextDependencies: readonly DependencyRef[];
  preferenceRevision: number; constraintRevision: number;
  conversationRevision: number; policyVersion: string;
  evidenceSnapshotId: Id;
}
export interface IntegratedApprovalV023 {
  schemaVersion: 4;
  proposalId: Id; candidateId: Id; proposalDigest: string;
  writeDomains: readonly [PlanDomain, ...PlanDomain[]];
  expectedBasis: IntegratedCoachingBasisV023;
  idempotencyKey: string;
  // Server-owned candidate operations determine/validate domains, not client claims.
  // Apply domain versions/strategy/occurrences/approval/outbox atomically.
}

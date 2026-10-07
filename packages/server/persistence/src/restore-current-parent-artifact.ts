import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** Exact current physical columns, not historical source100 DTOs. Source capture,
 * FK/CHECK/trigger validation and SQL row encoding require an independent stage.
 * No child handle, signed count or archived seal authenticates those operations. */
export const CURRENT_PARENT_MAX_ROWS = 5000;
export const CURRENT_PARENT_MAX_ROW_BYTES = 4 * 1024 * 1024;
export const CURRENT_PARENT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const domain = 'wm-current-parent-family-authentication-v1\0';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const tenant = z.string().min(1).max(200);
const text = z.string().max(CURRENT_PARENT_MAX_ROW_BYTES);
const integer = z.number().int().min(-2147483648).max(2147483647);
const positive = integer.min(1);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine((v) => z.iso.datetime({ precision: 6 }).safeParse(v).success);
const bigint = z
  .string()
  .regex(/^(?:0|-?[1-9][0-9]*)$/)
  .refine((v) => BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n);
const decimal = z.string().regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
// JSONB is a physical JSON value; domain DTO authorization is NOT attested here.
// The outer plain/UTF8 budget applies before any recursive schema parsing.
const schemas = {
  'identity_private.account': z.strictObject({
    athlete_id: uuid,
    issuer: text,
    subject: text,
  }),
  consent: z.strictObject({
    athlete_id: tenant,
    kind: text,
    granted: z.boolean(),
    revision: integer,
  }),
  tenant_erasure: z.strictObject({
    athlete_id: tenant,
    erased_at: timestamp,
  }),
  food_definition_version: z.strictObject({
    athlete_id: tenant,
    food_id: text,
    version_id: uuid,
    version: integer,
    previous_version_id: uuid.nullable(),
    previous_version: integer.nullable(),
    created_at: timestamp,
    record_json: z.json(),
  }),
  food_definition_head: z.strictObject({
    athlete_id: tenant,
    food_id: text,
    version: integer,
    version_id: uuid,
  }),
  supplementary_exercise_version: z.strictObject({
    athlete_id: tenant,
    exercise_id: uuid,
    version_id: uuid,
    version: integer,
    previous_version_id: uuid.nullable(),
    previous_version: integer.nullable(),
    created_at: timestamp,
    record_json: z.json(),
  }),
  supplementary_exercise_head: z.strictObject({
    athlete_id: tenant,
    exercise_id: uuid,
    version: integer,
    version_id: uuid,
  }),
  recovery_method_version: z.strictObject({
    athlete_id: tenant,
    method_id: uuid,
    version_id: uuid,
    version: integer,
    record_json: z.json(),
  }),
  recovery_method_head: z.strictObject({
    athlete_id: tenant,
    method_id: uuid,
    version: integer,
    version_id: uuid,
  }),
  supplementary_routine_version: z.strictObject({
    athlete_id: tenant,
    routine_id: uuid,
    version_id: uuid,
    version: integer,
    previous_version_id: uuid.nullable(),
    previous_version: integer.nullable(),
    created_at: timestamp,
    record_json: z.json(),
  }),
  supplementary_routine_head: z.strictObject({
    athlete_id: tenant,
    routine_id: uuid,
    version: integer,
    version_id: uuid,
  }),
  supplementary_routine_target_ref: z.strictObject({
    athlete_id: tenant,
    routine_version_id: uuid,
    block_id: text,
    target_set_id: text,
    exercise_version_id: uuid,
  }),
  activity_canonical: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    revision: integer,
    original: z.json(),
    deleted: z.boolean(),
  }),
  activity_source_revision: z.strictObject({
    athlete_id: tenant,
    kind: text,
    source_id: text,
    source_revision: integer,
    content_hash: text,
    normalized_raw: z.json(),
    details_json: z.json().nullable(),
  }),
  activity_source_head: z.strictObject({
    athlete_id: tenant,
    kind: text,
    source_id: text,
    source_revision: integer,
    content_hash: text,
    activity_id: uuid,
  }),
  activity_overlay_revision: z.strictObject({
    athlete_id: tenant,
    activity_id: uuid,
    revision: integer,
    values_json: z.json(),
  }),
  activity_overlay: z.strictObject({
    athlete_id: tenant,
    activity_id: uuid,
    values_json: z.json(),
  }),
  activity_suppression: z.strictObject({
    athlete_id: tenant,
    kind: text,
    source_id: text,
  }),
  activity_track_object: z.strictObject({
    athlete_id: tenant,
    storage_ref: text,
    artifact_kind: text,
    content_hash: text,
    size_bytes: bigint,
    media_type: text,
    created_at: timestamp,
  }),
  activity_track: z.strictObject({
    athlete_id: tenant,
    activity_id: uuid,
    track_id: uuid,
    source_kind: text,
    source_id: text,
    track_revision: integer,
    revision_id: uuid,
    created_at: timestamp,
    updated_at: timestamp,
  }),
  activity_track_revision: z.strictObject({
    athlete_id: tenant,
    activity_id: uuid,
    track_id: uuid,
    track_revision: integer,
    revision_id: uuid,
    upload_id: uuid,
    source_kind: text,
    source_id: text,
    source_revision: integer,
    recorded_source_kind: text,
    parser_id: text,
    parser_version: integer,
    correspondence_digest: text,
    format: text,
    original_filename: text.nullable(),
    raw_storage_ref: text,
    raw_size_bytes: bigint,
    raw_content_hash: text,
    normalized_storage_ref: text,
    normalized_size_bytes: bigint,
    normalized_content_hash: text,
    map_path_storage_ref: text,
    map_path_size_bytes: bigint,
    map_path_content_hash: text,
    sample_count: integer,
    positioned_sample_count: integer,
    segment_count: integer,
    segment_policy: z.json(),
    distances: z.json(),
    created_at: timestamp,
  }),
  activity_track_object_ref: z.strictObject({
    storage_ref: text,
    athlete_id: tenant,
    recorded_at: timestamp,
    settled_at: timestamp.nullable(),
    sweep_attempts: integer,
    sweep_error_code: text.nullable(),
    sweep_first_failed_at: timestamp.nullable(),
    sweep_failed_at: timestamp.nullable(),
    sweep_retry_at: timestamp.nullable(),
  }),
  course: z.strictObject({
    athlete_id: tenant,
    course_id: uuid,
    name: text,
    visibility: text,
    status: text,
    head_revision: integer.nullable(),
    revision_id: uuid.nullable(),
    unavailable_reason: text.nullable(),
    reclaimed_at: timestamp.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  }),
  course_revision: z.strictObject({
    athlete_id: tenant,
    course_id: uuid,
    course_revision: integer,
    revision_id: uuid,
    name: text,
    geometry: z.json(),
    waypoints: z.json(),
    generation: z.json(),
    edit: z.json(),
    vertex_count: integer,
    distance_meters: z.number().finite(),
    content_digest: text,
    created_at: timestamp,
  }),
  course_revision_source: z.strictObject({
    athlete_id: tenant,
    course_id: uuid,
    course_revision: integer,
    activity_id: uuid,
    track_id: uuid,
    track_revision: integer,
  }),
  course_deletion: z.strictObject({
    athlete_id: tenant,
    course_id: uuid,
    deleted_at: timestamp,
  }),
  resource: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    title: text,
    category: text,
    metadata: z.json(),
    tags: z.json(),
    favorite: z.boolean(),
    include_for_coach: z.boolean(),
    reviewed_state: text,
    access_revision: integer,
    current_version: integer,
    current_version_id: uuid,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: timestamp.nullable(),
    source_kind: text,
    reviewed_at: timestamp.nullable(),
    coach_use_enabled_at: timestamp.nullable(),
    reviewed_version_id: uuid.nullable(),
  }),
  resource_version: z.strictObject({
    athlete_id: tenant,
    resource_id: uuid,
    version_id: uuid,
    version: integer,
    previous_version: integer.nullable(),
    previous_version_id: uuid.nullable(),
    content: text.nullable(),
    content_hash: text,
    paragraphs: z.json(),
    content_status: text,
    index_status: text,
    created_at: timestamp,
    storage_ref: text.nullable(),
    original_filename: text.nullable(),
    media_type: text.nullable(),
    size_bytes: bigint.nullable(),
  }),
  resource_object: z.strictObject({
    athlete_id: tenant,
    storage_ref: text,
    content_hash: text,
    size_bytes: bigint,
    media_type: text,
    created_at: timestamp,
  }),
  gallery_media_item: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    media_kind: text,
    visibility: text,
    include_for_coach: z.boolean(),
    album: text.nullable(),
    caption: text.nullable(),
    activity_id: uuid.nullable(),
    captured_at: timestamp.nullable(),
    captured_local_date: z.iso.date().nullable(),
    storage_ref: text,
    original_filename: text,
    media_type: text,
    size_bytes: bigint,
    content_hash: text,
    access_revision: integer,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: timestamp.nullable(),
  }),
  gallery_media_derivative: z.strictObject({
    athlete_id: tenant,
    media_item_id: uuid,
    kind: text,
    storage_ref: text,
    media_type: text,
    size_bytes: bigint,
    content_hash: text,
    created_at: timestamp,
  }),
  gallery_media_object: z.strictObject({
    athlete_id: tenant,
    storage_ref: text,
    content_hash: text,
    size_bytes: bigint,
    media_type: text,
    created_at: timestamp,
  }),
  plan_snapshot: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    version: integer,
    created_at: timestamp,
    draft: z.json(),
  }),
  supplementary_session_link: z.strictObject({
    athlete_id: tenant,
    plan_version_id: uuid,
    planned_session_id: text,
    content_kind: text,
    routine_version_id: uuid.nullable(),
    embedded_spec_json: z.json().nullable(),
  }),
  supplementary_session_target_ref: z.strictObject({
    athlete_id: tenant,
    plan_version_id: uuid,
    planned_session_id: text,
    block_id: text,
    target_set_id: text,
    exercise_version_id: uuid,
  }),
  plan_history: z.strictObject({
    athlete_id: tenant,
    version_id: uuid,
    action: text,
  }),
  plan_head: z.strictObject({
    athlete_id: tenant,
    version_id: uuid,
    aggregate_id: uuid,
  }),
  nutrition_plan_version: z.strictObject({
    athlete_id: tenant,
    plan_id: uuid,
    version_id: uuid,
    version: integer,
    previous_version_id: uuid.nullable(),
    previous_version: integer.nullable(),
    period_from: z.iso.date(),
    period_to: z.iso.date(),
    linked_training_plan_version_id: uuid.nullable(),
    approval_id: uuid,
    approved_at: timestamp,
    record_json: z.json(),
  }),
  nutrition_plan_history: z.strictObject({
    athlete_id: tenant,
    plan_id: uuid,
    version_id: uuid,
    approval_id: uuid,
    action: text,
    created_at: timestamp,
  }),
  nutrition_plan_head: z.strictObject({
    athlete_id: tenant,
    plan_id: uuid,
    version: integer,
    version_id: uuid,
  }),
  recovery_strategy_version: z.strictObject({
    athlete_id: tenant,
    strategy_id: uuid,
    version_id: uuid,
    version: integer,
    previous_version_id: uuid.nullable(),
    previous_version: integer.nullable(),
    record_json: z.json(),
  }),
  recovery_strategy_history: z.strictObject({
    athlete_id: tenant,
    version_id: uuid,
    approval_id: uuid,
    action: text,
  }),
  recovery_strategy_head: z.strictObject({
    athlete_id: tenant,
    strategy_id: uuid,
    version: integer,
    version_id: uuid,
  }),
  routine_blueprint_version: z.strictObject({
    athlete_id: tenant,
    routine_id: uuid,
    version_id: uuid,
    version: integer,
    previous_version_id: uuid.nullable(),
    record_json: z.json(),
    created_at: timestamp,
  }),
  routine_blueprint_head: z.strictObject({
    athlete_id: tenant,
    routine_id: uuid,
    version_id: uuid,
    version: integer,
    favorite: z.boolean(),
    visibility: text,
  }),
  routine_schedule_version: z.strictObject({
    athlete_id: tenant,
    schedule_id: uuid,
    version_id: uuid,
    prior_version_id: uuid.nullable(),
    blueprint_routine_id: uuid,
    blueprint_version_id: uuid,
    source_plan_version_id: uuid.nullable(),
    record_json: z.json(),
    created_at: timestamp,
  }),
  routine_schedule_history: z.strictObject({
    athlete_id: tenant,
    version_id: uuid,
    approval_id: uuid,
    action: text,
  }),
  routine_schedule_head: z.strictObject({
    athlete_id: tenant,
    schedule_id: uuid,
    version_id: uuid,
    notification_muted: z.boolean(),
  }),
  routine_occurrence: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    schedule_id: uuid,
    schedule_version_id: uuid,
    blueprint_routine_id: uuid,
    blueprint_version_id: uuid,
    anchor_key: text,
    scheduled_at: timestamp.nullable(),
    record_json: z.json(),
  }),
  routine_run: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    blueprint_routine_id: uuid,
    blueprint_version_id: uuid,
    occurrence_id: uuid.nullable(),
    revision: integer,
    state: text,
    record_json: z.json(),
  }),
  routine_run_revision: z.strictObject({
    athlete_id: tenant,
    run_id: uuid,
    revision: integer,
    record_json: z.json(),
    recorded_at: timestamp,
  }),
  routine_checklist_confirmation: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    run_id: uuid,
    step_id: text,
    revision_id: uuid,
    occurred_at: timestamp,
    state: text,
  }),
  routine_step_timer: z.strictObject({
    athlete_id: tenant,
    run_id: uuid,
    step_id: text,
    revision: integer,
    state: text,
    duration_seconds: integer,
    started_at: timestamp,
    paused_at: timestamp.nullable(),
    paused_milliseconds: bigint,
  }),
  routine_command_receipt: z.strictObject({
    athlete_id: tenant,
    idempotency_key: text,
    request_hash: text,
    result_json: z.json(),
  }),
  session_completion: z.strictObject({
    athlete_id: tenant,
    session_id: text,
    revision: integer,
    record_json: z.json(),
  }),
  session_completion_revision: z.strictObject({
    athlete_id: tenant,
    session_id: text,
    revision: integer,
    record_json: z.json(),
  }),
  session_completion_receipt: z.strictObject({
    athlete_id: tenant,
    idempotency_key: text,
    request_hash: text,
    result: z.json(),
  }),
  session_completion_collection_head: z.strictObject({
    athlete_id: tenant,
    revision: integer,
  }),
  intake_entry: z.strictObject({
    athlete_id: tenant,
    id: text,
    current_revision: integer,
    current_revision_id: uuid,
    status: text,
  }),
  intake_entry_revision: z.strictObject({
    athlete_id: tenant,
    intake_id: text,
    revision: integer,
    revision_id: uuid,
    status: text,
    occurred_at: timestamp.nullable(),
    recorded_at: timestamp,
    deleted_at: timestamp.nullable(),
    deletion_reason: text.nullable(),
    record_json: z.json().nullable(),
  }),
  check_in: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    revision: integer,
    values_json: z.json().nullable(),
    local_date: z.iso.date().nullable(),
    recorded_at: timestamp,
    updated_at: timestamp,
    deleted: z.boolean(),
  }),
  check_in_revision: z.strictObject({
    athlete_id: tenant,
    check_in_id: uuid,
    revision: integer,
    values_json: z.json(),
    reason: text.nullable(),
    created_at: timestamp,
  }),
  check_in_receipt: z.strictObject({
    athlete_id: tenant,
    idempotency_key: text,
    request_hash: text,
    result: z.json(),
  }),
  check_in_collection_head: z.strictObject({
    athlete_id: tenant,
    revision: integer,
  }),
  recovery_action_log: z.strictObject({
    athlete_id: tenant,
    action_id: uuid,
    revision: integer,
    revision_id: uuid,
    status: text,
  }),
  recovery_action_revision: z.strictObject({
    athlete_id: tenant,
    action_id: uuid,
    revision: integer,
    revision_id: uuid,
    status: text,
    record_json: z.json().nullable(),
  }),
  coaching_thread: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    plan_version_id: uuid,
    title: text,
    scope: z.json(),
    revision: integer,
    created_at: timestamp,
    updated_at: timestamp,
  }),
  coaching_message: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    thread_id: uuid,
    revision: integer,
    content: text,
    created_at: timestamp,
  }),
  core_evidence_snapshot: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    thread_id: uuid,
    created_at: timestamp,
    body: z.json().nullable(),
    purged_reason: text.nullable(),
  }),
  coaching_run: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    thread_id: uuid,
    evidence_snapshot_id: uuid,
    conversation_revision: integer,
    policy: z.json(),
    source: z.json(),
    basis: z.json(),
    status: z.json(),
    created_at: timestamp,
    updated_at: timestamp,
  }),
  coaching_analysis_output: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    run_id: uuid,
    body: z.json().nullable(),
    purged_reason: text.nullable(),
    created_at: timestamp,
  }),
  coaching_decision: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    run_id: uuid,
    body: z.json().nullable(),
    purged_reason: text.nullable(),
    created_at: timestamp,
  }),
  coaching_proposal: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    decision_id: uuid,
    body: z.json().nullable(),
    purged_reason: text.nullable(),
    created_at: timestamp,
  }),
  coaching_candidate: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    decision_id: uuid,
    proposal_id: uuid,
    parent_candidate_id: uuid.nullable(),
    digest: text.nullable(),
    body: z.json().nullable(),
    purged_reason: text.nullable(),
    created_at: timestamp,
  }),
  integrated_candidate_v4: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    proposal_id: uuid,
    digest: text,
    body: z.json().nullable(),
    created_at: timestamp,
    purged_reason: text.nullable(),
  }),
  integrated_approval_v4: z.strictObject({
    athlete_id: tenant,
    approval_id: uuid,
    candidate_id: uuid,
    proposal_id: uuid,
    proposal_digest: text,
    write_domains: z.json(),
    result_json: z.json(),
    approved_at: timestamp,
  }),
  command_receipt: z.strictObject({
    athlete_id: tenant,
    idempotency_key: text,
    request: z.json(),
    result: z.json(),
  }),
  evidence_app_admission_binding: z.strictObject({
    athlete_id: tenant,
    evidence_snapshot_id: uuid,
    binding_version: integer,
    app_revision: integer,
    captured_at: timestamp,
  }),
  run_app_admission_binding: z.strictObject({
    athlete_id: tenant,
    run_id: uuid,
    evidence_snapshot_id: uuid,
    binding_version: integer,
  }),
  candidate_app_admission_binding: z.strictObject({
    athlete_id: tenant,
    candidate_id: uuid,
    run_id: uuid,
    binding_version: integer,
  }),
  integrated_candidate_app_admission_binding: z.strictObject({
    athlete_id: tenant,
    candidate_id: uuid,
    evidence_snapshot_id: uuid,
    binding_version: integer,
  }),
  approval_app_admission_binding: z.strictObject({
    athlete_id: tenant,
    receipt_key: text,
    candidate_id: uuid.nullable(),
    integrated_candidate_id: uuid.nullable(),
    integrated_approval_id: uuid.nullable(),
    binding_version: integer,
    created_at: timestamp,
  }),
  race_event: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    revision: integer,
    values_json: z.json().nullable(),
    deleted: z.boolean(),
    recorded_at: timestamp,
    updated_at: timestamp,
  }),
  race_event_revision: z.strictObject({
    athlete_id: tenant,
    entity_id: uuid,
    revision: integer,
    values_json: z.json(),
    created_at: timestamp,
  }),
  race_result: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    revision: integer,
    values_json: z.json().nullable(),
    deleted: z.boolean(),
    recorded_at: timestamp,
    updated_at: timestamp,
  }),
  race_result_revision: z.strictObject({
    athlete_id: tenant,
    entity_id: uuid,
    revision: integer,
    values_json: z.json(),
    created_at: timestamp,
  }),
  training_best: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    revision: integer,
    values_json: z.json().nullable(),
    deleted: z.boolean(),
    recorded_at: timestamp,
    updated_at: timestamp,
  }),
  training_best_revision: z.strictObject({
    athlete_id: tenant,
    entity_id: uuid,
    revision: integer,
    values_json: z.json(),
    created_at: timestamp,
  }),
  race_command_receipt: z.strictObject({
    athlete_id: tenant,
    idempotency_key: text,
    request_hash: text,
    result: z.json(),
  }),
  race_collection_head: z.strictObject({
    athlete_id: tenant,
    kind: text,
    revision: integer,
    privacy_generation: decimal,
  }),
  integrated_dependency_head: z.strictObject({
    athlete_id: tenant,
    intake_revision: integer,
    activity_revision: integer,
    execution_revision: integer,
    set_revision: integer,
    food_revision: integer,
    exercise_revision: integer,
    routine_revision: integer,
    routine_run_revision: integer,
    routine_occurrence_revision: integer,
    routine_blueprint_revision: integer,
    recovery_action_revision: integer,
    recovery_method_revision: integer,
  }),
  coaching_constraint_head: z.strictObject({
    athlete_id: tenant,
    revision: integer,
    updated_at: timestamp,
  }),
  coaching_constraint: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    revision: integer,
    text: text.nullable(),
    confirmed_at: timestamp,
    updated_at: timestamp,
    deleted: z.boolean(),
  }),
  outbox: z.strictObject({
    athlete_id: tenant,
    id: uuid,
    idempotency_key: text,
    topic: text,
    payload: z.json(),
    created_at: timestamp,
    available_at: timestamp,
    lease_token: uuid.nullable(),
    lease_until: timestamp.nullable(),
    attempts: integer,
    completed_at: timestamp.nullable(),
  }),
} as const;
export const CURRENT_PARENT_RELATIONS = [
  'activity_canonical',
  'activity_import_receipt',
  'activity_overlay',
  'activity_overlay_revision',
  'activity_source_head',
  'activity_source_revision',
  'activity_suppression',
  'activity_track',
  'activity_track_object',
  'activity_track_object_ref',
  'activity_track_reconcile_state',
  'activity_track_revision',
  'activity_track_upload_intent',
  'ai_settings_catalog_definition',
  'ai_settings_catalog_head',
  'ai_settings_head',
  'ai_settings_revision',
  'approval_app_admission_binding',
  'candidate_app_admission_binding',
  'check_in',
  'check_in_collection_head',
  'check_in_receipt',
  'check_in_revision',
  'coaching_analysis_output',
  'coaching_candidate',
  'coaching_constraint',
  'coaching_constraint_head',
  'coaching_decision',
  'coaching_message',
  'coaching_proposal',
  'coaching_run',
  'coaching_thread',
  'command_receipt',
  'consent',
  'core_evidence_snapshot',
  'course',
  'course_accessibility_note',
  'course_deletion',
  'course_disclosure_receipt',
  'course_preference',
  'course_privacy_zone',
  'course_privacy_zone_share_offset',
  'course_revision',
  'course_revision_source',
  'course_route_candidate_set',
  'course_route_proposal',
  'course_share',
  'course_share_area_budget',
  'course_share_audit',
  'course_share_rate',
  'course_thumbnail',
  'course_thumbnail_object_ref',
  'course_thumbnail_reconcile_state',
  'evidence_app_admission_binding',
  'food_definition_head',
  'food_definition_version',
  'gallery_media_derivative',
  'gallery_media_item',
  'gallery_media_object',
  'gallery_upload_intent',
  'garmin_activity_ledger',
  'garmin_activity_ledger_source',
  'garmin_attempt',
  'garmin_connection',
  'garmin_unofficial_connection',
  'garmin_unofficial_run',
  'healthkit_deregistration_work',
  'healthkit_existing_binding',
  'healthkit_workout_batch_receipt',
  'healthkit_workout_claim',
  'healthkit_workout_deregistration',
  'healthkit_workout_lineage',
  'healthkit_workout_registration_receipt',
  'healthkit_workout_registry_head',
  'healthkit_workout_sample',
  'identity_private.account',
  'identity_private.login_attempt',
  'identity_private.logout_token_replay',
  'identity_private.native_exchange_code',
  'identity_private.native_login_attempt',
  'identity_private.session',
  'intake_entry',
  'intake_entry_revision',
  'integrated_approval_v4',
  'integrated_candidate_app_admission_binding',
  'integrated_candidate_v4',
  'integrated_dependency_head',
  'nutrition_plan_head',
  'nutrition_plan_history',
  'nutrition_plan_version',
  'object_scope_purge',
  'openai_budget_activation',
  'openai_budget_fx_definition',
  'openai_budget_journal',
  'openai_budget_month',
  'openai_budget_price_definition',
  'openai_budget_reservation',
  'operations_audit',
  'outbox',
  'plan_head',
  'plan_history',
  'plan_scenario',
  'plan_scenario_application',
  'plan_scenario_revision',
  'plan_snapshot',
  'race_collection_head',
  'race_command_receipt',
  'race_event',
  'race_event_revision',
  'race_manual_review',
  'race_manual_review_source_ref',
  'race_manual_review_source_suppression',
  'race_result',
  'race_result_revision',
  'recovery_action_log',
  'recovery_action_revision',
  'recovery_method_head',
  'recovery_method_version',
  'recovery_strategy_head',
  'recovery_strategy_history',
  'recovery_strategy_version',
  'resource',
  'resource_access_audit',
  'resource_citation',
  'resource_derived_cleanup',
  'resource_grounding',
  'resource_grounding_excerpt',
  'resource_object',
  'resource_object_cleanup',
  'resource_passage',
  'resource_retrieval_cache',
  'resource_share',
  'resource_upload_intent',
  'resource_url_artifact',
  'resource_url_fetch_hop',
  'resource_url_ingestion',
  'resource_url_ingestion_attempt',
  'resource_url_locator',
  'resource_url_provenance',
  'resource_version',
  'restore_activity_replay_receipt',
  'restore_actual_deletion_replay_context',
  'restore_actual_deletion_replay_receipt',
  'restore_ai_consent_replay_receipt',
  'restore_app_consent_replay_receipt',
  'restore_check_in_replay_receipt',
  'restore_course_share_replay_context',
  'restore_course_share_replay_receipt',
  'restore_course_share_revoke_pending',
  'restore_erasure_share_replay_receipt',
  'restore_exact_replay_receipt',
  'restore_gallery_media_replay_receipt',
  'restore_generation',
  'restore_healthkit_consent_replay_receipt',
  'restore_healthkit_deregistration_replay_receipt',
  'restore_manual_review_source_replay_receipt',
  'restore_processing_admission',
  'restore_processing_close_receipt',
  'restore_race_deletion_replay_receipt',
  'restore_resource_compound_replay_receipt',
  'restore_resource_replay_receipt',
  'restore_resource_share_replay_receipt',
  'restore_share_erasure_context',
  'restore_suppression_event',
  'routine_blueprint_head',
  'routine_blueprint_version',
  'routine_checklist_confirmation',
  'routine_command_receipt',
  'routine_occurrence',
  'routine_run',
  'routine_run_revision',
  'routine_schedule_head',
  'routine_schedule_history',
  'routine_schedule_version',
  'routine_step_timer',
  'routing_admission',
  'run_app_admission_binding',
  'schema_migrations',
  'session_completion',
  'session_completion_collection_head',
  'session_completion_receipt',
  'session_completion_revision',
  'stretch_profile',
  'stretching_log',
  'stretching_log_revision',
  'supplementary_execution',
  'supplementary_exercise_head',
  'supplementary_exercise_version',
  'supplementary_rest_timer',
  'supplementary_routine_head',
  'supplementary_routine_target_ref',
  'supplementary_routine_version',
  'supplementary_session_link',
  'supplementary_session_target_ref',
  'supplementary_set_log',
  'supplementary_set_log_revision',
  'tenant_erasure',
  'tenant_object_purge',
  'tenant_work_index',
  'training_best',
  'training_best_revision',
] as const;
export const CURRENT_PARENT_TYPED_RELATIONS = [
  'identity_private.account',
  'consent',
  'tenant_erasure',
  'food_definition_version',
  'food_definition_head',
  'supplementary_exercise_version',
  'supplementary_exercise_head',
  'recovery_method_version',
  'recovery_method_head',
  'supplementary_routine_version',
  'supplementary_routine_head',
  'supplementary_routine_target_ref',
  'activity_canonical',
  'activity_source_revision',
  'activity_source_head',
  'activity_overlay_revision',
  'activity_overlay',
  'activity_suppression',
  'activity_track_object',
  'activity_track',
  'activity_track_revision',
  'activity_track_object_ref',
  'course',
  'course_revision',
  'course_revision_source',
  'course_deletion',
  'resource',
  'resource_version',
  'resource_object',
  'gallery_media_item',
  'gallery_media_derivative',
  'gallery_media_object',
  'plan_snapshot',
  'supplementary_session_link',
  'supplementary_session_target_ref',
  'plan_history',
  'plan_head',
  'nutrition_plan_version',
  'nutrition_plan_history',
  'nutrition_plan_head',
  'recovery_strategy_version',
  'recovery_strategy_history',
  'recovery_strategy_head',
  'routine_blueprint_version',
  'routine_blueprint_head',
  'routine_schedule_version',
  'routine_schedule_history',
  'routine_schedule_head',
  'routine_occurrence',
  'routine_run',
  'routine_run_revision',
  'routine_checklist_confirmation',
  'routine_step_timer',
  'routine_command_receipt',
  'session_completion',
  'session_completion_revision',
  'session_completion_receipt',
  'session_completion_collection_head',
  'intake_entry',
  'intake_entry_revision',
  'check_in',
  'check_in_revision',
  'check_in_receipt',
  'check_in_collection_head',
  'recovery_action_log',
  'recovery_action_revision',
  'coaching_thread',
  'coaching_message',
  'core_evidence_snapshot',
  'coaching_run',
  'coaching_analysis_output',
  'coaching_decision',
  'coaching_proposal',
  'coaching_candidate',
  'integrated_candidate_v4',
  'integrated_approval_v4',
  'command_receipt',
  'evidence_app_admission_binding',
  'run_app_admission_binding',
  'candidate_app_admission_binding',
  'integrated_candidate_app_admission_binding',
  'approval_app_admission_binding',
  'race_event',
  'race_event_revision',
  'race_result',
  'race_result_revision',
  'training_best',
  'training_best_revision',
  'race_command_receipt',
  'race_collection_head',
  'integrated_dependency_head',
  'coaching_constraint_head',
  'coaching_constraint',
  'outbox',
] as const;
const rowSchema = z.discriminatedUnion('relation', [
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('identity_private.account'),
    row: schemas['identity_private.account'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('consent'),
    row: schemas['consent'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('tenant_erasure'),
    row: schemas['tenant_erasure'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('food_definition_version'),
    row: schemas['food_definition_version'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('food_definition_head'),
    row: schemas['food_definition_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('supplementary_exercise_version'),
    row: schemas['supplementary_exercise_version'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('supplementary_exercise_head'),
    row: schemas['supplementary_exercise_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('recovery_method_version'),
    row: schemas['recovery_method_version'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('recovery_method_head'),
    row: schemas['recovery_method_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('supplementary_routine_version'),
    row: schemas['supplementary_routine_version'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('supplementary_routine_head'),
    row: schemas['supplementary_routine_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('supplementary_routine_target_ref'),
    row: schemas['supplementary_routine_target_ref'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('activity_canonical'),
    row: schemas['activity_canonical'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('activity_source_revision'),
    row: schemas['activity_source_revision'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('activity_source_head'),
    row: schemas['activity_source_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('activity_overlay_revision'),
    row: schemas['activity_overlay_revision'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('activity_overlay'),
    row: schemas['activity_overlay'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('activity_suppression'),
    row: schemas['activity_suppression'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('activity_track_object'),
    row: schemas['activity_track_object'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('activity_track'),
    row: schemas['activity_track'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('activity_track_revision'),
    row: schemas['activity_track_revision'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('activity_track_object_ref'),
    row: schemas['activity_track_object_ref'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('course'),
    row: schemas['course'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('course_revision'),
    row: schemas['course_revision'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('course_revision_source'),
    row: schemas['course_revision_source'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('course_deletion'),
    row: schemas['course_deletion'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('resource'),
    row: schemas['resource'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('resource_version'),
    row: schemas['resource_version'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('resource_object'),
    row: schemas['resource_object'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('gallery_media_item'),
    row: schemas['gallery_media_item'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('gallery_media_derivative'),
    row: schemas['gallery_media_derivative'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('gallery_media_object'),
    row: schemas['gallery_media_object'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('plan_snapshot'),
    row: schemas['plan_snapshot'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('supplementary_session_link'),
    row: schemas['supplementary_session_link'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('supplementary_session_target_ref'),
    row: schemas['supplementary_session_target_ref'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('plan_history'),
    row: schemas['plan_history'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('plan_head'),
    row: schemas['plan_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('nutrition_plan_version'),
    row: schemas['nutrition_plan_version'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('nutrition_plan_history'),
    row: schemas['nutrition_plan_history'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('nutrition_plan_head'),
    row: schemas['nutrition_plan_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('recovery_strategy_version'),
    row: schemas['recovery_strategy_version'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('recovery_strategy_history'),
    row: schemas['recovery_strategy_history'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('recovery_strategy_head'),
    row: schemas['recovery_strategy_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('routine_blueprint_version'),
    row: schemas['routine_blueprint_version'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('routine_blueprint_head'),
    row: schemas['routine_blueprint_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('routine_schedule_version'),
    row: schemas['routine_schedule_version'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('routine_schedule_history'),
    row: schemas['routine_schedule_history'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('routine_schedule_head'),
    row: schemas['routine_schedule_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('routine_occurrence'),
    row: schemas['routine_occurrence'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('routine_run'),
    row: schemas['routine_run'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('routine_run_revision'),
    row: schemas['routine_run_revision'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('routine_checklist_confirmation'),
    row: schemas['routine_checklist_confirmation'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('routine_step_timer'),
    row: schemas['routine_step_timer'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('routine_command_receipt'),
    row: schemas['routine_command_receipt'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('session_completion'),
    row: schemas['session_completion'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('session_completion_revision'),
    row: schemas['session_completion_revision'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('session_completion_receipt'),
    row: schemas['session_completion_receipt'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('session_completion_collection_head'),
    row: schemas['session_completion_collection_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('intake_entry'),
    row: schemas['intake_entry'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('intake_entry_revision'),
    row: schemas['intake_entry_revision'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('check_in'),
    row: schemas['check_in'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('check_in_revision'),
    row: schemas['check_in_revision'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('check_in_receipt'),
    row: schemas['check_in_receipt'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('check_in_collection_head'),
    row: schemas['check_in_collection_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('recovery_action_log'),
    row: schemas['recovery_action_log'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('recovery_action_revision'),
    row: schemas['recovery_action_revision'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('coaching_thread'),
    row: schemas['coaching_thread'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('coaching_message'),
    row: schemas['coaching_message'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('core_evidence_snapshot'),
    row: schemas['core_evidence_snapshot'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('coaching_run'),
    row: schemas['coaching_run'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('coaching_analysis_output'),
    row: schemas['coaching_analysis_output'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('coaching_decision'),
    row: schemas['coaching_decision'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('coaching_proposal'),
    row: schemas['coaching_proposal'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('coaching_candidate'),
    row: schemas['coaching_candidate'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('integrated_candidate_v4'),
    row: schemas['integrated_candidate_v4'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('integrated_approval_v4'),
    row: schemas['integrated_approval_v4'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('command_receipt'),
    row: schemas['command_receipt'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('evidence_app_admission_binding'),
    row: schemas['evidence_app_admission_binding'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('run_app_admission_binding'),
    row: schemas['run_app_admission_binding'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('candidate_app_admission_binding'),
    row: schemas['candidate_app_admission_binding'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('integrated_candidate_app_admission_binding'),
    row: schemas['integrated_candidate_app_admission_binding'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('approval_app_admission_binding'),
    row: schemas['approval_app_admission_binding'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('race_event'),
    row: schemas['race_event'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('race_event_revision'),
    row: schemas['race_event_revision'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('race_result'),
    row: schemas['race_result'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('race_result_revision'),
    row: schemas['race_result_revision'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('training_best'),
    row: schemas['training_best'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('training_best_revision'),
    row: schemas['training_best_revision'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('race_command_receipt'),
    row: schemas['race_command_receipt'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('race_collection_head'),
    row: schemas['race_collection_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('integrated_dependency_head'),
    row: schemas['integrated_dependency_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('coaching_constraint_head'),
    row: schemas['coaching_constraint_head'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('coaching_constraint'),
    row: schemas['coaching_constraint'],
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('outbox'),
    row: schemas['outbox'],
  }),
]);
export type CurrentParentTypedRow = z.infer<typeof rowSchema>;
// Successor structural codec for complete physical capture; historical signed
// parent artifacts continue to use the unchanged finite-float V1 row schema.
const coursePhysicalRowV2 = z.strictObject({
  ordinal: integer.min(1),
  relation: z.literal('course_revision'),
  row: schemas.course_revision.extend({
    distance_meters: z.union([
      z
        .number()
        .finite()
        .refine((value) => !Object.is(value, -0)),
      z.enum(['-0', 'NaN', 'Infinity', '-Infinity']),
    ]),
  }),
});
const physicalRowSchemaV2 = z.union([
  coursePhysicalRowV2,
  rowSchema.refine((entry) => entry.relation !== 'course_revision'),
]);
export type CurrentParentPhysicalRowV2 = z.infer<typeof physicalRowSchemaV2>;
const primaryKeys: Record<CurrentParentTypedRow['relation'], readonly string[]> = {
  'identity_private.account': ['athlete_id'],
  consent: ['athlete_id', 'kind'],
  tenant_erasure: ['athlete_id'],
  food_definition_version: ['athlete_id', 'version_id'],
  food_definition_head: ['athlete_id', 'food_id'],
  supplementary_exercise_version: ['athlete_id', 'version_id'],
  supplementary_exercise_head: ['athlete_id', 'exercise_id'],
  recovery_method_version: ['athlete_id', 'version_id'],
  recovery_method_head: ['athlete_id', 'method_id'],
  supplementary_routine_version: ['athlete_id', 'version_id'],
  supplementary_routine_head: ['athlete_id', 'routine_id'],
  supplementary_routine_target_ref: ['athlete_id', 'routine_version_id', 'target_set_id'],
  activity_canonical: ['athlete_id', 'id'],
  activity_source_revision: ['athlete_id', 'kind', 'source_id', 'source_revision'],
  activity_source_head: ['athlete_id', 'kind', 'source_id'],
  activity_overlay_revision: ['athlete_id', 'activity_id', 'revision'],
  activity_overlay: ['athlete_id', 'activity_id'],
  activity_suppression: ['athlete_id', 'kind', 'source_id'],
  activity_track_object: ['athlete_id', 'storage_ref'],
  activity_track: ['athlete_id', 'activity_id'],
  activity_track_revision: ['athlete_id', 'activity_id', 'track_revision'],
  activity_track_object_ref: ['storage_ref'],
  course: ['athlete_id', 'course_id'],
  course_revision: ['athlete_id', 'course_id', 'course_revision'],
  course_revision_source: [
    'athlete_id',
    'course_id',
    'course_revision',
    'activity_id',
    'track_id',
    'track_revision',
  ],
  course_deletion: ['athlete_id', 'course_id'],
  resource: ['athlete_id', 'id'],
  resource_version: ['athlete_id', 'version_id'],
  resource_object: ['athlete_id', 'storage_ref'],
  gallery_media_item: ['athlete_id', 'id'],
  gallery_media_derivative: ['athlete_id', 'media_item_id', 'kind'],
  gallery_media_object: ['athlete_id', 'storage_ref'],
  plan_snapshot: ['athlete_id', 'id'],
  supplementary_session_link: ['athlete_id', 'plan_version_id', 'planned_session_id'],
  supplementary_session_target_ref: [
    'athlete_id',
    'plan_version_id',
    'planned_session_id',
    'target_set_id',
  ],
  plan_history: ['athlete_id', 'version_id'],
  plan_head: ['athlete_id'],
  nutrition_plan_version: ['athlete_id', 'version_id'],
  nutrition_plan_history: ['athlete_id', 'version_id'],
  nutrition_plan_head: ['athlete_id', 'plan_id'],
  recovery_strategy_version: ['athlete_id', 'version_id'],
  recovery_strategy_history: ['athlete_id', 'version_id'],
  recovery_strategy_head: ['athlete_id', 'strategy_id'],
  routine_blueprint_version: ['athlete_id', 'version_id'],
  routine_blueprint_head: ['athlete_id', 'routine_id'],
  routine_schedule_version: ['athlete_id', 'version_id'],
  routine_schedule_history: ['athlete_id', 'version_id'],
  routine_schedule_head: ['athlete_id', 'schedule_id'],
  routine_occurrence: ['athlete_id', 'id'],
  routine_run: ['athlete_id', 'id'],
  routine_run_revision: ['athlete_id', 'run_id', 'revision'],
  routine_checklist_confirmation: ['athlete_id', 'id'],
  routine_step_timer: ['athlete_id', 'run_id', 'step_id'],
  routine_command_receipt: ['athlete_id', 'idempotency_key'],
  session_completion: ['athlete_id', 'session_id'],
  session_completion_revision: ['athlete_id', 'session_id', 'revision'],
  session_completion_receipt: ['athlete_id', 'idempotency_key'],
  session_completion_collection_head: ['athlete_id'],
  intake_entry: ['athlete_id', 'id'],
  intake_entry_revision: ['athlete_id', 'intake_id', 'revision'],
  check_in: ['athlete_id', 'id'],
  check_in_revision: ['athlete_id', 'check_in_id', 'revision'],
  check_in_receipt: ['athlete_id', 'idempotency_key'],
  check_in_collection_head: ['athlete_id'],
  recovery_action_log: ['athlete_id', 'action_id'],
  recovery_action_revision: ['athlete_id', 'action_id', 'revision'],
  coaching_thread: ['athlete_id', 'id'],
  coaching_message: ['athlete_id', 'id'],
  core_evidence_snapshot: ['athlete_id', 'id'],
  coaching_run: ['athlete_id', 'id'],
  coaching_analysis_output: ['athlete_id', 'id'],
  coaching_decision: ['athlete_id', 'id'],
  coaching_proposal: ['athlete_id', 'id'],
  coaching_candidate: ['athlete_id', 'id'],
  integrated_candidate_v4: ['athlete_id', 'id'],
  integrated_approval_v4: ['athlete_id', 'approval_id'],
  command_receipt: ['athlete_id', 'idempotency_key'],
  evidence_app_admission_binding: ['athlete_id', 'evidence_snapshot_id'],
  run_app_admission_binding: ['athlete_id', 'run_id'],
  candidate_app_admission_binding: ['athlete_id', 'candidate_id'],
  integrated_candidate_app_admission_binding: ['athlete_id', 'candidate_id'],
  approval_app_admission_binding: ['athlete_id', 'receipt_key'],
  race_event: ['athlete_id', 'id'],
  race_event_revision: ['athlete_id', 'entity_id', 'revision'],
  race_result: ['athlete_id', 'id'],
  race_result_revision: ['athlete_id', 'entity_id', 'revision'],
  training_best: ['athlete_id', 'id'],
  training_best_revision: ['athlete_id', 'entity_id', 'revision'],
  race_command_receipt: ['athlete_id', 'idempotency_key'],
  race_collection_head: ['athlete_id', 'kind'],
  integrated_dependency_head: ['athlete_id'],
  coaching_constraint_head: ['athlete_id'],
  coaching_constraint: ['athlete_id', 'id'],
  outbox: ['athlete_id', 'id'],
};
/** Root's empty normal107+raw108..116 catalog metadata pin, not live source proof. */
export const CURRENT_PARENT_PHYSICAL_PROFILE_SHA256 =
  'f19120b86e54c2a4709763131867ea26c4153ef59ce3d11777f1f9bb54f9214f';

const censusSchema = z
  .array(
    z.strictObject({
      relation: z.enum(CURRENT_PARENT_RELATIONS),
      count: z.number().int().min(0).max(CURRENT_PARENT_MAX_ROWS),
    }),
  )
  .length(CURRENT_PARENT_RELATIONS.length);
const configuredSchema = z.strictObject({
  profile: z.strictObject({
    profileVersion: z.literal(1),
    normalSchemaVersion: z.literal(107),
    explicitVersions: z.tuple([
      z.literal(108),
      z.literal(109),
      z.literal(110),
      z.literal(111),
      z.literal(112),
      z.literal(113),
      z.literal(114),
      z.literal(115),
      z.literal(116),
    ]),
    rowEncoding: z.literal('utc-microseconds-decimal-bigint-hex-bytea-v1'),
    physicalProfileSha256: z.literal(CURRENT_PARENT_PHYSICAL_PROFILE_SHA256),
  }),
  source: z.strictObject({
    systemIdentifier: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .refine((v) => BigInt(v) <= 18446744073709551615n),
    databaseOid: z.number().int().min(1).max(4294967295),
    captureId: uuid,
    generationId: uuid,
    registrySha256: hash,
    catalogSha256: hash,
    baselineThroughLsn: z.string().regex(/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/),
  }),
  identity: z.strictObject({
    artifactId: uuid,
    athleteId: tenant,
    sourceKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    sourceKeyVersion: positive,
  }),
  count: z.number().int().min(0).max(CURRENT_PARENT_MAX_ROWS),
  census: censusSchema,
  rowsSha256: hash,
});
export type CurrentParentConfiguredIdentity = z.infer<typeof configuredSchema>;
const bodySchema = configuredSchema
  .extend({
    artifactVersion: z.literal(1),
    rows: z.array(rowSchema).max(CURRENT_PARENT_MAX_ROWS),
    sourceCapture: z.literal('not_verified'),
    sqlRowEncoding: z.literal('not_verified'),
    originalTailCoverage: z.literal('not_authenticated'),
  })
  .strict();
export type CurrentParentArtifactBody = z.infer<typeof bodySchema>;
export class CurrentParentArtifactError extends Error {
  constructor() {
    super('INVALID_CURRENT_PARENT_ARTIFACT');
  }
}
function reject(): never {
  throw new CurrentParentArtifactError();
}
function plain(value: unknown, maximum: number): void {
  const active = new WeakSet<object>();
  let nodes = 0,
    strings = 0;
  function visit(v: unknown, depth: number): void {
    if (++nodes > maximum + 1 || depth > 64) reject();
    if (
      v === null ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0))
    )
      return;
    if (typeof v === 'string') {
      strings += Buffer.byteLength(v, 'utf8');
      if (strings > maximum) reject();
      return;
    }
    if (typeof v !== 'object' || active.has(v) || Object.getOwnPropertySymbols(v).length) reject();
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) reject();
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length || Object.getOwnPropertyNames(v).length !== v.length + 1)
    )
      reject();
    active.add(v);
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && key === 'length') continue;
      strings += Buffer.byteLength(key, 'utf8');
      if (strings > maximum || !d.enumerable || !('value' in d)) reject();
      visit(d.value, depth + 1);
    }
    active.delete(v);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum) reject();
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  const s = JSON.stringify(v);
  if (s === undefined) reject();
  return s;
}
function checksum(v: unknown): string {
  return createHash('sha256').update(canonical(v), 'utf8').digest('hex');
}
function preflightRows(raw: unknown): void {
  plain(raw, CURRENT_PARENT_MAX_TOTAL_BYTES);
  if (!Array.isArray(raw) || raw.length > CURRENT_PARENT_MAX_ROWS) reject();
  const entryBoundary = z.strictObject({
    ordinal: z.unknown(),
    relation: z.unknown(),
    row: z.unknown(),
  });
  for (const entry of raw) {
    const parsed = entryBoundary.safeParse(entry);
    if (!parsed.success) reject();
    plain(parsed.data.row, CURRENT_PARENT_MAX_ROW_BYTES);
  }
}
function validateRows(raw: unknown): CurrentParentTypedRow[] {
  preflightRows(raw);
  const parsed = z.array(rowSchema).max(CURRENT_PARENT_MAX_ROWS).safeParse(raw);
  if (!parsed.success) reject();
  return validatePhysicalRowOrder(parsed.data, raw);
}
function validatePhysicalRowOrder<T extends CurrentParentPhysicalRowV2>(
  rows: T[],
  raw: unknown,
): T[] {
  if (canonical(rows) !== canonical(raw)) reject();
  let previousRelation = -1,
    previousKey = '';
  const seen = new Set<string>();
  for (const [i, entry] of rows.entries()) {
    plain(entry.row, CURRENT_PARENT_MAX_ROW_BYTES);
    if (entry.ordinal !== i + 1) reject();
    const values = z.record(z.string(), z.unknown()).parse(entry.row);
    const key = canonical(primaryKeys[entry.relation].map((k) => values[k]));
    const index = CURRENT_PARENT_RELATIONS.indexOf(entry.relation);
    if (index < previousRelation || (index === previousRelation && key <= previousKey)) reject();
    const qualified = canonical([entry.relation, key]);
    if (seen.has(qualified)) reject();
    seen.add(qualified);
    previousRelation = index;
    previousKey = key;
  }
  return rows;
}
/** Structural physical parsing only; no source, census, or admission authority. */
export function parseCurrentParentPhysicalRows(raw: unknown): CurrentParentTypedRow[] {
  return validateRows(raw);
}
/** Complete physical successor; parsing grants no source or restore authority. */
export function parseCurrentParentPhysicalRowsV2(raw: unknown): CurrentParentPhysicalRowV2[] {
  preflightRows(raw);
  const parsed = z.array(physicalRowSchemaV2).max(CURRENT_PARENT_MAX_ROWS).safeParse(raw);
  if (!parsed.success) reject();
  return validatePhysicalRowOrder(parsed.data, raw);
}
export function currentParentRowsSha256(raw: unknown): string {
  return checksum(validateRows(raw));
}
function validateBody(raw: unknown): CurrentParentArtifactBody {
  plain(raw, CURRENT_PARENT_MAX_TOTAL_BYTES);
  const boundary = z.object({ rows: z.unknown() }).safeParse(raw);
  if (!boundary.success) reject();
  preflightRows(boundary.data.rows);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success || canonical(parsed.data) !== canonical(raw)) reject();
  const body = parsed.data;
  validateRows(body.rows);
  if (checksum(body.rows) !== body.rowsSha256) reject();
  const actual = new Map<string, number>();
  for (const entry of body.rows) {
    if (entry.row.athlete_id !== body.identity.athleteId) reject();
    actual.set(entry.relation, (actual.get(entry.relation) ?? 0) + 1);
  }
  let count = 0;
  for (const [i, partition] of body.census.entries()) {
    if (partition.relation !== CURRENT_PARENT_RELATIONS[i]) reject();
    count += partition.count;
    if (count > CURRENT_PARENT_MAX_ROWS) reject();
    // Typed supported partitions are exact; unsupported partitions never receive
    // a generic row codec, even when their signed census declares nonzero rows.
    if (
      Object.hasOwn(schemas, partition.relation) &&
      (actual.get(partition.relation) ?? 0) !== partition.count
    )
      reject();
  }
  if (count !== body.count) reject();
  return body;
}
/** Sign bytes only. Supplying a key does not capture live SQL rows or authorize restore. */
export function signCurrentParentArtifact(raw: unknown, key: Uint8Array): Uint8Array {
  const body = validateBody(raw);
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) reject();
  const hmacSha256 = createHmac('sha256', key).update(domain).update(canonical(body)).digest('hex');
  return Buffer.from(canonical({ body, hmacSha256 }), 'utf8');
}
export interface VerifiedCurrentParentBytes {
  readonly kind: 'verified_current_parent_bytes';
  readonly parentClosure: 'blocked';
  readonly sqlStage: 'unavailable';
  readonly authority: 'none';
  readonly admissionAllowed: false;
}
export type CurrentParentArtifactLimits = Readonly<{
  parentClosure: 'blocked';
  reason: 'parent_partitions_unimplemented' | 'source_catalog_census_not_authenticated';
  unsupportedPartitions: readonly Readonly<{
    relation: (typeof CURRENT_PARENT_RELATIONS)[number];
    count: number;
  }>[];
  sourceCapture: 'not_verified';
  sourceCatalogCensus: 'not_authenticated';
  sqlRowEncoding: 'not_verified';
  domainConstraints: 'not_verified';
  sqlStage: 'unavailable';
  originalTailStage: 'unavailable';
  historicalSeals: 'audit_only';
  authority: 'none';
  admissionAllowed: false;
}>;
/** Factory-local byte handle. All trusted configuration is copied. Revocation is
 * consulted at prepare AND callback use; caller flags and child handles cannot pass. */
export function createCurrentParentArtifactVerifier(configuration: {
  readonly expected: CurrentParentConfiguredIdentity;
  readonly resolveSourceKey: (id: string, version: number) => Uint8Array;
}) {
  plain(configuration.expected, CURRENT_PARENT_MAX_TOTAL_BYTES);
  const expected = configuredSchema.parse(configuration.expected);
  if (canonical(expected) !== canonical(configuration.expected)) reject();
  const pinned = canonical(expected),
    resolveSourceKey = configuration.resolveSourceKey;
  const verified = new WeakMap<
    VerifiedCurrentParentBytes,
    { body: CurrentParentArtifactBody; keyDigest: string }
  >();
  function key(): Uint8Array {
    const value = resolveSourceKey(
      expected.identity.sourceKeyId,
      expected.identity.sourceKeyVersion,
    );
    if (!(value instanceof Uint8Array) || value.byteLength !== 32) reject();
    return Uint8Array.from(value);
  }
  function prepareVerifiedCurrentParentArtifact(bytes: Uint8Array): VerifiedCurrentParentBytes {
    try {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > CURRENT_PARENT_MAX_TOTAL_BYTES + 256)
        reject();
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const wrapper = z
        .strictObject({ body: z.unknown(), hmacSha256: hash })
        .parse(JSON.parse(decoded));
      const body = validateBody(wrapper.body);
      if (decoded !== canonical({ body, hmacSha256: wrapper.hmacSha256 })) reject();
      const {
        artifactVersion,
        rows,
        sourceCapture,
        sqlRowEncoding,
        originalTailCoverage,
        ...identity
      } = body;
      void artifactVersion;
      void rows;
      void sourceCapture;
      void sqlRowEncoding;
      void originalTailCoverage;
      if (canonical(identity) !== pinned) reject();
      const sourceKey = key();
      const wanted = createHmac('sha256', sourceKey)
        .update(domain)
        .update(canonical(body))
        .digest();
      if (!timingSafeEqual(wanted, Buffer.from(wrapper.hmacSha256, 'hex'))) reject();
      const handle: VerifiedCurrentParentBytes = Object.freeze({
        kind: 'verified_current_parent_bytes',
        parentClosure: 'blocked',
        sqlStage: 'unavailable',
        authority: 'none',
        admissionAllowed: false,
      });
      verified.set(handle, {
        body,
        keyDigest: createHash('sha256').update(sourceKey).digest('hex'),
      });
      return handle;
    } catch {
      reject();
    }
  }
  function withVerifiedCurrentParentArtifact<T>(
    handle: VerifiedCurrentParentBytes,
    consume: (body: Readonly<CurrentParentArtifactBody>, limits: CurrentParentArtifactLimits) => T,
  ): T {
    const state = verified.get(handle);
    if (!state) reject();
    let currentKey: Uint8Array;
    try {
      currentKey = key();
    } catch {
      reject();
    }
    if (createHash('sha256').update(currentKey).digest('hex') !== state.keyDigest) reject();
    const body = validateBody(JSON.parse(canonical(state.body)));
    const unsupportedPartitions = body.census.filter(
      (p) => !Object.hasOwn(schemas, p.relation) && p.count > 0,
    );
    return consume(
      body,
      Object.freeze({
        parentClosure: 'blocked',
        reason: unsupportedPartitions.length
          ? 'parent_partitions_unimplemented'
          : 'source_catalog_census_not_authenticated',
        unsupportedPartitions,
        sourceCapture: 'not_verified',
        sourceCatalogCensus: 'not_authenticated',
        sqlRowEncoding: 'not_verified',
        domainConstraints: 'not_verified',
        sqlStage: 'unavailable',
        originalTailStage: 'unavailable',
        historicalSeals: 'audit_only',
        authority: 'none',
        admissionAllowed: false,
      }),
    );
  }
  return Object.freeze({ prepareVerifiedCurrentParentArtifact, withVerifiedCurrentParentArtifact });
}

import { z } from 'zod';

/** v3 is deliberately incompatible with earlier native hosts. */
export const nativeBridgeVersion = 3 as const;

const requestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const athleteIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const revisionSchema = z.number().int().nonnegative().max(2_147_483_646);
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const nativeBridgeCapabilitiesSchema = z.strictObject({
  'app.openSettings': z.boolean(),
  'healthkit.read': z.literal(false),
  /** Device support only; this says nothing about OS read access or server consent. */
  'healthkit.workouts': z.boolean(),
  'auth.transport': z.boolean(),
});

const nativeBridgeCommandMethodSchema = z.enum([
  'app.openSettings',
  'auth.signIn',
  'auth.session',
  'auth.signOut',
  'api.read',
  'api.healthkitConsent.write',
  'healthkit.workouts.requestAccess',
  'healthkit.workouts.status',
]);

export const nativeBridgeReadPathSchema = z.enum([
  '/bff/v1/session',
  '/bff/v1/consents/ai',
  '/bff/v1/consents/healthkit',
]);
export const nativeBridgeApiSessionSchema = z.strictObject({ athleteId: athleteIdSchema });
export const nativeBridgeAiConsentSchema = z.strictObject({
  kind: z.literal('ai'),
  granted: z.boolean(),
  revision: z.number().int().nonnegative().safe(),
});
export const nativeBridgeHealthKitConsentSchema = z.strictObject({
  kind: z.literal('healthkit'),
  granted: z.boolean(),
  revision: z.number().int().nonnegative().safe(),
});
export const nativeBridgeHealthKitConsentWriteSchema = z.strictObject({
  granted: z.boolean(),
  expectedRevision: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
});
export const nativeBridgeHealthKitStatusSchema = z.strictObject({
  requestState: z.enum(['not_requested', 'requested']),
  pendingCount: z.number().int().min(0).max(256),
  pauseReason: z.enum(['forbidden', 'conflict', 'rejected']).nullable(),
});

export const nativeBridgeSessionSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('signed_out') }),
  z.strictObject({
    state: z.literal('signed_in'),
    athleteId: athleteIdSchema,
    expiresAt: z.iso.datetime({ offset: true }),
  }),
]);

const requestBase = {
  kind: z.literal('command'),
  version: z.literal(nativeBridgeVersion),
  id: requestIdSchema,
};
const replyBase = {
  kind: z.literal('command.result'),
  version: z.literal(nativeBridgeVersion),
  id: requestIdSchema,
};

export const nativeBridgeRequestSchema = z.union([
  z.strictObject({
    kind: z.literal('hello'),
    version: z.literal(nativeBridgeVersion),
    id: requestIdSchema,
  }),
  z.strictObject({
    ...requestBase,
    method: z.enum([
      'app.openSettings',
      'auth.signIn',
      'auth.session',
      'auth.signOut',
      'healthkit.workouts.requestAccess',
      'healthkit.workouts.status',
    ]),
    payload: z.strictObject({}),
  }),
  z.strictObject({
    ...requestBase,
    method: z.literal('api.read'),
    payload: z.strictObject({ path: nativeBridgeReadPathSchema }),
  }),
  z.strictObject({
    ...requestBase,
    method: z.literal('api.healthkitConsent.write'),
    payload: nativeBridgeHealthKitConsentWriteSchema,
  }),
]);

export const nativeBridgeErrorCodeSchema = z.enum([
  'UNSUPPORTED_VERSION',
  'UNSUPPORTED_METHOD',
  'UNAVAILABLE',
  'INVALID_REQUEST',
  'INVALID_REPLY',
  'LOCAL_RESET_FAILED',
  'TIMEOUT',
  'CANCELLED',
]);

export const nativeBridgeReplySchema = z.union([
  z.strictObject({
    kind: z.literal('hello.result'),
    version: z.literal(nativeBridgeVersion),
    id: requestIdSchema,
    capabilities: nativeBridgeCapabilitiesSchema,
  }),
  z.strictObject({
    ...replyBase,
    method: z.literal('app.openSettings'),
    status: z.literal('opened'),
  }),
  z.strictObject({
    ...replyBase,
    method: z.enum(['auth.signIn', 'auth.session']),
    session: nativeBridgeSessionSchema,
  }),
  z.strictObject({
    ...replyBase,
    method: z.literal('auth.signOut'),
    status: z.literal('signed_out'),
  }),
  z.strictObject({
    ...replyBase,
    method: z.literal('api.read'),
    path: z.literal('/bff/v1/session'),
    status: z.literal(200),
    body: nativeBridgeApiSessionSchema,
  }),
  z.strictObject({
    ...replyBase,
    method: z.literal('api.read'),
    path: z.literal('/bff/v1/consents/ai'),
    status: z.literal(200),
    body: nativeBridgeAiConsentSchema,
  }),
  z.strictObject({
    ...replyBase,
    method: z.literal('api.read'),
    path: z.literal('/bff/v1/consents/healthkit'),
    status: z.literal(200),
    body: nativeBridgeHealthKitConsentSchema,
  }),
  z.strictObject({
    ...replyBase,
    method: z.literal('api.read'),
    path: nativeBridgeReadPathSchema,
    status: z.literal(401),
    body: z.null(),
  }),
  z.strictObject({
    ...replyBase,
    method: z.literal('api.healthkitConsent.write'),
    status: z.literal(200),
    body: nativeBridgeHealthKitConsentSchema,
  }),
  z.strictObject({
    ...replyBase,
    method: z.literal('api.healthkitConsent.write'),
    status: z.literal(401),
    body: z.null(),
  }),
  z.strictObject({
    ...replyBase,
    method: z.literal('api.healthkitConsent.write'),
    status: z.literal(409),
    code: z.literal('CONSENT_CONFLICT'),
    body: z.null(),
  }),
  z.strictObject({
    ...replyBase,
    method: z.literal('healthkit.workouts.requestAccess'),
    status: z.literal('requested'),
  }),
  z.strictObject({
    ...replyBase,
    method: z.literal('healthkit.workouts.status'),
    status: nativeBridgeHealthKitStatusSchema,
  }),
  z.strictObject({
    kind: z.literal('error'),
    version: z.literal(nativeBridgeVersion),
    id: requestIdSchema,
    code: nativeBridgeErrorCodeSchema,
  }),
]);

export type NativeBridgeRequest = z.infer<typeof nativeBridgeRequestSchema>;
export type NativeBridgeReply = z.infer<typeof nativeBridgeReplySchema>;
export type NativeBridgeCapabilities = z.infer<typeof nativeBridgeCapabilitiesSchema>;
export type NativeBridgeErrorCode = z.infer<typeof nativeBridgeErrorCodeSchema>;
export type NativeBridgeSession = z.infer<typeof nativeBridgeSessionSchema>;
export type NativeBridgeReadPath = z.infer<typeof nativeBridgeReadPathSchema>;
export type NativeBridgeHealthKitStatus = z.infer<typeof nativeBridgeHealthKitStatusSchema>;
export type NativeBridgeHealthKitConsentWrite = z.infer<
  typeof nativeBridgeHealthKitConsentWriteSchema
>;

export type NativeBridgeRequestValidation =
  | { ok: true; request: NativeBridgeRequest }
  | { ok: false; code: 'UNSUPPORTED_VERSION' | 'UNSUPPORTED_METHOD' | 'INVALID_REQUEST' };

/** Host-side ingress helper; never dispatches an unknown version or method. */
export function validateNativeBridgeRequest(input: unknown): NativeBridgeRequestValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const value = input as Record<string, unknown>;
  if (value.version !== nativeBridgeVersion) return { ok: false, code: 'UNSUPPORTED_VERSION' };
  if (
    value.kind === 'command' &&
    !nativeBridgeCommandMethodSchema.safeParse(value.method).success
  ) {
    return { ok: false, code: 'UNSUPPORTED_METHOD' };
  }
  const parsed = nativeBridgeRequestSchema.safeParse(input);
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, code: 'INVALID_REQUEST' };
}

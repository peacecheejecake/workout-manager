import { z } from 'zod';

/** This v2 protocol is separate from the historical core bridge v1. */
export const nativeBridgeVersion = 2 as const;

const requestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const nativeBridgeCapabilitiesSchema = z.strictObject({
  'app.openSettings': z.boolean(),
  'healthkit.read': z.literal(false),
  'auth.transport': z.boolean(),
});

const nativeBridgeCommandMethodSchema = z.enum([
  'app.openSettings',
  'auth.signIn',
  'auth.session',
  'auth.signOut',
  'api.read',
]);

export const nativeBridgeReadPathSchema = z.enum(['/bff/v1/session', '/bff/v1/consents/ai']);

const athleteIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
export const nativeBridgeApiSessionSchema = z.strictObject({ athleteId: athleteIdSchema });
export const nativeBridgeAiConsentSchema = z.strictObject({
  kind: z.literal('ai'),
  granted: z.boolean(),
  revision: z.number().int().nonnegative().safe(),
});

export const nativeBridgeSessionSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('signed_out') }),
  z.strictObject({
    state: z.literal('signed_in'),
    athleteId: athleteIdSchema,
    expiresAt: z.iso.datetime({ offset: true }),
  }),
]);

export const nativeBridgeRequestSchema = z.union([
  z.strictObject({
    kind: z.literal('hello'),
    version: z.literal(nativeBridgeVersion),
    id: requestIdSchema,
  }),
  z.union([
    z.strictObject({
      kind: z.literal('command'),
      version: z.literal(nativeBridgeVersion),
      id: requestIdSchema,
      method: z.enum(['app.openSettings', 'auth.signIn', 'auth.session', 'auth.signOut']),
      payload: z.strictObject({}),
    }),
    z.strictObject({
      kind: z.literal('command'),
      version: z.literal(nativeBridgeVersion),
      id: requestIdSchema,
      method: z.literal('api.read'),
      payload: z.strictObject({ path: nativeBridgeReadPathSchema }),
    }),
  ]),
]);

export const nativeBridgeErrorCodeSchema = z.enum([
  'UNSUPPORTED_VERSION',
  'UNSUPPORTED_METHOD',
  'UNAVAILABLE',
  'INVALID_REQUEST',
  'INVALID_REPLY',
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
  z.union([
    z.strictObject({
      kind: z.literal('command.result'),
      version: z.literal(nativeBridgeVersion),
      id: requestIdSchema,
      method: z.literal('app.openSettings'),
      status: z.literal('opened'),
    }),
    z.strictObject({
      kind: z.literal('command.result'),
      version: z.literal(nativeBridgeVersion),
      id: requestIdSchema,
      method: z.enum(['auth.signIn', 'auth.session']),
      session: nativeBridgeSessionSchema,
    }),
    z.strictObject({
      kind: z.literal('command.result'),
      version: z.literal(nativeBridgeVersion),
      id: requestIdSchema,
      method: z.literal('auth.signOut'),
      status: z.literal('signed_out'),
    }),
    z.union([
      z.strictObject({
        kind: z.literal('command.result'),
        version: z.literal(nativeBridgeVersion),
        id: requestIdSchema,
        method: z.literal('api.read'),
        path: z.literal('/bff/v1/session'),
        status: z.literal(200),
        body: nativeBridgeApiSessionSchema,
      }),
      z.strictObject({
        kind: z.literal('command.result'),
        version: z.literal(nativeBridgeVersion),
        id: requestIdSchema,
        method: z.literal('api.read'),
        path: z.literal('/bff/v1/consents/ai'),
        status: z.literal(200),
        body: nativeBridgeAiConsentSchema,
      }),
      z.strictObject({
        kind: z.literal('command.result'),
        version: z.literal(nativeBridgeVersion),
        id: requestIdSchema,
        method: z.literal('api.read'),
        path: nativeBridgeReadPathSchema,
        status: z.literal(401),
        body: z.null(),
      }),
    ]),
  ]),
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

export type NativeBridgeRequestValidation =
  | { ok: true; request: NativeBridgeRequest }
  | { ok: false; code: 'UNSUPPORTED_VERSION' | 'UNSUPPORTED_METHOD' | 'INVALID_REQUEST' };

/** Host-side ingress helper; never dispatches an unknown version or method. */
export function validateNativeBridgeRequest(input: unknown): NativeBridgeRequestValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const value = input as Record<string, unknown>;
  if (value.version !== nativeBridgeVersion) {
    return { ok: false, code: 'UNSUPPORTED_VERSION' };
  }
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

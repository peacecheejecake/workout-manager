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
]);

export const nativeBridgeSessionSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('signed_out') }),
  z.strictObject({
    state: z.literal('signed_in'),
    athleteId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/),
    expiresAt: z.iso.datetime({ offset: true }),
  }),
]);

export const nativeBridgeRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('hello'),
    version: z.literal(nativeBridgeVersion),
    id: requestIdSchema,
  }),
  z.strictObject({
    kind: z.literal('command'),
    version: z.literal(nativeBridgeVersion),
    id: requestIdSchema,
    method: nativeBridgeCommandMethodSchema,
    payload: z.strictObject({}),
  }),
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
  z.discriminatedUnion('method', [
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

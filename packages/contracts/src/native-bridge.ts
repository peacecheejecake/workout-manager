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
  'auth.transport': z.literal(false),
});

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
    method: z.literal('app.openSettings'),
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

export const nativeBridgeReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('hello.result'),
    version: z.literal(nativeBridgeVersion),
    id: requestIdSchema,
    capabilities: nativeBridgeCapabilitiesSchema,
  }),
  z.strictObject({
    kind: z.literal('command.result'),
    version: z.literal(nativeBridgeVersion),
    id: requestIdSchema,
    method: z.literal('app.openSettings'),
    status: z.literal('opened'),
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
  if (value.kind === 'command' && value.method !== 'app.openSettings') {
    return { ok: false, code: 'UNSUPPORTED_METHOD' };
  }
  const parsed = nativeBridgeRequestSchema.safeParse(input);
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, code: 'INVALID_REQUEST' };
}

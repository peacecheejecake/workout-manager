import { z } from 'zod';

const athleteIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);

export const principalSchema = z.discriminatedUnion('method', [
  z.strictObject({
    athleteId: athleteIdSchema,
    sessionId: z.string().min(1).max(256),
    method: z.literal('cookie'),
    csrfToken: z.string().min(32).max(256),
    expiresAt: z.iso.datetime().optional(),
  }),
  z.strictObject({
    athleteId: athleteIdSchema,
    sessionId: z.string().min(1).max(256),
    method: z.literal('bearer'),
  }),
]);
export type Principal = z.infer<typeof principalSchema>;

/** Implementations verify signature, expiry, revocation and ownership; never decode-only. */
export interface AuthenticationPort {
  authenticate(credentials: { authorization?: string; cookie?: string }): Promise<unknown>;
}

export const consentKindSchema = z.enum(['app', 'provider', 'ai', 'healthkit', 'media']);
export type ConsentKind = z.infer<typeof consentKindSchema>;
export const consentSchema = z.strictObject({
  kind: consentKindSchema,
  granted: z.boolean(),
  revision: z.number().int().nonnegative().safe(),
});
export type Consent = z.infer<typeof consentSchema>;
export const consentWriteSchema = z.strictObject({
  granted: z.boolean(),
  expectedRevision: z.number().int().nonnegative().max(2147483646),
});

export interface ConsentPort {
  getConsent(athleteId: string, kind: ConsentKind): Promise<Consent>;
  setConsent(
    athleteId: string,
    input: z.infer<typeof consentWriteSchema> & { kind: ConsentKind; idempotencyKey: string },
  ): Promise<Consent>;
}

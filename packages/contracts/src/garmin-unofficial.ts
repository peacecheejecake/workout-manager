import { z } from 'zod';

/**
 * The TEMPORARY, UNOFFICIAL in-app Garmin collector (M1-06b-tmp).
 *
 * It is not the official Garmin integration (`./garmin`, M1-06c/M1-06b) and every value that
 * crosses this boundary says so: the provider is `garmin-connect-unofficial` and `official`
 * is the literal `false`. It is available to one deployment-configured owner account only.
 * Nothing here carries a password, an MFA code result, a session token or a Garmin profile
 * identifier; the pinned profile is reported only as a boolean.
 */
export const garminUnofficialProvider = 'garmin-connect-unofficial' as const;

export const garminUnofficialStateSchema = z.enum([
  'not_connected',
  'mfa_required',
  'connected',
  'reconnect_required',
]);
export const garminUnofficialRunStateSchema = z.enum([
  'running',
  'succeeded',
  'partial',
  'rate_limited',
  'reconnect_required',
  'failed_transient',
  'failed_permanent',
  /** The owner disconnected while the run was in progress. */
  'cancelled',
]);
const instant = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative().max(1_000_000);

export const garminUnofficialRunSchema = z.strictObject({
  id: z.uuid(),
  trigger: z.enum(['manual', 'scheduled']),
  state: garminUnofficialRunStateSchema,
  startedAt: instant,
  finishedAt: instant.nullable(),
  listed: count,
  imported: count,
  unchanged: count,
  suppressed: count,
  skipped: count,
  failed: count,
  /** The listing reached the end of the window inside its page budget. Null while running. */
  complete: z.boolean().nullable(),
});

export const garminUnofficialStatusSchema = z.strictObject({
  provider: z.literal(garminUnofficialProvider),
  official: z.literal(false),
  state: garminUnofficialStateSchema,
  connectedAt: instant.nullable(),
  /** A Garmin profile was pinned by the first login; a different profile is refused. */
  profilePinned: z.boolean(),
  /** When the pending MFA step expires (only in `mfa_required`). */
  mfaExpiresAt: instant.nullable(),
  schedule: z.strictObject({
    enabled: z.boolean(),
    /** Paused by a provider rate limit or a permanent failure; only the owner resumes it. */
    paused: z.boolean(),
    intervalHours: z.number().int().positive(),
    nextRunAt: instant.nullable(),
  }),
  /** No run starts before this instant (the provider's Retry-After or a transient backoff). */
  blockedUntil: instant.nullable(),
  /** Login attempts are refused until this instant (rate limit and failure backoff). */
  loginLockedUntil: instant.nullable(),
  runRequested: z.boolean(),
  lastRun: garminUnofficialRunSchema.nullable(),
});

export const garminUnofficialLoginSchema = z.strictObject({
  email: z.string().trim().min(3).max(320),
  // The worker refuses a password it cannot scrub reliably out of provider text (8+).
  password: z.string().min(8).max(1024),
});
export const garminUnofficialMfaSchema = z.strictObject({
  code: z.string().regex(/^\d{4,10}$/),
});
export const garminUnofficialLoginResultSchema = z.strictObject({
  state: z.enum(['connected', 'mfa_required']),
});
export const garminUnofficialScheduleSchema = z.strictObject({ enabled: z.boolean() });
export const garminUnofficialRunRequestResultSchema = z.strictObject({
  requested: z.literal(true),
});

/**
 * Where a stored activity was collected from, when a Garmin collector brought it in.
 * Readable by every account for its own activities and kept after a disconnect or a switch
 * to the official path: the label stays with the data it describes.
 */
export const garminCollectionProviderSchema = z.enum([garminUnofficialProvider, 'garmin-official']);
export const activityCollectionProvenanceSchema = z.strictObject({
  provenance: z
    .strictObject({
      provider: garminCollectionProviderSchema,
      official: z.boolean(),
      garminActivityId: z.string().regex(/^[1-9]\d{0,23}$/),
      collectedAt: instant,
    })
    .refine((value) => value.official === (value.provider === 'garmin-official'))
    .nullable(),
});

export type GarminUnofficialStatus = z.infer<typeof garminUnofficialStatusSchema>;
export type GarminUnofficialRun = z.infer<typeof garminUnofficialRunSchema>;
export type GarminUnofficialLogin = z.infer<typeof garminUnofficialLoginSchema>;
export type ActivityCollectionProvenance = z.infer<typeof activityCollectionProvenanceSchema>;

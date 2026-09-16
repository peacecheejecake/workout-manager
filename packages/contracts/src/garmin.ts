import { z } from 'zod';

export const garminConnectionStateSchema = z.enum([
  'not_connected',
  'connecting',
  'connected',
  'reconnect_required',
  'disconnecting',
]);
/** Public connection metadata only; OAuth credentials never cross this boundary. */
export const garminStatusSchema = z.strictObject({
  configured: z.boolean(),
  state: garminConnectionStateSchema,
  permissions: z.array(z.string().min(1).max(100)).max(32),
  connectedAt: z.iso.datetime({ offset: true }).nullable(),
});
export const garminConnectResultSchema = z.strictObject({
  authorizationUrl: z.url().max(4096),
});
export type GarminStatus = z.infer<typeof garminStatusSchema>;

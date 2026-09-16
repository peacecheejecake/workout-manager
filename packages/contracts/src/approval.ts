import { z } from 'zod';
import { jointApprovalRequestSchema } from './nutrition.js';
import { integratedApprovalV023Schema } from './routines.js';

/** Version routing is not migration, authorization, freshness validation or approval execution. */
export const approvalRequestSchema = z.union([
  jointApprovalRequestSchema,
  integratedApprovalV023Schema,
]);
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export function decodeApprovalRequest(
  input: unknown,
):
  | { ok: true; data: ApprovalRequest }
  | { ok: false; code: 'UNSUPPORTED_SCHEMA_VERSION' | 'INVALID_APPROVAL_PAYLOAD' } {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('schemaVersion' in input) ||
    (input.schemaVersion !== 3 && input.schemaVersion !== 4)
  ) {
    return { ok: false, code: 'UNSUPPORTED_SCHEMA_VERSION' };
  }
  const result =
    input.schemaVersion === 3
      ? jointApprovalRequestSchema.safeParse(input)
      : integratedApprovalV023Schema.safeParse(input);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, code: 'INVALID_APPROVAL_PAYLOAD' };
}

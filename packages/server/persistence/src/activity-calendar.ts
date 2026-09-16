/**
 * PostgreSQL names astronomical ISO year 0000 as 0001 BC. Preserve its leap days,
 * offset and fractions rather than substituting an AD year or treating it as null.
 * Only pass trusted SQL expressions; request values must remain query parameters.
 */
export function activityInstantSql(trustedExpression: string): string {
  return `(CASE WHEN left((${trustedExpression}),5)='0000-' THEN ('0001'||substring((${trustedExpression}) FROM 5)||' BC')::timestamptz ELSE (${trustedExpression})::timestamptz END)`;
}

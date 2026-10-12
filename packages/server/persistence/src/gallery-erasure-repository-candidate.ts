import { z } from 'zod';
import type { Database, Transaction } from './database.js';
const owner = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
function transactionOwner(tx: Transaction): string {
  const d = Object.getOwnPropertyDescriptor(tx, 'athleteId');
  if (!d || !('value' in d)) throw Error('INVALID_GALLERY_ERASURE_CONTEXT');
  return owner.parse(d.value);
}
/** Requires exclusiveTenant global→lifecycle(EXCLUSIVE)→tenant ordering. No
 * ad-hoc transaction/grant/legacy fallback and no production registration. */
export function createGalleryExtensionErasureRepositoryCandidate(
  database: Pick<Database, 'exclusiveTenant'>,
) {
  return {
    async eraseAccount(rawOwner: unknown) {
      const athlete = owner.parse(rawOwner);
      return database.exclusiveTenant(athlete, async (tx) => {
        if (transactionOwner(tx) !== athlete) throw Error('INVALID_GALLERY_ERASURE_CONTEXT');
        // exclusiveTenant supplies global/lifecycle fences; SQL143 also requires
        // the tenant command fence before its owner erasure helper.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
        const result = await tx.query(
          `SELECT to_char(public.erase_gallery_navigation_extension_account_v1($1::text) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS erased_at`,
          [athlete],
        );
        const rows = result.rows;
        if (result.rowCount !== 1 || !Array.isArray(rows) || rows.length !== 1)
          throw Error('INVALID_GALLERY_ERASURE_REPLY');
        const row = rows[0];
        if (
          typeof row !== 'object' ||
          row === null ||
          Object.getPrototypeOf(row) !== Object.prototype ||
          Reflect.ownKeys(row).length !== 1
        )
          throw Error('INVALID_GALLERY_ERASURE_REPLY');
        const d = Object.getOwnPropertyDescriptor(row, 'erased_at');
        if (!d || !('value' in d) || !d.enumerable) throw Error('INVALID_GALLERY_ERASURE_REPLY');
        const erasedAt = z.iso.datetime({ precision: 6 }).parse(d.value);
        return { erased: true as const, erasedAt };
      });
    },
  };
}

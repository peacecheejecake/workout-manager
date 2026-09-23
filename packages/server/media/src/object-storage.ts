import type { FinalObjectKey, ObjectKey, ObjectScope, TemporaryObjectKey } from './keys.js';

export interface StoredObjectStat {
  readonly key: ObjectKey;
  readonly sizeBytes: number;
  readonly modifiedAt: Date;
}

export interface OpenedStoredObject extends StoredObjectStat {
  readonly body: AsyncIterable<Uint8Array>;
}

export interface PublishExpectation {
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface PublishResult {
  readonly key: FinalObjectKey;
  readonly outcome: 'published' | 'already_present';
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ObjectStorage {
  writeTemporary(
    key: TemporaryObjectKey,
    body: AsyncIterable<Uint8Array>,
  ): Promise<StoredObjectStat>;
  /** Implementations must not reject after making the final key visible. */
  publishTemporary(
    temporaryKey: TemporaryObjectKey,
    finalKey: FinalObjectKey,
    expectation: PublishExpectation,
  ): Promise<PublishResult>;
  open(key: ObjectKey): Promise<OpenedStoredObject | null>;
  stat(key: ObjectKey): Promise<StoredObjectStat | null>;
  delete(key: ObjectKey): Promise<void>;
}

/**
 * Whether the store as a whole can answer at all (M2-01n).
 *
 * Kept apart from `stat`, which answers for one key and reads a missing key as "absent". For
 * the store itself there is no such reading: a root that is gone is a missing mount or a
 * misconfiguration, never an empty store, so `assertReachable` rejects for it just as it does
 * for EACCES or EIO. It resolves only when the store could answer a `stat` right now.
 */
export interface StoreReachability {
  assertReachable(): Promise<void>;
}

/** One bounded listing of the objects stored under one tenant's prefix (M2-01x). */
export interface TenantObjectListing {
  /** Keys of this tenant only, each a valid object key, in walk order. At most `limit`. */
  readonly keys: readonly ObjectKey[];
  /**
   * Entries under the prefix that are not an object key of this tenant: a regular file whose
   * path is not a key, or a directory deeper than any key reaches. Counted, never listed and
   * never deleted.
   */
  readonly unrecognized: number;
  /** True when the walk stopped at `limit` with entries left to visit. */
  readonly truncated: boolean;
}

/**
 * Enumerating what one tenant has in the store, independently of any database row (M2-01x).
 *
 * It exists for one caller: the purge an account erasure arms. An object uploaded between a
 * backup's database dump and its object-archive copy has no row in a restored database, so
 * nothing row-based can ever name it; the tenant's prefix still does.
 *
 * Listing is advisory. It returns names and never deletes; every deletion still goes through
 * `ObjectStorage.delete`, which re-walks the key from the root under its own guards.
 */
export interface TenantObjectEnumeration {
  listTenantObjects(tenantId: string, limit: number): Promise<TenantObjectListing>;
}

/**
 * Enumerating what one activity or one course has in the store, independently of any database
 * row (M2-01y).
 *
 * It exists for one caller: the purge that deleting an activity arms (and the course
 * reclamation that deletion causes). A track uploaded, or a picture drawn, between a backup's
 * database dump and its object-archive copy has no row in a restored database, so nothing
 * row-based can name it — and its tenant is alive, so no tenant purge covers it. The scope's
 * prefix still names it.
 *
 * Listing is advisory, exactly as for a tenant: it returns names of that scope's keys only and
 * never deletes.
 */
export interface ObjectScopeEnumeration {
  listScopeObjects(scope: ObjectScope, limit: number): Promise<TenantObjectListing>;
}

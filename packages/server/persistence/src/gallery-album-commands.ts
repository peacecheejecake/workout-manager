import { z } from 'zod';
import {
  galleryAlbumCreateCommandV1Schema,
  galleryAlbumRenameCommandV1Schema,
  galleryAlbumDeleteCommandV1Schema,
  galleryAlbumDeleteResultV1Schema,
  galleryAlbumV1Schema,
  galleryMediaMembershipCommandV2Schema,
  galleryNavigationIdempotencyKeySchema,
  type GalleryAlbumV1,
  type GalleryAlbumDeleteResultV1,
} from '@workout/contracts/gallery-navigation-v2';
import type { GalleryMediaNavigationV3 } from '@workout/contracts/gallery-navigation-v3';
import { TenantErasedError, type Database, type Transaction } from './database.js';
import { mapGalleryNavigationV3Row } from './gallery-navigation-v3-rows.js';

export type GalleryAlbumCommandErrorCode =
  | 'INVALID_GALLERY_ALBUM_CONTEXT'
  | 'INVALID_GALLERY_ALBUM_COMMAND'
  | 'INVALID_GALLERY_ALBUM_REPLY'
  | 'GALLERY_ALBUM_COMMAND_UNAVAILABLE'
  | 'GALLERY_ALBUM_COMMAND_FAILED'
  | 'ALBUM_NOT_FOUND'
  | 'ALBUM_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_ACCESS_CONFLICT'
  | 'COURSE_NOT_FOUND'
  | 'GALLERY_ALBUM_DETACH_LIMIT'
  | 'RESTORE_PROCESSING_CLOSED'
  | 'ACCOUNT_ERASED';
export class GalleryAlbumCommandError extends Error {
  constructor(readonly code: GalleryAlbumCommandErrorCode) {
    super(code);
    this.name = 'GalleryAlbumCommandError';
  }
}
const ownerSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const sql = {
  create: 'SELECT public.create_gallery_album_v1($1::jsonb,$2::text) AS result',
  rename: 'SELECT public.rename_gallery_album_v1($1::jsonb,$2::text) AS result',
  delete: 'SELECT public.delete_gallery_album_v1($1::jsonb,$2::text) AS result',
  navigation: 'SELECT public.set_gallery_media_navigation_v1($1::jsonb,$2::text) AS result',
} as const;
function owner(raw: unknown): string {
  const parsed = ownerSchema.safeParse(raw);
  if (!parsed.success) throw new GalleryAlbumCommandError('INVALID_GALLERY_ALBUM_CONTEXT');
  return parsed.data;
}
function transactionOwner(transaction: Transaction): string {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(transaction, 'athleteId');
    if (descriptor && 'value' in descriptor) return owner(descriptor.value);
  } catch {
    /* Invalid context is never consulted through an accessor. */
  }
  throw new GalleryAlbumCommandError('INVALID_GALLERY_ALBUM_CONTEXT');
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new GalleryAlbumCommandError('INVALID_GALLERY_ALBUM_COMMAND');
  return parsed.data;
}
function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
    throw new GalleryAlbumCommandError('INVALID_GALLERY_ALBUM_REPLY');
  return descriptor.value;
}
/** pg.QueryResult has additional driver metadata and a driver-owned prototype.
 * Consume only the two own data properties; never enumerate/read those metadata.
 * Rows and the single RPC result remain exact, bounded DTO projections. */
function singleReply(raw: unknown): unknown {
  try {
    if (typeof raw !== 'object' || raw === null || dataProperty(raw, 'rowCount') !== 1)
      throw new Error('invalid');
    const rows = dataProperty(raw, 'rows');
    if (
      !Array.isArray(rows) ||
      Object.getPrototypeOf(rows) !== Array.prototype ||
      rows.length !== 1 ||
      Reflect.ownKeys(rows).length !== 2
    )
      throw new Error('invalid');
    const row = dataProperty(rows, '0');
    if (
      typeof row !== 'object' ||
      row === null ||
      Object.getPrototypeOf(row) !== Object.prototype ||
      Reflect.ownKeys(row).length !== 1
    )
      throw new Error('invalid');
    return dataProperty(row, 'result');
  } catch {
    throw new GalleryAlbumCommandError('INVALID_GALLERY_ALBUM_REPLY');
  }
}
const domainCodes = new Set<GalleryAlbumCommandErrorCode>([
  'ALBUM_NOT_FOUND',
  'ALBUM_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'MEDIA_NOT_FOUND',
  'MEDIA_ACCESS_CONFLICT',
  'COURSE_NOT_FOUND',
  'GALLERY_ALBUM_DETACH_LIMIT',
  'RESTORE_PROCESSING_CLOSED',
  'ACCOUNT_ERASED',
]);
function sanitized(error: unknown): GalleryAlbumCommandError {
  if (error instanceof GalleryAlbumCommandError) return error;
  if (error instanceof TenantErasedError) return new GalleryAlbumCommandError('ACCOUNT_ERASED');
  try {
    if (typeof error === 'object' && error !== null) {
      const code = Object.getOwnPropertyDescriptor(error, 'code');
      const message = Object.getOwnPropertyDescriptor(error, 'message');
      const state: unknown = code && 'value' in code ? code.value : null;
      if (state === 'P0001' && message && 'value' in message && typeof message.value === 'string') {
        for (const allowed of domainCodes)
          if (message.value === allowed) return new GalleryAlbumCommandError(allowed);
      }
      // Missing draft registration/objects/EXECUTE never activates a fallback writer.
      if (state === '42883' || state === '42P01' || state === '42501')
        return new GalleryAlbumCommandError('GALLERY_ALBUM_COMMAND_UNAVAILABLE');
    }
  } catch {
    /* Error getters/proxies and raw text are discarded. */
  }
  return new GalleryAlbumCommandError('GALLERY_ALBUM_COMMAND_FAILED');
}
async function execute(transaction: Transaction, statement: string, command: unknown, key: string) {
  try {
    return singleReply(await transaction.query(statement, [JSON.stringify(command), key]));
  } catch (error) {
    throw sanitized(error);
  }
}
function reply<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new GalleryAlbumCommandError('INVALID_GALLERY_ALBUM_REPLY');
  return parsed.data;
}
/** Uses the caller's authenticated tenant transaction/global lifecycle fence.
 * SQL143 is installed/granted only as a profile27 member; restore
 * registration remains outside this adapter. It creates no grants, owner
 * credentials or admission authority. */
export async function createGalleryAlbumIn(
  transaction: Transaction,
  raw: unknown,
  rawKey: unknown,
): Promise<GalleryAlbumV1> {
  transactionOwner(transaction);
  const command = parse(galleryAlbumCreateCommandV1Schema, raw);
  const key = parse(galleryNavigationIdempotencyKeySchema, rawKey);
  const result = reply(galleryAlbumV1Schema, await execute(transaction, sql.create, command, key));
  if (result.title !== command.title || result.revision !== 1)
    throw new GalleryAlbumCommandError('INVALID_GALLERY_ALBUM_REPLY');
  return result;
}
export async function renameGalleryAlbumIn(
  transaction: Transaction,
  raw: unknown,
  rawKey: unknown,
): Promise<GalleryAlbumV1> {
  transactionOwner(transaction);
  const command = parse(galleryAlbumRenameCommandV1Schema, raw);
  const key = parse(galleryNavigationIdempotencyKeySchema, rawKey);
  const result = reply(galleryAlbumV1Schema, await execute(transaction, sql.rename, command, key));
  if (
    result.id !== command.albumId ||
    result.title !== command.title ||
    result.revision !== command.expectedRevision + 1
  )
    throw new GalleryAlbumCommandError('INVALID_GALLERY_ALBUM_REPLY');
  // A receipt may be older than the live head: do not read, rewrite or remint it.
  return result;
}
export async function deleteGalleryAlbumIn(
  transaction: Transaction,
  raw: unknown,
  rawKey: unknown,
): Promise<GalleryAlbumDeleteResultV1> {
  transactionOwner(transaction);
  const command = parse(galleryAlbumDeleteCommandV1Schema, raw);
  const key = parse(galleryNavigationIdempotencyKeySchema, rawKey);
  const result = reply(
    galleryAlbumDeleteResultV1Schema,
    await execute(transaction, sql.delete, command, key),
  );
  if (result.albumId !== command.albumId || result.revision !== command.expectedRevision + 1)
    throw new GalleryAlbumCommandError('INVALID_GALLERY_ALBUM_REPLY');
  return result;
}
/** Explicit membership/course command. The reply is the original stored flat
 * projection (also on idempotent replay), validated by the shared V3 row mapper. */
export async function setGalleryMediaNavigationIn(
  transaction: Transaction,
  raw: unknown,
  rawKey: unknown,
): Promise<GalleryMediaNavigationV3> {
  const athleteId = transactionOwner(transaction);
  const command = parse(galleryMediaMembershipCommandV2Schema, raw);
  const key = parse(galleryNavigationIdempotencyKeySchema, rawKey);
  const reply = await execute(transaction, sql.navigation, command, key);
  let result: GalleryMediaNavigationV3;
  try {
    result = mapGalleryNavigationV3Row(athleteId, reply);
  } catch {
    throw new GalleryAlbumCommandError('INVALID_GALLERY_ALBUM_REPLY');
  }
  if (
    result.item.id !== command.mediaItemId ||
    result.item.accessRevision !== command.expectedAccessRevision + 1 ||
    JSON.stringify(result.albumMembership) !== JSON.stringify(command.albumMembership) ||
    JSON.stringify(result.courseLink) !== JSON.stringify(command.courseLink)
  )
    throw new GalleryAlbumCommandError('INVALID_GALLERY_ALBUM_REPLY');
  return result;
}
/** Commands resolve after Database.tenant commits. DTO validation is inside that
 * callback, so a malformed result rejects the transaction, not a committed reply. */
export function createGalleryAlbumCommandRepository(database: Pick<Database, 'tenant'>) {
  async function tenant<T>(rawOwner: unknown, action: (transaction: Transaction) => Promise<T>) {
    const athleteId = owner(rawOwner);
    try {
      return await database.tenant(athleteId, (transaction) => {
        if (transactionOwner(transaction) !== athleteId)
          throw new GalleryAlbumCommandError('INVALID_GALLERY_ALBUM_CONTEXT');
        return action(transaction);
      });
    } catch (error) {
      throw sanitized(error);
    }
  }
  return {
    createAlbum: (athleteId: unknown, command: unknown, key: unknown) =>
      tenant(athleteId, (tx) => createGalleryAlbumIn(tx, command, key)),
    renameAlbum: (athleteId: unknown, command: unknown, key: unknown) =>
      tenant(athleteId, (tx) => renameGalleryAlbumIn(tx, command, key)),
    deleteAlbum: (athleteId: unknown, command: unknown, key: unknown) =>
      tenant(athleteId, (tx) => deleteGalleryAlbumIn(tx, command, key)),
    updateMembership: (athleteId: unknown, command: unknown, key: unknown) =>
      tenant(athleteId, (tx) => setGalleryMediaNavigationIn(tx, command, key)),
  };
}
export type GalleryAlbumCommandRepository = ReturnType<typeof createGalleryAlbumCommandRepository>;

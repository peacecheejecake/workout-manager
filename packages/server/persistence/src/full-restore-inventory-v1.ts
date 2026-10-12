import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';

// New structural inventory version. No signature, loader or authority is issued.
const metadataBoundary = createBoundedPlainJsonSchema(1048576);
const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = (minimum: number, maximum: number) =>
  z.number().int().min(minimum).max(maximum).refine(Number.isSafeInteger);
const emptyRowsSha256 = createHash('sha256').update('[]').digest('hex');
const codec = z.literal('postgres-row-jsonb-utc-v1');
const key = z
  .array(identifier)
  .min(1)
  .max(16)
  .refine((items) => new Set(items).size === items.length);
const identity = z.strictObject({
  profileId: identifier,
  normalRegistrySha256: hash,
  namedProfileSha256: hash,
  catalogSha256: hash,
});
const relationIdentity = {
  schema: identifier,
  relation: identifier,
  physicalCodec: codec,
  columnsSha256: hash,
  orderingKey: key,
};
const registrySchema = metadataBoundary.pipe(
  z.strictObject({
    schemaVersion: z.literal(1),
    identity,
    maxTotalRows: integer(0, 10000000),
    maxTotalBytes: integer(2, 1073741824),
    targetLocalRelations: z
      .array(z.strictObject({ schema: identifier, relation: identifier }))
      .min(3)
      .max(1000),
    relations: z
      .array(
        z.strictObject({
          ...relationIdentity,
          maxRows: integer(0, 1000000),
          maxBytes: integer(2, 67108864),
        }),
      )
      .min(1)
      .max(1000),
  }),
);
const rowFacts = {
  ...relationIdentity,
  rowCount: integer(0, 1000000),
  byteLength: integer(2, 67108864),
  rowsSha256: hash,
};
const entry = z.discriminatedUnion('state', [
  z.strictObject({ ...rowFacts, state: z.literal('present') }).superRefine((value, context) => {
    if (value.rowCount === 0 || value.byteLength <= 2 || value.rowsSha256 === emptyRowsSha256)
      context.addIssue({
        code: 'custom',
        message: 'Nonempty row facts required',
      });
  }),
  z
    .strictObject({ ...rowFacts, state: z.literal('explicit_empty') })
    .superRefine((value, context) => {
      if (value.rowCount !== 0 || value.byteLength !== 2 || value.rowsSha256 !== emptyRowsSha256)
        context.addIssue({
          code: 'custom',
          message: 'Exact empty array facts required',
        });
    }),
]);
const inventorySchema = metadataBoundary.pipe(
  z.strictObject({
    schemaVersion: z.literal(1),
    identity,
    relations: z.array(entry).min(1).max(1000),
  }),
);
type Inventory = z.infer<typeof inventorySchema>;
export type FullRestoreInventoryErrorCode =
  | 'INVALID_FULL_RESTORE_REGISTRY'
  | 'INVALID_FULL_RESTORE_INVENTORY'
  | 'INVENTORY_IDENTITY_MISMATCH'
  | 'INVENTORY_RELATION_MISMATCH'
  | 'INVENTORY_BOUNDS_EXCEEDED';
export class FullRestoreInventoryError extends Error {
  constructor(readonly code: FullRestoreInventoryErrorCode) {
    super(code);
    this.name = 'FullRestoreInventoryError';
  }
}
export type ValidatedFullRestoreInventoryV1 = Readonly<{
  kind: 'validated_full_restore_inventory_v1';
  authority: 'none';
  admissionAllowed: false;
  inventory: Readonly<{
    schemaVersion: 1;
    identity: Readonly<Inventory['identity']>;
    relations: readonly Readonly<
      Omit<Inventory['relations'][number], 'orderingKey'> & {
        orderingKey: readonly string[];
      }
    >[];
  }>;
  totals: Readonly<{ rowCount: number; byteLength: number }>;
}>;
function fail(code: FullRestoreInventoryErrorCode): never {
  throw new FullRestoreInventoryError(code);
}
function name(value: { schema: string; relation: string }) {
  return `${value.schema}.${value.relation}`;
}
function ordered(rows: readonly { schema: string; relation: string }[]) {
  return rows.every((row, index) => index === 0 || name(rows[index - 1] ?? row) < name(row));
}
// Target-local authority is not source archive content. These exclusions are
// defense-in-depth, never a production allow registry inferred from the archive.
const targetNamespaces = new Set([
  'wm_app_load',
  'wm_current_app_load',
  'wm_current_original_postimages',
  'wm_identity_target_load',
  'wm_runtime_installation',
]);
const targetRelations = new Set([
  'public.restore_generation',
  'public.restore_processing_admission',
  'public.restore_processing_close_receipt',
]);
function targetLocal(value: { schema: string; relation: string }) {
  return targetNamespaces.has(value.schema) || targetRelations.has(name(value));
}
/** Configure from an independently approved registry, not artifact-derived names.
 * The registry is checked/copied once and hidden in this parser's closure. A
 * registry hash field is only equality data here, not a computed authority proof. */
export function createFullRestoreInventoryParserV1(rawTrustedRegistry: unknown) {
  const parsed = registrySchema.safeParse(rawTrustedRegistry);
  if (!parsed.success) return fail('INVALID_FULL_RESTORE_REGISTRY');
  const registry = parsed.data;
  const excluded = new Set(registry.targetLocalRelations.map(name));
  if (
    !ordered(registry.targetLocalRelations) ||
    [...targetRelations].some((relation) => !excluded.has(relation)) ||
    !ordered(registry.relations) ||
    registry.relations.some((relation) => targetLocal(relation) || excluded.has(name(relation)))
  )
    return fail('INVALID_FULL_RESTORE_REGISTRY');
  return {
    parse(rawInventory: unknown): ValidatedFullRestoreInventoryV1 {
      const parsedInventory = inventorySchema.safeParse(rawInventory);
      if (!parsedInventory.success) return fail('INVALID_FULL_RESTORE_INVENTORY');
      const inventory = parsedInventory.data;
      const actual = inventory.identity,
        expected = registry.identity;
      if (
        actual.profileId !== expected.profileId ||
        actual.normalRegistrySha256 !== expected.normalRegistrySha256 ||
        actual.namedProfileSha256 !== expected.namedProfileSha256 ||
        actual.catalogSha256 !== expected.catalogSha256
      )
        return fail('INVENTORY_IDENTITY_MISMATCH');
      if (!ordered(inventory.relations) || inventory.relations.length !== registry.relations.length)
        return fail('INVENTORY_RELATION_MISMATCH');
      let rowCount = 0,
        byteLength = 0;
      for (const [index, row] of inventory.relations.entries()) {
        const expectedRow = registry.relations[index];
        if (
          !expectedRow ||
          targetLocal(row) ||
          excluded.has(name(row)) ||
          name(row) !== name(expectedRow) ||
          row.physicalCodec !== expectedRow.physicalCodec ||
          row.columnsSha256 !== expectedRow.columnsSha256 ||
          row.orderingKey.length !== expectedRow.orderingKey.length ||
          row.orderingKey.some((column, ordinal) => column !== expectedRow.orderingKey[ordinal])
        )
          return fail('INVENTORY_RELATION_MISMATCH');
        if (row.rowCount > expectedRow.maxRows || row.byteLength > expectedRow.maxBytes)
          return fail('INVENTORY_BOUNDS_EXCEEDED');
        rowCount += row.rowCount;
        byteLength += row.byteLength;
        if (
          !Number.isSafeInteger(rowCount) ||
          !Number.isSafeInteger(byteLength) ||
          rowCount > registry.maxTotalRows ||
          byteLength > registry.maxTotalBytes
        )
          return fail('INVENTORY_BOUNDS_EXCEEDED');
      }
      return Object.freeze({
        kind: 'validated_full_restore_inventory_v1',
        authority: 'none',
        admissionAllowed: false,
        inventory: Object.freeze({
          schemaVersion: 1,
          identity: Object.freeze(inventory.identity),
          relations: Object.freeze(
            inventory.relations.map((row) =>
              Object.freeze({
                ...row,
                orderingKey: Object.freeze([...row.orderingKey]),
              }),
            ),
          ),
        }),
        totals: Object.freeze({ rowCount, byteLength }),
      });
    },
  };
}

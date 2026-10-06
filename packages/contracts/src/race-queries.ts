import { z } from 'zod';
import { raceEventSchema, raceResultSchema, trainingBestSchema } from './races.js';

export const raceCollectionKindSchema = z.enum(['race-event', 'race-result', 'training-best']);
/** Both values are required: privacy redaction can advance at terminal int4 revision. */
export const raceCollectionStampSchema = z.strictObject({
  revision: z.number().int().min(1).max(2147483647),
  privacyGeneration: z
    .string()
    .max(200)
    .regex(/^(0|[1-9][0-9]*)$/),
});
export const raceListCursorSchema = z.strictObject({
  kind: raceCollectionKindSchema,
  collection: raceCollectionStampSchema,
  afterId: z.uuid().refine((value) => value === value.toLowerCase()),
});
/** A position is not authority. The server checks its kind, live collection and
 * membership under the authenticated tenant; it never accepts cursor ownership. */
export const raceListQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: raceListCursorSchema.nullable().default(null),
});

const pageShape = {
  schemaVersion: z.literal(1),
  sort: z.literal('id-asc'),
  collection: raceCollectionStampSchema.nullable(),
  nextCursor: raceListCursorSchema.nullable(),
};
type PageConsistency = {
  kind: z.infer<typeof raceCollectionKindSchema>;
  collection: z.infer<typeof raceCollectionStampSchema> | null;
  items: { id: string }[];
  nextCursor: z.infer<typeof raceListCursorSchema> | null;
};
function checkPage(page: PageConsistency, ctx: z.RefinementCtx) {
  if (page.collection === null && (page.items.length > 0 || page.nextCursor !== null))
    ctx.addIssue({ code: 'custom', path: ['collection'], message: 'Absent collection is empty' });
  for (let index = 1; index < page.items.length; index++) {
    const prior = page.items[index - 1];
    const current = page.items[index];
    if (prior && current && prior.id >= current.id)
      ctx.addIssue({ code: 'custom', path: ['items', index], message: 'IDs must strictly ascend' });
  }
  if (page.nextCursor !== null) {
    const last = page.items.at(-1);
    if (
      page.nextCursor.kind !== page.kind ||
      page.nextCursor.afterId !== last?.id ||
      page.nextCursor.collection.revision !== page.collection?.revision ||
      page.nextCursor.collection.privacyGeneration !== page.collection?.privacyGeneration
    )
      ctx.addIssue({ code: 'custom', path: ['nextCursor'], message: 'Cursor must bind this page' });
  }
}

/** Storage order is explicit; this is neither chronological ranking nor PB calculation. */
export const raceEventListPageSchema = z
  .strictObject({
    ...pageShape,
    kind: z.literal('race-event'),
    items: z.array(raceEventSchema).max(100),
  })
  .superRefine(checkPage);
export const raceResultListPageSchema = z
  .strictObject({
    ...pageShape,
    kind: z.literal('race-result'),
    items: z.array(raceResultSchema).max(100),
  })
  .superRefine(checkPage);
export const trainingBestListPageSchema = z
  .strictObject({
    ...pageShape,
    kind: z.literal('training-best'),
    items: z.array(trainingBestSchema).max(100),
  })
  .superRefine(checkPage);

export type RaceCollectionKind = z.infer<typeof raceCollectionKindSchema>;
export type RaceCollectionStamp = z.infer<typeof raceCollectionStampSchema>;
export type RaceListCursor = z.infer<typeof raceListCursorSchema>;
export type RaceListQuery = z.infer<typeof raceListQuerySchema>;
export type RaceEventListPage = z.infer<typeof raceEventListPageSchema>;
export type RaceResultListPage = z.infer<typeof raceResultListPageSchema>;
export type TrainingBestListPage = z.infer<typeof trainingBestListPageSchema>;

export type RaceListQueryInput = z.input<typeof raceListQuerySchema>;

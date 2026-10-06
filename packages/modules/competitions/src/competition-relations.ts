import { z } from 'zod';
import { raceCourseRefSchema } from '@workout/contracts/races';

const label = z.string().min(1).max(500);
const planChoice = z.strictObject({ id: z.string().min(1).max(200), label });
const activityChoice = z.strictObject({ id: z.uuid(), label });
const courseChoice = z.strictObject({ ref: raceCourseRefSchema, label });
/** Hosts supply choices from authenticated, scoped APIs. Absence means unavailable,
 * never permission to clear a stored relationship or select a mutable Course head. */
export const competitionRelationsSchema = z.strictObject({
  plans: z.array(planChoice).max(1000).optional(),
  courses: z.array(courseChoice).max(1000).optional(),
  activities: z.array(activityChoice).max(1000).optional(),
});
export type CompetitionRelations = {
  plans?: readonly z.infer<typeof planChoice>[] | undefined;
  courses?: readonly z.infer<typeof courseChoice>[] | undefined;
  activities?: readonly z.infer<typeof activityChoice>[] | undefined;
};
export type NamedChoice = { id: string; label: string };

import { z } from 'zod';
import type { NutritionRoute } from './nutrition-workspace';

const planIdSchema = z.uuid();
const intakeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export function parseNutritionSegments(segments: readonly string[]): NutritionRoute | null {
  if (segments.length === 0) return { kind: 'dashboard' };
  if (segments.length === 1 && segments[0] === 'logs') return { kind: 'logs' };
  if (segments.length === 2 && segments[0] === 'logs' && segments[1] === 'new')
    return { kind: 'log-new' };
  if (segments.length === 2 && segments[0] === 'plans' && segments[1] === 'new')
    return { kind: 'plans-new' };
  if (segments.length === 2 && segments[0] === 'plans') {
    const id = planIdSchema.safeParse(segments[1]);
    return id.success ? { kind: 'plan', planId: id.data.toLowerCase() } : null;
  }
  if (segments.length === 3 && segments[0] === 'logs' && segments[2] === 'edit') {
    const id = intakeIdSchema.safeParse(segments[1]);
    return id.success ? { kind: 'log-edit', intakeId: id.data } : null;
  }
  return null;
}

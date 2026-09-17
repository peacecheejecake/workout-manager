import { z } from 'zod';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const schema = z.strictObject({
  thread: uuid.nullable(),
  offset: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .transform(Number)
    .pipe(z.number().max(10000)),
  planVersion: uuid.nullable(),
  scopeKind: z.enum(['session', 'block', 'phase']),
  targetId: z
    .string()
    .min(1)
    .max(200)
    .refine((v) => v.trim() === v && !v.includes('\0'))
    .nullable(),
});
export type CoachingSearch = z.infer<typeof schema>;
export function readCoachingSearch(search: string): {
  query: CoachingSearch | null;
  error: string | null;
} {
  const p = new URLSearchParams(search);
  const keys = ['thread', 'offset', 'planVersion', 'scopeKind', 'targetId'];
  const result = schema.safeParse({
    thread: p.get('thread'),
    offset: p.get('offset') ?? '0',
    planVersion: p.get('planVersion'),
    scopeKind: p.get('scopeKind') ?? 'session',
    targetId: p.get('targetId'),
  });
  if (keys.some((key) => p.getAll(key).length > 1) || !result.success)
    return { query: null, error: '상담 조회 주소를 확인하세요.' };
  return { query: result.data, error: null };
}
export function changeCoachingSearch(
  search: string,
  changes: Record<string, string | null>,
): string {
  const p = new URLSearchParams(search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) p.delete(key);
    else p.set(key, value);
  }
  return p.toString();
}

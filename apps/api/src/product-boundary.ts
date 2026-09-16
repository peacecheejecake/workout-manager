import { z } from 'zod';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
export class ProductRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProductRequestError(400, 'INVALID_REQUEST');
  return parsed.data;
}
export async function command<T>(
  operation: () => Promise<T>,
  translate: (error: unknown) => ProductRequestError | undefined,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PersistenceConflict) throw new ProductRequestError(409, error.code);
    throw translate(error) ?? error;
  }
}
export const emptyQuery = z.strictObject({});

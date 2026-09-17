function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Object key order is immaterial; array order and absent fields remain meaningful. */
export function samePlanValue(before: unknown, after: unknown): boolean {
  if (Object.is(before, after)) return true;
  if (Array.isArray(before) && Array.isArray(after))
    return (
      before.length === after.length &&
      before.every((value, index) => samePlanValue(value, after[index]))
    );
  if (!isRecord(before) || !isRecord(after)) return false;
  const keys = Object.keys(before);
  return (
    keys.length === Object.keys(after).length &&
    keys.every((key) => Object.hasOwn(after, key) && samePlanValue(before[key], after[key]))
  );
}

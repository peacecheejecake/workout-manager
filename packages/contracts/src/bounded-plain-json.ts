import { z } from 'zod';

/** Structural transport guard only. The trusted byte budget bounds JSON token
 * visits independently of domain source-reference and roster limits. No source,
 * permission, freshness or approval authority is established by this parser. */
export function createBoundedPlainJsonSchema(
  maximum: number,
  message = 'Bounded plain JSON required',
) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 8388608)
    throw new RangeError('Invalid configured JSON byte budget');
  return z.unknown().superRefine((raw, c) => {
    let bytes = 0,
      visits = 0;
    const ancestors = new Set<object>();
    function charge(n: number) {
      bytes += n;
      if (bytes > maximum) throw Error('bound');
    }
    // Count JSON.stringify string bytes without creating an escaped copy.
    function string(value: string) {
      charge(2);
      for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code === 34 || code === 92) charge(2);
        else if (code <= 31)
          charge(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6);
        else if (code < 128) charge(1);
        else if (code < 2048) charge(2);
        else if (code >= 0xd800 && code <= 0xdbff) {
          const next = value.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            charge(4);
            i++;
          } else charge(6);
        } else if (code >= 0xdc00 && code <= 0xdfff) charge(6);
        else charge(3);
      }
    }
    function visit(value: unknown, depth: number): void {
      // Every plain JSON value contributes at least one distinct encoded byte.
      if (++visits > maximum || depth > 64) throw Error('bound');
      if (typeof value === 'string') return string(value);
      if (value === null) return charge(4);
      if (typeof value === 'boolean') return charge(value ? 4 : 5);
      if (typeof value === 'number' && Number.isFinite(value))
        return charge(JSON.stringify(value).length);
      if (typeof value !== 'object' || ancestors.has(value)) throw Error('plain');
      const array = Array.isArray(value),
        proto: unknown = Object.getPrototypeOf(value);
      if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
        throw Error('plain');
      if (array && value.length > maximum) throw Error('bound');
      const keys = Reflect.ownKeys(value);
      if (keys.length > maximum + 1 || (array && keys.length !== value.length + 1))
        throw Error('plain');
      ancestors.add(value);
      charge(2);
      let members = 0;
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (
          typeof key !== 'string' ||
          (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))
        )
          throw Error('plain');
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) throw Error('plain');
        if (members++) charge(1);
        if (!array) {
          string(key);
          charge(1);
        }
        visit(property.value, depth + 1);
      }
      ancestors.delete(value);
    }
    try {
      visit(raw, 0);
    } catch {
      c.addIssue({ code: 'custom', message });
    }
  });
}

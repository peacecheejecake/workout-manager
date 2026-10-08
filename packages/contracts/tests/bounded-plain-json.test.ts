import { describe, expect, it } from 'vitest';
import { createBoundedPlainJsonSchema } from '../src/bounded-plain-json.js';
const schema = createBoundedPlainJsonSchema(4194304);

describe('exact encoded plain JSON transport', () => {
  it.each([0, -1, 1.5, Infinity, 8388609])('rejects unsafe configured budget %s', (bytes) => {
    expect(() => createBoundedPlainJsonSchema(bytes)).toThrow(RangeError);
  });
  it.each([
    { text: '\u0000\b\t\n\f\r"\\한😀\ud800\udfff', number: 1e21, bool: false, nullable: null },
    { text: '', number: -1.25e-7, bool: true, nullable: null },
  ])('charges keys, syntax, UTF8, escape and scalar bytes exactly', (values) => {
    const raw = { ['key"\\\u0001한\ud800']: values, padding: '' };
    const base = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
    for (const delta of [-1, 0, 1]) {
      raw.padding = 'x'.repeat(4194304 - base + delta);
      expect(new TextEncoder().encode(JSON.stringify(raw)).byteLength).toBe(4194304 + delta);
      expect(schema.safeParse(raw).success).toBe(delta <= 0);
    }
  });
  it('charges ordered arrays without index-key overhead and preserves zero/null', () => {
    const raw = { values: [null, false, true, 0, -0, 1e-7, 1e21], padding: '' };
    const base = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
    raw.padding = 'x'.repeat(4194304 - base);
    expect(schema.parse(raw)).toEqual(raw);
    raw.padding += 'x';
    expect(schema.safeParse(raw).success).toBe(false);
    expect(schema.safeParse(Array.from({ length: 8000 }, () => null)).success).toBe(true);
  });
  it('rejects accessors, sparse/cyclic/exotic/symbol/nonfinite data without evaluating getters', () => {
    let calls = 0;
    const getter = Object.defineProperty({}, 'body', {
      enumerable: true,
      get() {
        calls++;
        return {};
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const hidden = Object.defineProperty({}, 'secret', { value: 1, enumerable: false });
    for (const raw of [
      getter,
      cycle,
      new Array(3),
      new Date(),
      hidden,
      { [Symbol('x')]: 1 },
      NaN,
      Infinity,
      undefined,
    ])
      expect(schema.safeParse(raw).success).toBe(false);
    expect(calls).toBe(0);
  });
  it('preserves depth64 and rejects depth65 independently of bytes', () => {
    let value: unknown = null;
    for (let i = 0; i < 64; i++) value = [value];
    expect(schema.safeParse(value).success).toBe(true);
    expect(schema.safeParse([value]).success).toBe(false);
  });
});

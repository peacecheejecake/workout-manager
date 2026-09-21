import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What the parse budget is, and what it is not.
 *
 * The budget in `limits.ts` counts work: it charges the input buffer, the decoded text and
 * the raw and normalized samples, and refuses to go further past its bound. It is not a
 * memory ceiling, and it cannot become one — it does not see V8's heap, the XML scanner's
 * temporaries or Zod's copies.
 *
 * This test makes that difference observable: the same bytes and the same code either
 * return a parser error code or abort the process, depending only on the heap ceiling the
 * runtime was given. That is why the browser side runs the parse in a dedicated worker it
 * can terminate, rather than claiming a memory bound the budget does not provide.
 */
const child = fileURLToPath(new URL('./heap-ceiling-child.mts', import.meta.url));

function run(heapMegabytes: number, points: number) {
  return spawnSync(
    process.execPath,
    [`--max-old-space-size=${heapMegabytes}`, '--import', 'tsx', child, String(points)],
    { encoding: 'utf8', timeout: 60_000 },
  );
}

describe('the parse budget is a work bound, not a memory ceiling', () => {
  it(
    'returns a parser error code with a generous heap and aborts under a tight one',
    { timeout: 120_000 },
    () => {
      const generous = run(1024, 60_000);
      expect(generous.status).toBe(0);
      // The contract's normalized-output bound stops this input long before the heap does.
      expect(generous.stdout).toContain('error TRACK_OUTPUT_TOO_LARGE');

      const tight = run(32, 60_000);
      // Same bytes, same code path, same budget: only the runtime ceiling differs, and the
      // process dies instead of reporting an error. A ceiling is enforced by the runtime,
      // never by the accounting inside the parser.
      expect(tight.status).not.toBe(0);
      expect(`${tight.stderr}`).toMatch(/heap out of memory|Last few GCs/);
      expect(tight.stdout).not.toContain('error TRACK_OUTPUT_TOO_LARGE');
    },
  );
});

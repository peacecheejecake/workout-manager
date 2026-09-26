/**
 * Child process for the applied-ceiling regression test. It runs the product parser with the
 * tight test ceiling over the shared ceiling fixture and prints the outcome code. The parent
 * runs it three times — plainly and with two heap options of its own — so the only difference
 * is the process-global heap option. See `parse-host.test.ts` and `ceiling-fixture.ts`.
 */
import { createBoundedTrackParser } from '../src/parse-host.js';
import {
  CEILING_TEST_HEAP_MEGABYTES,
  ceilingFixtureBytes,
  ceilingSelection,
} from './ceiling-fixture.js';

const parser = createBoundedTrackParser({
  execArgv: ['--import', 'tsx'],
  maxOldGenerationSizeMb: CEILING_TEST_HEAP_MEGABYTES,
  timeoutMs: 120_000,
});
const outcome = await parser.parse(ceilingFixtureBytes(), ceilingSelection);
process.stdout.write(`outcome ${outcome.ok ? 'PARSED' : outcome.code}\n`);

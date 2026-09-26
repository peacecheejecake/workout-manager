/**
 * A host started the way a sized production API would be — with a heap option of its own on
 * the command line — that constructs the parser with default options (review NB-2). The
 * parser inherits the host's `process.execArgv` (which carries the `tsx` loader and the host's
 * heap option); the heap option must be left behind rather than make construction throw.
 *
 *   node --max-old-space-size=1024 --import tsx default-options-host.mts
 *
 * Prints `default <outcome>` for a small file under the default ceiling, then `tight
 * <outcome>` for the shared ceiling fixture under the tight test ceiling: the host's 1024 MiB
 * must not reach the parse. See `ceiling-fixture.ts` for why the fixture is that size.
 */
import { createBoundedTrackParser } from '../src/parse-host.js';
import {
  CEILING_TEST_HEAP_MEGABYTES,
  ceilingFixtureBytes,
  ceilingSelection,
} from './ceiling-fixture.js';

const small = await createBoundedTrackParser().parse(ceilingFixtureBytes(5), ceilingSelection);
process.stdout.write(`default ${small.ok ? 'PARSED' : small.code}\n`);
const tight = await createBoundedTrackParser({
  maxOldGenerationSizeMb: CEILING_TEST_HEAP_MEGABYTES,
  timeoutMs: 120_000,
}).parse(ceilingFixtureBytes(), ceilingSelection);
process.stdout.write(`tight ${tight.ok ? 'PARSED' : tight.code}\n`);

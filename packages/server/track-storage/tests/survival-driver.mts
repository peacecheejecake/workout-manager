/**
 * The host process for the parse-memory survival check (M2-01ai, M2-01k-f F1). It is run as
 * a real, separate process by `parse-host.test.ts` (and by hand with more runs), so that a
 * V8 abort of the host is seen for what it is: this process's exit status, not a test
 * failure message.
 *
 *   node --import tsx packages/server/track-storage/tests/survival-driver.mts \
 *     [--runs=N] [--copies=8,10] [--rungs=40,44,48,52,56,64]
 *
 * For every run × copy count × rung it parses the representative long track (20,000
 * samples, scripts/fixtures/long-track.ts) at that old-generation ceiling with the parse
 * side holding that many copies of the track (`hoard-preload.mts`, the M2b/M2d conditions),
 * and prints one `rung` line with the outcome. Then it parses once more at the product
 * default to show it still serves, and prints `SURVIVED`. If a parse aborts this process,
 * neither line is printed and the exit status is V8's abort (134).
 */
import { createBoundedTrackParser } from '../src/parse-host.js';
import type { StoredTrackSelection } from '../src/artifacts.js';
import { LONG_TRACK_SAMPLES, longTrackFitBytes } from '../../../../scripts/fixtures/long-track.js';

const argument = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const list = (value: string) => value.split(',').map((item) => Number.parseInt(item, 10));

const runs = Number.parseInt(argument('runs', '1'), 10);
const copyCounts = list(argument('copies', '8,10'));
const rungs = list(argument('rungs', '40,44,48,52,56,64'));
const selection: StoredTrackSelection = {
  recordedTrackIndex: 0,
  provenance: {
    kind: 'activity-source',
    activityId: '11111111-1111-4111-8111-111111111111',
    sourceId: '22222222-2222-4222-8222-222222222222',
    sourceRevision: 1,
    trackRevision: 1,
  },
};
const bytes = longTrackFitBytes();
const preload = (copies: number) =>
  new URL(`./hoard-preload.mts?copies=${copies}`, import.meta.url).href;

for (let run = 0; run < runs; run += 1)
  for (const copies of copyCounts)
    for (const ceilingMb of rungs) {
      const parser = createBoundedTrackParser({
        maxOldGenerationSizeMb: ceilingMb,
        execArgv: ['--import', 'tsx', '--import', preload(copies)],
      });
      const outcome = await parser.parse(bytes, selection);
      const samples = outcome.ok ? outcome.artifacts.track.samples.length : 0;
      if (outcome.ok && samples !== LONG_TRACK_SAMPLES) throw new Error('SAMPLE_COUNT');
      process.stdout.write(
        `rung run=${run} copies=${copies} ceilingMb=${ceilingMb} outcome=${outcome.ok ? 'ok' : outcome.code} active=${parser.active()}\n`,
      );
    }

const after = await createBoundedTrackParser({ execArgv: ['--import', 'tsx'] }).parse(
  bytes,
  selection,
);
process.stdout.write(`after outcome=${after.ok ? 'ok' : after.code}\n`);
process.stdout.write('SURVIVED\n');

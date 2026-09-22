/**
 * Child process for the applied-ceiling regression test. It runs the product parser with a
 * 32 MiB ceiling over a 60,000-point GPX and prints the outcome code. The parent runs it
 * twice — once plainly, once with `--max-old-space-size=1024` — so the only difference is
 * the process-global heap option. See `parse-host.test.ts`.
 */
import { createBoundedTrackParser } from '../src/parse-host.js';
import type { StoredTrackSelection } from '../src/artifacts.js';

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
let body = '';
for (let index = 0; index < 60_000; index += 1) {
  const at = new Date(Date.parse('2026-03-01T00:00:00Z') + index * 1000).toISOString();
  body += `<trkpt lat="${37.5 + index / 1e6}" lon="${127 + index / 1e6}"><time>${at}</time></trkpt>`;
}
const bytes = new TextEncoder().encode(
  `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${body}</trkseg></trk></gpx>`,
);
const parser = createBoundedTrackParser({
  execArgv: ['--import', 'tsx'],
  maxOldGenerationSizeMb: 32,
  timeoutMs: 120_000,
});
const outcome = await parser.parse(bytes, selection);
process.stdout.write(`outcome ${outcome.ok ? 'PARSED' : outcome.code}\n`);

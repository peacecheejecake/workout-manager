/**
 * A host that dies while a parse is still running (M2-01ai). `parse-process.test.ts` runs it
 * as a real process and then checks that the parse process it printed is gone.
 *
 *   node --import tsx orphan-driver.mts <sigkill|exit>
 *
 * The parse process is loaded with `slow-reply-preload.mts`, so its parse is still pending
 * (for 10 s) when the host dies. The driver prints `child <pid>` as soon as the parse process
 * is forked, gives it a second to boot and take the bytes, and then ends itself: `sigkill`
 * without running any exit handler, or `exit` through `process.exit`. In both cases the
 * parse process sees its IPC channel close and must leave at once.
 */
import { createBoundedTrackParser } from '../src/parse-host.js';
import type { StoredTrackSelection } from '../src/artifacts.js';

const mode = process.argv[2];
if (mode !== 'sigkill' && mode !== 'exit') throw new Error('usage: orphan-driver <sigkill|exit>');

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
const bytes = new TextEncoder().encode(
  '<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>' +
    '<trkpt lat="37.5" lon="127"><time>2026-03-01T00:00:00Z</time></trkpt>' +
    '<trkpt lat="37.500001" lon="127.000001"><time>2026-03-01T00:00:01Z</time></trkpt>' +
    '</trkseg></trk></gpx>',
);
const parser = createBoundedTrackParser({
  execArgv: [
    '--import',
    'tsx',
    '--import',
    new URL('./slow-reply-preload.mts', import.meta.url).href,
  ],
  timeoutMs: 120_000,
});
void parser.parse(bytes, selection);
const [pid] = parser.processIds();
if (pid === undefined) throw new Error('NO_PARSE_PROCESS');
process.stdout.write(`child ${pid}\n`);
setTimeout(() => {
  if (mode === 'sigkill') process.kill(process.pid, 'SIGKILL');
  else process.exit(0);
}, 1_000);

/**
 * A host started the way a sized production API would be — with a heap option of its own on
 * the command line — that constructs the parser with default options (review NB-2). The
 * parser inherits the host's `process.execArgv` (which carries the `tsx` loader and the host's
 * heap option); the heap option must be left behind rather than make construction throw.
 *
 *   node --max-old-space-size=1024 --import tsx default-options-host.mts
 *
 * Prints `default <outcome>` for a small file under the default ceiling, then `tight
 * <outcome>` for a 60,000-point file under a 32 MiB ceiling: the host's 1024 MiB must not
 * reach the parse.
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
function gpx(points: number): Uint8Array {
  let body = '';
  for (let index = 0; index < points; index += 1) {
    const at = new Date(Date.parse('2026-03-01T00:00:00Z') + index * 1000).toISOString();
    body += `<trkpt lat="${37.5 + index / 1e6}" lon="${127 + index / 1e6}"><time>${at}</time></trkpt>`;
  }
  return new TextEncoder().encode(
    `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${body}</trkseg></trk></gpx>`,
  );
}

const small = await createBoundedTrackParser().parse(gpx(5), selection);
process.stdout.write(`default ${small.ok ? 'PARSED' : small.code}\n`);
const tight = await createBoundedTrackParser({
  maxOldGenerationSizeMb: 32,
  timeoutMs: 120_000,
}).parse(gpx(60_000), selection);
process.stdout.write(`tight ${tight.ok ? 'PARSED' : tight.code}\n`);

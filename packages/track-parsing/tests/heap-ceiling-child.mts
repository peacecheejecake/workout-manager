/**
 * Child process for the heap-ceiling test. Parses a synthetic GPX of a requested size and
 * prints either the parser's own error code or the sample count. The parent runs it twice
 * with different `--max-old-space-size` values; see `heap-ceiling.test.ts`.
 */
import { parseTrackFile } from '../src/parse';

const count = Number(process.argv[2] ?? '60000');
let body = '';
for (let index = 0; index < count; index += 1) {
  const at = new Date(Date.parse('2026-03-01T00:00:00Z') + index * 1000).toISOString();
  body += `<trkpt lat="${37.5 + index / 1e6}" lon="${127 + index / 1e6}"><time>${at}</time></trkpt>`;
}
const bytes = new TextEncoder().encode(
  `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${body}</trkseg></trk></gpx>`,
);
process.stdout.write(`input ${bytes.byteLength}\n`);
try {
  const file = await parseTrackFile(bytes);
  process.stdout.write(`parsed ${file.recorded[0]?.samples.length ?? 0}\n`);
} catch (error) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : error;
  process.stdout.write(`error ${String(code)}\n`);
}

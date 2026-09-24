import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';

import { parsedTrackFileSchema } from '@workout/contracts/tracks';

import { storedTrackArtifactsSchema, type StoredTrackSelection } from '../src/artifacts.js';
import { createBoundedTrackParser } from '../src/parse-host.js';
import { answerParseRequest } from '../src/parse-request.js';
import { longTrackFitBytes } from '../../../../scripts/fixtures/long-track.js';

/**
 * M2-01ai: the parse runs in its own process. These tests are about that process — that an
 * out-of-memory abort in it leaves the host alive, that it never outlives the parse or the
 * host, and that moving the parse there changed nothing it produces.
 */
const execArgv = ['--import', 'tsx'];
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

function gpxBytes(points: number, extra = ''): Uint8Array {
  let body = '';
  for (let index = 0; index < points; index += 1) {
    const at = new Date(Date.parse('2026-03-01T00:00:00Z') + index * 1000).toISOString();
    body += `<trkpt lat="${37.5 + index * 1e-6}" lon="${(127 + index * 1e-6).toFixed(9)}"><ele>${10 + (index % 7)}</ele><time>${at}</time></trkpt>`;
  }
  return new TextEncoder().encode(
    `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">${extra}<trk><trkseg>${body}</trkseg></trk></gpx>`,
  );
}

/** Whether a process id still names a live process (signal 0 checks without signalling). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function goneWithin(pid: number, milliseconds: number): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < milliseconds) {
    if (!alive(pid)) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return alive(pid) ? null : Date.now() - started;
}

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));

describe('an out-of-memory parse ends the parse process, not the host', () => {
  it(
    'survives the M2-01k-f M2b/M2d conditions at every rung, as a real host process',
    { timeout: 300_000 },
    () => {
      // The host is a separate process, so a V8 abort of it is its exit status (134), not
      // a test-runner crash. The parse side holds 8 (M2d) and 10 (M2b) copies of the long
      // track while its reply is serialized; with a worker thread that aborted the host at
      // 44–48 MiB. Repeated by hand with more runs (M2-01ai.md).
      const host = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          here('./survival-driver.mts'),
          '--runs=1',
          '--copies=8,10',
          '--rungs=40,44,48,56',
        ],
        { encoding: 'utf8', timeout: 240_000 },
      );
      expect({ status: host.status, signal: host.signal }).toEqual({ status: 0, signal: null });
      const rungs = host.stdout.split('\n').filter((line) => line.startsWith('rung '));
      expect(rungs).toHaveLength(8);
      for (const line of rungs) {
        expect(line).toMatch(/ outcome=(ok|TRACK_PARSE_MEMORY_EXCEEDED) active=0$/);
      }
      // The condition was really reached: at 48 MiB both hoards exceed the ceiling.
      expect(rungs.filter((line) => line.includes('ceilingMb=48'))).toEqual([
        expect.stringContaining('outcome=TRACK_PARSE_MEMORY_EXCEEDED'),
        expect.stringContaining('outcome=TRACK_PARSE_MEMORY_EXCEEDED'),
      ]);
      // And the host still serves afterwards.
      expect(host.stdout).toContain('after outcome=ok\nSURVIVED\n');
    },
  );
});

describe('a parse process never outlives its parse', () => {
  it('is gone once a parse succeeds', { timeout: 60_000 }, async () => {
    const parser = createBoundedTrackParser({ execArgv });
    const running = parser.parse(gpxBytes(50), selection);
    const pids = parser.processIds();
    expect(pids).toHaveLength(1);
    expect((await running).ok).toBe(true);
    for (const pid of pids) expect(alive(pid)).toBe(false);
    expect(parser.processIds()).toEqual([]);
  });

  it('is killed at the deadline, before the slot frees', { timeout: 60_000 }, async () => {
    const parser = createBoundedTrackParser({ execArgv, timeoutMs: 100 });
    const running = parser.parse(gpxBytes(20_000), selection);
    const pids = parser.processIds();
    expect(pids).toHaveLength(1);
    expect(await running).toEqual({ ok: false, code: 'TRACK_PARSE_TIMEOUT' });
    // Already gone when the outcome arrives — not merely signalled.
    for (const pid of pids) expect(alive(pid)).toBe(false);
    expect(parser.active()).toBe(0);
  });

  it('is killed when the caller cancels', { timeout: 60_000 }, async () => {
    const parser = createBoundedTrackParser({ execArgv });
    const controller = new AbortController();
    const running = parser.parse(gpxBytes(20_000), selection, { signal: controller.signal });
    const pids = parser.processIds();
    setTimeout(() => controller.abort(), 300);
    expect(await running).toEqual({ ok: false, code: 'TRACK_PARSE_CANCELLED' });
    for (const pid of pids) expect(alive(pid)).toBe(false);
  });

  it('is gone after an out-of-memory abort', { timeout: 120_000 }, async () => {
    const parser = createBoundedTrackParser({ execArgv, maxOldGenerationSizeMb: 16 });
    const running = parser.parse(longTrackFitBytes(), selection);
    const pids = parser.processIds();
    expect(await running).toEqual({ ok: false, code: 'TRACK_PARSE_MEMORY_EXCEEDED' });
    for (const pid of pids) expect(alive(pid)).toBe(false);
    expect(parser.active()).toBe(0);
  });

  it(
    'is killed on shutdown, and a closed parser admits nothing more',
    { timeout: 60_000 },
    async () => {
      const parser = createBoundedTrackParser({ execArgv });
      const running = [
        parser.parse(gpxBytes(20_000), selection),
        parser.parseFile(gpxBytes(20_000)),
      ];
      const pids = parser.processIds();
      expect(pids).toHaveLength(2);
      await parser.close();
      for (const pid of pids) expect(alive(pid)).toBe(false);
      for (const outcome of await Promise.all(running))
        expect(outcome).toEqual({ ok: false, code: 'TRACK_PARSE_CANCELLED' });
      expect(parser.active()).toBe(0);
      expect(await parser.parse(gpxBytes(3), selection)).toEqual({
        ok: false,
        code: 'TRACK_PARSE_CANCELLED',
      });
      expect(parser.processIds()).toEqual([]);
    },
  );

  for (const mode of ['sigkill', 'exit'] as const)
    it(`does not outlive a host that dies mid-parse (${mode})`, { timeout: 60_000 }, async () => {
      const host = spawn(process.execPath, ['--import', 'tsx', here('./orphan-driver.mts'), mode], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let output = '';
      host.stdout.setEncoding('utf8');
      host.stdout.on('data', (chunk: string) => {
        output += chunk;
      });
      const ended = await new Promise<{ code: number | null; signal: string | null }>((resolve) =>
        host.once('close', (code, signal) => resolve({ code, signal })),
      );
      expect(ended).toEqual(
        mode === 'sigkill' ? { code: null, signal: 'SIGKILL' } : { code: 0, signal: null },
      );
      const pid = Number(/^child (\d+)$/m.exec(output)?.[1]);
      expect(Number.isInteger(pid)).toBe(true);
      // Its parse was still pending for another ~9 s (slow-reply-preload.mts); the process
      // must be gone well before that could end it on its own.
      expect(await goneWithin(pid, 1_500)).not.toBeNull();
    });
});

describe('moving the parse into a process changed nothing it produces', () => {
  // Byte-identical as callers store it: the same JSON text, key order included, and deeply
  // strictly equal (which also tells -0 from 0 and a missing key from an undefined one).
  // `v8.serialize` is not the yardstick: it records whether V8 happened to hold an integral
  // number as a small integer or a double, and a structured clone may change that without
  // changing the value.
  const same = (left: unknown, right: unknown) => {
    expect(Buffer.from(JSON.stringify(left)).equals(Buffer.from(JSON.stringify(right)))).toBe(true);
    expect(isDeepStrictEqual(left, right)).toBe(true);
  };

  it(
    'returns byte-identical artifacts to the same parse run in-process',
    { timeout: 120_000 },
    async () => {
      const parser = createBoundedTrackParser({ execArgv });
      const fixtures: readonly [string, Uint8Array][] = [
        ['gpx-5', gpxBytes(5)],
        ['gpx-2000', gpxBytes(2_000)],
        ['fit-long-track', longTrackFitBytes()],
      ];
      for (const [name, bytes] of fixtures) {
        const hosted = await parser.parse(bytes, selection, { filename: `${name}.bin` });
        const reference = await answerParseRequest({ bytes, filename: `${name}.bin`, selection });
        if (!hosted.ok || !reference.ok || !('artifacts' in reference)) throw new Error(name);
        // The host validates the reply against the contract, as it always has; the reference
        // goes through the same schema, so what is compared is exactly what callers see.
        same(hosted.artifacts, storedTrackArtifactsSchema.parse(reference.artifacts));
        expect(hosted.artifacts.fileSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      }
    },
  );

  it('returns a byte-identical whole file for course import', { timeout: 60_000 }, async () => {
    const parser = createBoundedTrackParser({ execArgv });
    const bytes = gpxBytes(
      40,
      '<wpt lat="37.1" lon="127.1"><name>Gate</name></wpt>' +
        '<rte><name>Planned</name><rtept lat="37.2" lon="127.2"/><rtept lat="37.3" lon="127.3"/></rte>',
    );
    const hosted = await parser.parseFile(bytes, { filename: 'course.gpx' });
    const reference = await answerParseRequest({
      bytes,
      filename: 'course.gpx',
      purpose: 'whole-file',
    });
    if (!hosted.ok || !reference.ok || !('file' in reference)) throw new Error('parse failed');
    same(hosted.file, parsedTrackFileSchema.parse(reference.file));
    expect(hosted.file.routes.length + hosted.file.waypoints.length).toBeGreaterThan(0);
  });

  it(
    'parses exactly the given range of a view into a larger buffer',
    { timeout: 60_000 },
    async () => {
      // The bytes cross as one serialized copy of the view's range, never its whole backing
      // buffer: surrounding bytes would change the digest (and would leak into the parse).
      const inner = gpxBytes(20);
      const backing = new Uint8Array(inner.byteLength + 64).fill(0x41);
      backing.set(inner, 32);
      const view = backing.subarray(32, 32 + inner.byteLength);
      const outcome = await createBoundedTrackParser({ execArgv }).parse(view, selection);
      if (!outcome.ok) throw new Error(outcome.code);
      expect(outcome.artifacts.fileSha256).toBe(createHash('sha256').update(inner).digest('hex'));
      expect(outcome.artifacts.fileByteLength).toBe(inner.byteLength);
    },
  );

  it('passes the same failure codes through', { timeout: 60_000 }, async () => {
    const parser = createBoundedTrackParser({ execArgv });
    const cases: readonly [Uint8Array, StoredTrackSelection][] = [
      [gpxBytes(5), { ...selection, recordedTrackIndex: 3 }],
      [new TextEncoder().encode('<gpx version="1.1"></gpx>'), selection],
      [new TextEncoder().encode('not a track file'), selection],
    ];
    for (const [bytes, chosen] of cases) {
      const hosted = await parser.parse(bytes, chosen);
      const reference = await answerParseRequest({ bytes, filename: null, selection: chosen });
      expect(hosted.ok).toBe(false);
      expect(hosted).toEqual(reference);
    }
  });
});

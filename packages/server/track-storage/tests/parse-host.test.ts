import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { trackLimits } from '@workout/contracts/tracks';

import { createBoundedTrackParser, TrackParseRuntimeConflictError } from '../src/parse-host.js';
import { trackCorrespondenceDigest } from '../src/derive.js';
import type { StoredTrackSelection } from '../src/artifacts.js';

// The parent test process runs under vitest, not under `tsx`, so the parse process's loader is
// passed explicitly. A server started with `node --import tsx` inherits it instead.
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

function gpxBytes(points: number, options: { readonly longitudeStep?: number } = {}): Uint8Array {
  const step = options.longitudeStep ?? 1e-6;
  let body = '';
  for (let index = 0; index < points; index += 1) {
    const at = new Date(Date.parse('2026-03-01T00:00:00Z') + index * 1000).toISOString();
    body += `<trkpt lat="${37.5 + index * 1e-6}" lon="${(127 + index * step).toFixed(9)}"><time>${at}</time></trkpt>`;
  }
  return new TextEncoder().encode(
    `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${body}</trkseg></trk></gpx>`,
  );
}

describe('the server parse process has a real memory ceiling', () => {
  it(
    'parses a small track inside a bounded worker and returns the stored artifacts',
    { timeout: 60_000 },
    async () => {
      const parser = createBoundedTrackParser({ execArgv, maxOldGenerationSizeMb: 256 });
      const outcome = await parser.parse(gpxBytes(5), selection, { filename: 'run.gpx' });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.code);
      expect(outcome.artifacts.track.samples).toHaveLength(5);
      expect(outcome.artifacts.track.provenance).toEqual(selection.provenance);
      expect(outcome.artifacts.mapPath.geometry.coordinates[0]).toHaveLength(5);
      expect(outcome.artifacts.parserId).toBe('gpx-track-v1');
      // No parse process is left running after a parse.
      expect(parser.active()).toBe(0);
      expect(parser.processIds()).toEqual([]);
    },
  );

  it(
    'aborts the same bytes at a tight heap ceiling and keeps the parent process alive',
    { timeout: 180_000 },
    async () => {
      const bytes = gpxBytes(60_000);
      const generous = createBoundedTrackParser({
        execArgv,
        maxOldGenerationSizeMb: 1024,
        timeoutMs: 120_000,
      });
      const withHeadroom = await generous.parse(bytes, selection);
      // With headroom the parser's own output bound is what stops this input, and the
      // process reports it as an error code rather than dying.
      expect(withHeadroom).toEqual({ ok: false, code: 'TRACK_OUTPUT_TOO_LARGE' });

      const tight = createBoundedTrackParser({
        execArgv,
        maxOldGenerationSizeMb: 32,
        timeoutMs: 120_000,
      });
      const overLimit = await tight.parse(bytes, selection);
      // Same bytes, same code, same budget: only the runtime ceiling differs. V8 ends the
      // parse process, the host reports it as its own code, and the parent survives to answer.
      expect(overLimit).toEqual({ ok: false, code: 'TRACK_PARSE_MEMORY_EXCEEDED' });
      expect(tight.active()).toBe(0);
      const afterwards = await tight.parse(gpxBytes(3), selection);
      expect(afterwards.ok).toBe(true);
    },
  );

  it(
    'keeps the ceiling when the host process carries a heap option of its own',
    { timeout: 300_000 },
    () => {
      const child = fileURLToPath(new URL('./ceiling-child.mts', import.meta.url));
      const run = (heapOption: readonly string[]) =>
        spawnSync(process.execPath, [...heapOption, '--import', 'tsx', child], {
          encoding: 'utf8',
          timeout: 240_000,
        });
      // M2-01k-f: a worker thread shared the host's process-global heap options, so a host
      // started with --max-old-space-size could parse this input under a limit nobody asked
      // for, and the host had to refuse (TRACK_PARSE_CEILING_NOT_APPLIED). A parse process
      // inherits none of them (M2-01ai): the same 32 MiB ceiling applies under every host,
      // and the same bytes end in the memory code every time — never in a parse under
      // roughly 1 GiB (TRACK_OUTPUT_TOO_LARGE) and never as a success.
      for (const option of [[], ['--max-old-space-size=1024'], ['--max-old-space-size=128']]) {
        const host = run(option);
        expect(host.status).toBe(0);
        expect(host.stdout.trim()).toBe('outcome TRACK_PARSE_MEMORY_EXCEEDED');
      }
    },
  );

  it(
    'boots under a host started with a heap option, with default options, and keeps the ceiling',
    { timeout: 120_000 },
    () => {
      // Review NB-2: the host's own `--max-old-space-size` arrives in the inherited
      // `process.execArgv`. It is left out of the parse process instead of making
      // construction throw; the parse's ceiling still applies.
      const host = spawnSync(
        process.execPath,
        [
          '--max-old-space-size=1024',
          '--import',
          'tsx',
          fileURLToPath(new URL('./default-options-host.mts', import.meta.url)),
        ],
        { encoding: 'utf8', timeout: 100_000 },
      );
      expect(host.status).toBe(0);
      expect(host.stdout).toBe('default PARSED\ntight TRACK_PARSE_MEMORY_EXCEEDED\n');
    },
  );

  it('fails closed, parsing nothing, when the reported heap limit is above the stated budget', async () => {
    // The applied limit is verified, not assumed. A budget below what V8 reports for this
    // ceiling (32 + 192 MiB) stands in for a runtime that defeated the ceiling: the process
    // is refused before it is handed any bytes.
    const parser = createBoundedTrackParser({
      execArgv,
      maxOldGenerationSizeMb: 32,
      maxHeapLimitMb: 32,
    });
    expect(await parser.parse(gpxBytes(5), selection)).toEqual({
      ok: false,
      code: 'TRACK_PARSE_CEILING_NOT_APPLIED',
    });
    expect(parser.processIds()).toEqual([]);
  });

  it('refuses a heap budget below the ceiling it would enforce', () => {
    expect(() =>
      createBoundedTrackParser({ maxOldGenerationSizeMb: 256, maxHeapLimitMb: 200 }),
    ).toThrow(RangeError);
    // A platform whose overhead differs states its own budget rather than widening the check.
    expect(() =>
      createBoundedTrackParser({ maxOldGenerationSizeMb: 256, maxHeapLimitMb: 500 }),
    ).not.toThrow();
  });

  it('refuses to be constructed with a worker heap option of its own', () => {
    for (const option of [
      '--max-old-space-size=1024',
      '--max_old_space_size=1024',
      '--max-semi-space-size=64',
      '--max-heap-size=2048',
    ])
      expect(() => createBoundedTrackParser({ execArgv: [option, '--import', 'tsx'] })).toThrow(
        TrackParseRuntimeConflictError,
      );
  });

  it('rejects work past the worker concurrency bound instead of queueing it', async () => {
    const parser = createBoundedTrackParser({ execArgv, concurrency: 1 });
    const bytes = gpxBytes(2_000);
    const first = parser.parse(bytes, selection);
    const second = await parser.parse(bytes, selection);
    expect(second).toEqual({ ok: false, code: 'TRACK_PARSER_BUSY' });
    expect((await first).ok).toBe(true);
  });

  it(
    'at the default bound (the contract worker concurrency) runs exactly that many and refuses the next',
    { timeout: 120_000 },
    async () => {
      // M2-01k-f: the product parser is constructed without options (apps/api configured.ts),
      // so the bound that matters is the default one, not an explicit `concurrency: 1`.
      const parser = createBoundedTrackParser({ execArgv });
      const bytes = gpxBytes(2_000);
      const running = Array.from({ length: trackLimits.workerConcurrency }, () =>
        parser.parse(bytes, selection),
      );
      expect(parser.active()).toBe(trackLimits.workerConcurrency);
      expect(await parser.parse(bytes, selection)).toEqual({
        ok: false,
        code: 'TRACK_PARSER_BUSY',
      });
      for (const outcome of await Promise.all(running)) expect(outcome.ok).toBe(true);
      // The bound frees when the work ends: the next parse is admitted again.
      expect(parser.active()).toBe(0);
      expect((await parser.parse(gpxBytes(3), selection)).ok).toBe(true);
    },
  );

  it(
    'ends a parse that outlives the host deadline with its own code and frees the worker',
    { timeout: 120_000 },
    async () => {
      // M2-01k-f: the parent's wall-clock deadline, independent of the parser's own budget.
      // The long input cannot finish (worker start alone takes longer than 100 ms), so only
      // the host timer can end it; without that timer this parse succeeds.
      const parser = createBoundedTrackParser({ execArgv, timeoutMs: 100 });
      const started = Date.now();
      const outcome = await parser.parse(gpxBytes(20_000), selection);
      expect(outcome).toEqual({ ok: false, code: 'TRACK_PARSE_TIMEOUT' });
      // Ended by the deadline, not after the parse: well under the parser's own 5 s budget.
      expect(Date.now() - started).toBeLessThan(trackLimits.parseMilliseconds);
      expect(parser.active()).toBe(0);
    },
  );

  it('reports a caller cancellation as its own outcome, not as a parse failure', async () => {
    const parser = createBoundedTrackParser({ execArgv });
    const controller = new AbortController();
    const running = parser.parse(gpxBytes(20_000), selection, { signal: controller.signal });
    controller.abort();
    expect(await running).toEqual({ ok: false, code: 'TRACK_PARSE_CANCELLED' });
    expect(parser.active()).toBe(0);
  });

  it('refuses a selection that names no recording in the file', async () => {
    const parser = createBoundedTrackParser({ execArgv });
    const outcome = await parser.parse(gpxBytes(5), { ...selection, recordedTrackIndex: 3 });
    expect(outcome).toEqual({ ok: false, code: 'TRACK_SELECTION_INVALID' });
  });
});

describe('sample correspondence decides the track revision', () => {
  it('produces the same digest for the same bytes and a different one when a sample moves', async () => {
    const parser = createBoundedTrackParser({ execArgv });
    const first = await parser.parse(gpxBytes(6), selection);
    const again = await parser.parse(gpxBytes(6), selection);
    // A re-parse of the same file: same correspondence, so the same digest and no new revision.
    if (!first.ok || !again.ok) throw new Error('parse failed');
    const parser1 = { parserId: first.artifacts.parserId, parserVersion: 1 } as const;
    expect(trackCorrespondenceDigest(first.artifacts.track, parser1).digest).toBe(
      trackCorrespondenceDigest(again.artifacts.track, parser1).digest,
    );

    // A file whose points are far enough apart splits into other segments: the same sample
    // ids now denote a different correspondence, which is a new revision, not an overwrite.
    const resplit = await parser.parse(gpxBytes(6, { longitudeStep: 0.01 }), selection);
    if (!resplit.ok) throw new Error(resplit.code);
    expect(resplit.artifacts.track.segments.length).toBeGreaterThan(
      first.artifacts.track.segments.length,
    );
    expect(trackCorrespondenceDigest(resplit.artifacts.track, parser1).digest).not.toBe(
      trackCorrespondenceDigest(first.artifacts.track, parser1).digest,
    );
  });

  it('changes when only the segment split changes, with identical samples', async () => {
    const parser = createBoundedTrackParser({ execArgv });
    const outcome = await parser.parse(gpxBytes(6), selection);
    if (!outcome.ok) throw new Error(outcome.code);
    const parserIdentity = { parserId: outcome.artifacts.parserId, parserVersion: 1 } as const;
    const track = outcome.artifacts.track;
    const [segment] = track.segments;
    if (!segment || segment.sampleIds.length < 4) throw new Error('expected one long segment');
    // Same samples, same order, same ids — only the connectivity differs. That is a
    // different correspondence, because which samples form one line has changed.
    const split = {
      ...track,
      segments: [
        { ...segment, sampleIds: segment.sampleIds.slice(0, 3) },
        {
          index: 1,
          startReason: 'time-gap' as const,
          sampleIds: segment.sampleIds.slice(3),
        },
      ],
    };
    expect(trackCorrespondenceDigest(split, parserIdentity).digest).not.toBe(
      trackCorrespondenceDigest(track, parserIdentity).digest,
    );
  });

  it('excludes the stored provenance so a revision number cannot change its own digest', async () => {
    const parser = createBoundedTrackParser({ execArgv });
    const outcome = await parser.parse(gpxBytes(4), selection);
    if (!outcome.ok) throw new Error(outcome.code);
    const parserIdentity = { parserId: outcome.artifacts.parserId, parserVersion: 1 } as const;
    const first = trackCorrespondenceDigest(outcome.artifacts.track, parserIdentity);
    const later = trackCorrespondenceDigest(
      {
        ...outcome.artifacts.track,
        provenance: { ...selection.provenance, trackRevision: 7 },
      },
      parserIdentity,
    );
    expect(later.digest).toBe(first.digest);
  });
});

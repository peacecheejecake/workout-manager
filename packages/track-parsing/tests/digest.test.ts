import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TrackIngestionError } from '../src/limits';
import { hashTrackFileSha256, parseTrackFile, parseTrackFileWithDigest } from '../src/parse';

const GPX11 = 'http://www.topografix.com/GPX/1/1';
const sample = new TextEncoder().encode(
  `<gpx version="1.1" xmlns="${GPX11}"><trk><trkseg>` +
    `<trkpt lat="37.5" lon="127.0"><time>2026-03-01T00:00:00Z</time></trkpt>` +
    `<trkpt lat="37.501" lon="127.001"><time>2026-03-01T00:00:10Z</time></trkpt>` +
    `</trkseg></trk></gpx>`,
);

const code = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'no-error';
  } catch (error) {
    return error instanceof TrackIngestionError ? error.code : `unexpected:${String(error)}`;
  }
};

describe('platform-neutral file digest', () => {
  it('matches the Node digest for the same bytes', async () => {
    const expected = createHash('sha256').update(sample).digest('hex');
    await expect(hashTrackFileSha256(sample)).resolves.toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same parsed file through the async entry point as through the core', async () => {
    const viaEntry = await parseTrackFile(sample, { filename: 'run.gpx' });
    const viaCore = parseTrackFileWithDigest(
      sample,
      createHash('sha256').update(sample).digest('hex'),
      { filename: 'run.gpx' },
    );
    expect(JSON.stringify(viaEntry)).toBe(JSON.stringify(viaCore));
    expect(viaEntry.fileSha256).toBe(createHash('sha256').update(sample).digest('hex'));
  });

  it('hashes only the file range of a pooled Buffer, not its backing pool', async () => {
    // Node hands out `Buffer`s that are views into a shared 8 KiB pool, and `Buffer` is a
    // `Uint8Array`, so this public helper receives them. `Buffer.prototype.slice` returns
    // another view rather than a copy, so hashing `slice().buffer` would digest the whole
    // pool instead of the file.
    const pooled = Buffer.from(sample);
    expect(pooled.byteLength).toBeLessThan(pooled.buffer.byteLength);
    expect(pooled.byteOffset).toBeGreaterThan(0);
    expect(pooled.slice().buffer.byteLength).toBe(pooled.buffer.byteLength);

    const expected = createHash('sha256').update(sample).digest('hex');
    await expect(hashTrackFileSha256(pooled)).resolves.toBe(expected);
  });

  it('parses a pooled Buffer with the digest of that file', async () => {
    const pooled = Buffer.from(sample);
    const file = await parseTrackFile(pooled, { filename: 'run.gpx' });
    expect(file.fileSha256).toBe(createHash('sha256').update(sample).digest('hex'));
    expect(file.fileByteLength).toBe(sample.byteLength);
    expect(file.recorded[0]?.samples).toHaveLength(2);
  });

  it('hashes and parses the same bytes even if the caller mutates its buffer', async () => {
    // The digest is asynchronous, so a caller that reuses its buffer could otherwise get a
    // file whose coordinates and whose `fileSha256` describe different content.
    const mutable = new Uint8Array(sample);
    const before = createHash('sha256').update(mutable).digest('hex');
    const pending = parseTrackFile(mutable, { filename: 'run.gpx' });
    // 127.0 -> 128.0 in the first trkpt, applied immediately after the call.
    const text = new TextDecoder().decode(mutable);
    const moved = new TextEncoder().encode(text.replace('lon="127.0"', 'lon="128.0"'));
    expect(moved.byteLength).toBe(mutable.byteLength);
    mutable.set(moved);
    const file = await pending;

    const parsedLongitude = file.recorded[0]?.samples[0]?.position?.[0];
    expect(parsedLongitude).toBe(127);
    expect(file.fileSha256).toBe(before);
    expect(file.fileSha256).not.toBe(createHash('sha256').update(mutable).digest('hex'));
  });

  it('refuses an empty or oversized file before hashing it', async () => {
    expect(await code(() => parseTrackFile(new Uint8Array()))).toBe('TRACK_FILE_EMPTY');
    expect(
      await code(() => parseTrackFile(sample, { limits: { fileBytes: sample.byteLength - 1 } })),
    ).toBe('TRACK_FILE_TOO_LARGE');
  });

  it('imports no Node built-in anywhere in the parsing source', () => {
    const directory = new URL('../src/', import.meta.url).pathname;
    const offenders: string[] = [];
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.ts')) continue;
      const source = readFileSync(join(directory, name), 'utf8');
      // The package runs in a browser worker; a Node built-in here would break the bundle.
      if (/from '(?:node:|fs|path|crypto|buffer|stream|os|util)'/.test(source))
        offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});

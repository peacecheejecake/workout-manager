import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { createGalleryVideoRenditionCodec } from '../src/gallery-video-rendition.js';

const execute = promisify(execFile);
// Trusted local test configuration is separate from uploaded media and never accepts a source URL.
async function testBinary(name: 'ffmpeg' | 'ffprobe', setting: string) {
  const explicit = process.env[setting];
  if (explicit !== undefined && !isAbsolute(explicit)) {
    throw new Error(`video_test_${name}_config_invalid`);
  }
  const candidates =
    explicit !== undefined
      ? [explicit]
      : (process.env['PATH'] ?? '')
          .split(delimiter)
          .filter(isAbsolute)
          .map((path) => join(path, name));
  for (const candidate of candidates) {
    let path: string;
    try {
      path = await realpath(candidate);
      await access(path, constants.X_OK);
      const info = await stat(path);
      if (!info.isFile() || info.size < 1 || info.size > 128 * 1024 * 1024) continue;
    } catch {
      continue;
    }
    let version: string;
    try {
      const result = await execute(path, ['-version'], { maxBuffer: 64 * 1024, timeout: 5000 });
      version = result.stdout;
    } catch {
      throw new Error(`video_test_${name}_unavailable`);
    }
    if (!new RegExp(`^${name} version 9\\.0\\.2(?: |\\n)`).test(version)) {
      throw new Error(`video_test_${name}_version_required_9_0_2`);
    }
    return {
      path,
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    };
  }
  throw new Error(`video_test_${name}_missing`);
}
const ffmpeg = await testBinary('ffmpeg', 'WM_TEST_FFMPEG_PATH');
const ffprobe = await testBinary('ffprobe', 'WM_TEST_FFPROBE_PATH');
const ffmpegPath = ffmpeg.path;
const ffprobePath = ffprobe.path;
const codec = createGalleryVideoRenditionCodec({ ffmpegPath, ffprobePath });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function clip(
  options: { audio?: boolean; codec?: string; size?: string; fps?: string; sar?: string } = {},
) {
  const { stdout } = await execute(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${options.size ?? '96x64'}:rate=${options.fps ?? '12'}:duration=0.5`,
      ...(options.audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5'] : []),
      ...(options.sar ? ['-vf', `setsar=${options.sar}`] : []),
      '-c:v',
      options.codec ?? 'libx264',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '1',
      ...(options.audio ? ['-c:a', 'aac'] : ['-an']),
      '-metadata',
      'comment=synthetic-private-sentinel',
      '-metadata',
      'location=+01.0000+002.0000/',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseTags(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('synthetic_probe_tags');
  const tags: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error('synthetic_probe_tag');
    tags[key] = item;
  }
  return tags;
}
async function inspect(bytes: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), 'wm-video-test-'));
  try {
    const path = join(directory, 'clip');
    await writeFile(path, bytes, { mode: 0o600 });
    const { stdout } = await execute(
      ffprobePath,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
      { maxBuffer: 64 * 1024 },
    );
    const raw: unknown = JSON.parse(stdout);
    if (!isRecord(raw) || !Array.isArray(raw.streams) || !isRecord(raw.format)) {
      throw new Error('synthetic_probe_shape');
    }
    const streams = raw.streams.map((stream: unknown) => {
      if (
        !isRecord(stream) ||
        typeof stream.codec_type !== 'string' ||
        typeof stream.codec_name !== 'string'
      ) {
        throw new Error('synthetic_probe_stream');
      }
      const sideData = stream.side_data_list;
      return {
        codec_type: stream.codec_type,
        codec_name: stream.codec_name,
        width: typeof stream.width === 'number' ? stream.width : undefined,
        sample_aspect_ratio:
          typeof stream.sample_aspect_ratio === 'string' ? stream.sample_aspect_ratio : undefined,
        height: typeof stream.height === 'number' ? stream.height : undefined,
        tags: parseTags(stream.tags),
        side_data_list: Array.isArray(sideData)
          ? sideData.map((item: unknown) => {
              if (!isRecord(item)) throw new Error('synthetic_probe_side_data');
              return { rotation: typeof item.rotation === 'number' ? item.rotation : undefined };
            })
          : undefined,
      };
    });
    return { streams, format: { tags: parseTags(raw.format.tags) } };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function scratch() {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('wm-gallery-video-')).sort();
}

describe('actual native gallery video core', () => {
  it.each([false, true])(
    'transcodes actual synthetic H264 with audio=%s, strips source metadata and preserves original',
    async (audio) => {
      const input = await clip({ audio });
      const before = Buffer.from(input);
      const prior = await scratch();
      const result = await codec.render(input);
      expect(input).toEqual(before);
      expect(result.original).toEqual({ sha256: digest(before), byteSize: before.length });
      expect(result.sourceObservation).toEqual({
        format: 'mov,mp4,m4a,3gp,3g2,mj2',
        videoCodec: 'h264',
        audioCodec: audio ? 'aac' : null,
        width: 96,
        height: 64,
        sampleAspectNumerator: 1,
        sampleAspectDenominator: 1,
        rotationDegrees: null,
        rotatedWidth: 96,
        rotatedHeight: 64,
        displayAspect: 1.5,
        fps: 12,
        durationSeconds: 0.5,
        frameCount: 6,
        hasAudio: audio,
      });
      expect(result.output.mediaType).toBe('video/mp4');
      expect(result.output.sha256).toBe(digest(result.output.bytes));
      expect(result.output.hasAudio).toBe(audio);
      expect(result.output.width).toBe(96);
      expect(result.output.height).toBe(64);
      expect(result.output.frameCount).toBe(6);
      expect(result.output.durationSeconds).toBeGreaterThan(0);
      expect(result.output.durationSeconds).toBeLessThan(1);
      const metadata = await inspect(result.output.bytes);
      expect(
        metadata.streams.filter((s) => s.codec_type === 'video').map((s) => s.codec_name),
      ).toEqual(['h264']);
      expect(
        metadata.streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name),
      ).toEqual(audio ? ['aac'] : []);
      expect(metadata.format.tags?.['comment']).toBeUndefined();
      expect(metadata.format.tags?.['location']).toBeUndefined();
      expect(result.build.ffmpeg.version).toBe('9.0.2');
      expect(result.build.ffprobe.version).toBe('9.0.2');
      expect(result.build.ffmpeg.sha256).toBe(ffmpeg.sha256);
      expect(result.build.ffprobe.sha256).toBe(ffprobe.sha256);
      expect(await scratch()).toEqual(prior);
    },
  );
  it('actually decodes the derivative and bounds FPS/aspect without enlarging source', async () => {
    const result = await codec.render(await clip({ size: '192x96', fps: '60' }));
    expect(Number.isFinite(result.output.width / result.output.height)).toBe(true);
    expect(result.output.width).toBeGreaterThan(0);
    expect(result.output.height).toBeGreaterThan(0);
    expect(result.output.width / result.output.height).toBe(2);
    const probed = await inspect(result.output.bytes);
    expect(
      probed.streams.find((stream) => stream.codec_type === 'video')?.sample_aspect_ratio,
    ).toBe('1:1');
    expect(result.output.width).toBeLessThanOrEqual(192);
    expect(result.output.frameCount).toBe(15);
    expect(result.sourceObservation).toMatchObject({
      width: 192,
      height: 96,
      rotatedWidth: 192,
      rotatedHeight: 96,
      displayAspect: 2,
      fps: 60,
      frameCount: 30,
      durationSeconds: 0.5,
      rotationDegrees: null,
    });
    const directory = await mkdtemp(join(tmpdir(), 'wm-video-decode-'));
    try {
      const path = join(directory, 'output');
      await writeFile(path, result.output.bytes, { mode: 0o600 });
      const { stdout } = await execute(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          path,
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          'pipe:1',
        ],
        { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 },
      );
      expect(stdout.length).toBe(result.output.width * result.output.height * 3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('observes actual non-square source pixels independently of normalized output', async () => {
    const input = await clip({ sar: '2/1' });
    const result = await codec.render(input);
    expect(result.original).toEqual({ sha256: digest(input), byteSize: input.length });
    expect(result.sourceObservation).toMatchObject({
      width: 96,
      height: 64,
      sampleAspectNumerator: 2,
      sampleAspectDenominator: 1,
      rotatedWidth: 96,
      rotatedHeight: 64,
      displayAspect: 3,
      rotationDegrees: null,
    });
    const metadata = await inspect(result.output.bytes);
    expect(
      metadata.streams.find((stream) => stream.codec_type === 'video')?.sample_aspect_ratio,
    ).toBe('1:1');
    expect(result.output.width / result.output.height).toBeCloseTo(3, 1);
    expect(result.output.width).toBeLessThanOrEqual(96);
    expect(result.output.height).toBeLessThanOrEqual(64);
    expect(Object.keys(result.sourceObservation).sort()).toEqual(
      [
        'format',
        'videoCodec',
        'audioCodec',
        'width',
        'height',
        'sampleAspectNumerator',
        'sampleAspectDenominator',
        'rotationDegrees',
        'rotatedWidth',
        'rotatedHeight',
        'displayAspect',
        'fps',
        'durationSeconds',
        'frameCount',
        'hasAudio',
      ].sort(),
    );
  });
  it('physically autorotates an actual MP4 display matrix and removes its rotation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wm-video-rotate-'));
    try {
      const input = join(directory, 'input.mp4');
      const rotated = join(directory, 'rotated.mp4');
      await writeFile(input, await clip(), { mode: 0o600 });
      await execute(ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-display_rotation:v:0',
        '90',
        '-i',
        input,
        '-c',
        'copy',
        rotated,
      ]);
      const bytes = await readFile(rotated);
      const sourceMetadata = await inspect(bytes);
      expect(
        sourceMetadata.streams
          .flatMap((stream) => stream.side_data_list ?? [])
          .some((side) => side.rotation === 90 || side.rotation === -90),
      ).toBe(true);
      const result = await codec.render(bytes);
      expect([result.output.width, result.output.height]).toEqual([64, 96]);
      expect(result.sourceObservation).toMatchObject({
        width: 96,
        height: 64,
        rotatedWidth: 64,
        rotatedHeight: 96,
        displayAspect: 64 / 96,
      });
      const rotation = result.sourceObservation.rotationDegrees;
      expect(rotation === 90 || rotation === -90).toBe(true);
      const metadata = await inspect(result.output.bytes);
      expect(
        metadata.streams
          .flatMap((s) => s.side_data_list ?? [])
          .some((s) => s.rotation !== undefined && s.rotation !== 0),
      ).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('rejects valid unsupported MPEG4, truncated input, oversized/shared/proxy input', async () => {
    await expect(codec.render(await clip({ codec: 'mpeg4' }))).rejects.toHaveProperty(
      'code',
      'unsupported_format',
    );
    const input = await clip();
    await expect(codec.render(input.subarray(0, 100))).rejects.toHaveProperty(
      'name',
      'GalleryVideoRenditionError',
    );
    await expect(codec.render(new Uint8Array(64 * 1024 * 1024 + 1))).rejects.toHaveProperty(
      'code',
      'input_budget',
    );
    await expect(codec.render(new Uint8Array(new SharedArrayBuffer(4)))).rejects.toHaveProperty(
      'code',
      'input_invalid',
    );
    await expect(codec.render(new Proxy(input, {}))).rejects.toHaveProperty(
      'code',
      'input_invalid',
    );
  });
  it('does not open caller URLs or accept HLS/concat references', async () => {
    for (const data of [
      '#EXTM3U\n#EXTINF:1,\nhttps://example.invalid/private\n',
      'ffconcat version 1.0\nfile https://example.invalid/private\n',
    ]) {
      await expect(codec.render(Buffer.from(data))).rejects.toHaveProperty(
        'name',
        'GalleryVideoRenditionError',
      );
    }
  });
  it('snapshots source before await and cleans aborts without leaving owned temporary files', async () => {
    const input = await clip();
    const saved = Buffer.from(input);
    const pending = codec.render(input);
    input.fill(0);
    expect((await pending).original.sha256).toBe(digest(saved));
    const prior = await scratch();
    const controller = new AbortController();
    const aborted = codec.render(saved, { signal: controller.signal });
    setImmediate(() => controller.abort());
    await expect(aborted).rejects.toHaveProperty('code', 'aborted');
    expect(await scratch()).toEqual(prior);
    await expect(codec.render(saved, { signal: AbortSignal.abort() })).rejects.toHaveProperty(
      'code',
      'aborted',
    );
  });
  it('enforces deadline cancellation and cleanup with a virtual clock (not elapsed native-time proof)', async () => {
    const input = await clip();
    const prior = await scratch();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = codec.render(input);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).rejects.toHaveProperty('code', 'timeout');
    } finally {
      vi.useRealTimers();
    }
    expect(await scratch()).toEqual(prior);
  });
});

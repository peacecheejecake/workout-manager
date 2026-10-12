import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { types } from 'node:util';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PROBE_BYTES = 64 * 1024;
const DEADLINE_MS = 30_000;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bytesGetter = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')?.get;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArray, 'buffer')?.get;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')?.get;
export type GalleryVideoRenditionCode =
  | 'input_invalid'
  | 'input_budget'
  | 'codec_unavailable'
  | 'unsupported_format'
  | 'invalid_media'
  | 'decode_failed'
  | 'output_budget'
  | 'aborted'
  | 'timeout';
export class GalleryVideoRenditionError extends Error {
  constructor(readonly code: GalleryVideoRenditionCode) {
    super(code);
    this.name = 'GalleryVideoRenditionError';
  }
}
function fail(code: GalleryVideoRenditionCode): never {
  throw new GalleryVideoRenditionError(code);
}
function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}
function snapshot(input: unknown): Buffer {
  if (!types.isUint8Array(input) || types.isProxy(input)) fail('input_invalid');
  if (![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(input)))
    fail('input_invalid');
  for (const key of ['buffer', 'byteLength', 'byteOffset', 'length'])
    if (Object.getOwnPropertyDescriptor(input, key)) fail('input_invalid');
  if (!bytesGetter || !bufferGetter || !offsetGetter) fail('input_invalid');
  const length: unknown = bytesGetter.call(input);
  const buffer: unknown = bufferGetter.call(input);
  const offset: unknown = offsetGetter.call(input);
  if (!types.isArrayBuffer(buffer) || types.isSharedArrayBuffer(buffer)) fail('input_invalid');
  if (typeof length !== 'number' || typeof offset !== 'number' || length < 1) fail('input_invalid');
  if (length > MAX_BYTES) fail('input_budget');
  try {
    return Buffer.from(new Uint8Array(buffer, offset, length));
  } catch {
    return fail('input_invalid');
  }
}
interface Cancellation {
  signal: AbortSignal;
  reason(): 'aborted' | 'timeout';
}
function run(
  binary: string,
  args: readonly string[],
  limit: number,
  cancel: Cancellation,
  inputFd?: number,
): Promise<Buffer> {
  if (cancel.signal.aborted) fail(cancel.reason());
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, [...args], {
        shell: false,
        detached: true,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        stdio:
          inputFd === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', inputFd],
      });
    } catch {
      reject(new GalleryVideoRenditionError('codec_unavailable'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let stderrBytes = 0;
    let failure: GalleryVideoRenditionCode | null = null;
    let closed = false;
    const stop = (reason: GalleryVideoRenditionCode) => {
      failure ??= reason;
      if (!closed && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* close/error decides the result */
        }
      }
    };
    const abort = () => stop(cancel.reason());
    cancel.signal.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) stop('output_budget');
      else if (!failure) chunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_PROBE_BYTES) stop('decode_failed');
    });
    child.on('error', () => {
      failure ??= 'codec_unavailable';
    });
    child.on('close', (code, signal) => {
      closed = true;
      cancel.signal.removeEventListener('abort', abort);
      if (failure || code !== 0 || signal !== null)
        reject(new GalleryVideoRenditionError(failure ?? 'decode_failed'));
      else resolve(Buffer.concat(chunks, size));
    });
    if (cancel.signal.aborted) abort();
  });
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) fail('invalid_media');
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail('invalid_media');
  return value;
}
function decimal(value: unknown): number | null {
  if (value === undefined || value === 'N/A') return null;
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) fail('invalid_media');
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) fail('invalid_media');
  return number;
}
function rate(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+\/\d+$/.test(value)) fail('invalid_media');
  const [numerator, denominator] = value.split('/').map(Number);
  if (
    !numerator ||
    !denominator ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator)
  )
    fail('invalid_media');
  const result = numerator / denominator;
  if (result <= 0 || result > 240) fail('invalid_media');
  return result;
}
interface VideoFacts {
  format: string;
  videoCodec: string;
  audioCodec: string | null;
  sampleAspectNumerator: number;
  sampleAspectDenominator: number;
  rotationDegrees: number | null;
  index: number;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  frameCount: number;
  audioIndex: number | null;
  displayAspect: number;
  rotatedWidth: number;
  rotatedHeight: number;
}
function parseProbe(bytes: Buffer, output = false): VideoFacts {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail('invalid_media');
  }
  const root = object(value);
  const format = object(root['format']);
  if (
    typeof format['format_name'] !== 'string' ||
    !['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm'].includes(format['format_name'])
  )
    fail('unsupported_format');
  if (output && format['format_name'] !== 'mov,mp4,m4a,3gp,3g2,mj2') fail('invalid_media');
  if (!Array.isArray(root['streams']) || root['streams'].length > 8) fail('invalid_media');
  const streams = root['streams'].map(object);
  const videos = streams.filter((stream) => stream['codec_type'] === 'video');
  const audios = streams.filter((stream) => stream['codec_type'] === 'audio');
  if (videos.length !== 1 || audios.length > 1) fail('unsupported_format');
  const video = videos[0];
  if (!video) fail('invalid_media');
  const codecs = output ? ['h264'] : ['h264', 'hevc', 'vp8', 'vp9', 'av1'];
  if (typeof video['codec_name'] !== 'string' || !codecs.includes(video['codec_name']))
    fail('unsupported_format');
  if (
    typeof video['pix_fmt'] !== 'string' ||
    !['yuv420p', 'yuvj420p', 'yuv422p', 'yuv444p', 'nv12'].includes(video['pix_fmt'])
  )
    fail('unsupported_format');
  const sar = video['sample_aspect_ratio'];
  if (typeof sar !== 'string' || !/^\d+:\d+$/.test(sar)) fail('invalid_media');
  const [sarNumerator, sarDenominator] = sar.split(':').map(Number);
  if (
    !sarNumerator ||
    !sarDenominator ||
    !Number.isSafeInteger(sarNumerator) ||
    !Number.isSafeInteger(sarDenominator)
  )
    fail('invalid_media');
  const aspectScale = sarNumerator / sarDenominator;
  if (aspectScale < 0.01 || aspectScale > 100) fail('invalid_media');
  let rotation = 0;
  let rotationDegrees: number | null = null;
  if (video['side_data_list'] !== undefined) {
    if (!Array.isArray(video['side_data_list']) || video['side_data_list'].length > 8)
      fail('invalid_media');
    const rotations = video['side_data_list']
      .map(object)
      .filter((side) => side['rotation'] !== undefined);
    if (rotations.length > 1) fail('invalid_media');
    const actualRotation = rotations[0]?.['rotation'];
    if (actualRotation !== undefined) {
      if (
        typeof actualRotation !== 'number' ||
        !Number.isSafeInteger(actualRotation) ||
        Math.abs(actualRotation) > 360 ||
        actualRotation % 90 !== 0
      )
        fail('unsupported_format');
      rotation = actualRotation;
      rotationDegrees = actualRotation;
    }
  }
  if (output && (rotation !== 0 || aspectScale !== 1 || video['pix_fmt'] !== 'yuv420p'))
    fail('invalid_media');
  const width = positive(video['width']);
  const height = positive(video['height']);
  if (width * height > 8_294_400 || (output && (width > 1280 || height > 1280)))
    fail('invalid_media');
  const fps = rate(video['avg_frame_rate']);
  if (output && fps > 30.001) fail('invalid_media');
  const durationSeconds = decimal(video['duration']) ?? decimal(format['duration']);
  if (durationSeconds === null || durationSeconds > 3600) fail('invalid_media');
  const frames = video['nb_read_frames'];
  if (typeof frames !== 'string' || !/^\d+$/.test(frames)) fail('invalid_media');
  const frameCount = positive(Number(frames));
  if (frameCount > 864000) fail('invalid_media');
  const index = video['index'];
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) fail('invalid_media');
  const audio = audios[0];
  let audioIndex: number | null = null;
  let audioCodec: string | null = null;
  if (audio) {
    if (
      typeof audio['codec_name'] !== 'string' ||
      !(output ? ['aac'] : ['aac', 'opus', 'vorbis']).includes(audio['codec_name'])
    )
      fail('unsupported_format');
    if (
      typeof audio['index'] !== 'number' ||
      !Number.isSafeInteger(audio['index']) ||
      audio['index'] < 0
    )
      fail('invalid_media');
    audioIndex = audio['index'];
    audioCodec = audio['codec_name'];
  }
  const quarterTurn = Math.abs(rotation) % 180 === 90;
  const displayAspect = quarterTurn
    ? height / (width * aspectScale)
    : (width * aspectScale) / height;
  if (!Number.isFinite(displayAspect) || displayAspect <= 0) fail('invalid_media');
  return {
    format: format['format_name'],
    videoCodec: video['codec_name'],
    audioCodec,
    sampleAspectNumerator: sarNumerator,
    sampleAspectDenominator: sarDenominator,
    rotationDegrees,
    index,
    width,
    height,
    fps,
    durationSeconds,
    frameCount,
    audioIndex,
    displayAspect,
    rotatedWidth: positive(quarterTurn ? height : width),
    rotatedHeight: positive(quarterTurn ? width : height),
  };
}
async function binaryIdentity(binary: string, name: 'ffmpeg' | 'ffprobe', cancel: Cancellation) {
  const handle = await open(binary, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() =>
    fail('codec_unavailable'),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 128 * 1024 * 1024) fail('codec_unavailable');
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    const version = await run(binary, ['-version'], MAX_PROBE_BYTES, cancel);
    const text = version.toString('utf8');
    const match = new RegExp(`^${name} version (9\\.0\\.2)(?: |\\n)`).exec(text);
    if (!match?.[1]) fail('codec_unavailable');
    return { sha256: digest.digest('hex'), version: match[1], buildSha256: hash(version) };
  } finally {
    await handle.close();
  }
}
async function probe(binary: string, path: string, cancel: Cancellation, output = false) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await run(
      binary,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'fd',
        '-format_whitelist',
        'mov,matroska',
        '-fd',
        '3',
        '-count_frames',
        '-show_entries',
        'stream=index,codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,sample_aspect_ratio,nb_read_frames,duration:stream_side_data=rotation:format=format_name,duration',
        '-of',
        'json',
        'fd:',
      ],
      MAX_PROBE_BYTES,
      cancel,
      handle.fd,
    );
    return parseProbe(bytes, output);
  } finally {
    await handle.close();
  }
}
/** Trusted worker configuration, never an HTTP path or caller-supplied command. */
export function createGalleryVideoRenditionCodec(config: {
  ffmpegPath: string;
  ffprobePath: string;
}) {
  const { ffmpegPath, ffprobePath } = config;
  if (!isAbsolute(ffmpegPath) || !isAbsolute(ffprobePath)) fail('codec_unavailable');
  return {
    async render(unknownBytes: unknown, options: { signal?: AbortSignal } = {}) {
      if (options.signal?.aborted) fail('aborted');
      const input = snapshot(unknownBytes);
      const original = { sha256: hash(input), byteSize: input.length };
      const controller = new AbortController();
      let reason: 'aborted' | 'timeout' = 'aborted';
      const cancel: Cancellation = { signal: controller.signal, reason: () => reason };
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        reason = 'timeout';
        controller.abort();
      }, DEADLINE_MS);
      let directory: string | null = null;
      try {
        directory = await mkdtemp(join(tmpdir(), 'wm-gallery-video-'));
        await chmod(directory, 0o700);
        const inputPath = join(directory, 'input');
        const outputPath = join(directory, 'output');
        await using inputFile = await open(inputPath, 'wx', 0o600);
        await inputFile.writeFile(input);
        const ffmpeg = await binaryIdentity(ffmpegPath, 'ffmpeg', cancel);
        const ffprobe = await binaryIdentity(ffprobePath, 'ffprobe', cancel);
        const source = await probe(ffprobePath, inputPath, cancel);
        const handle = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes: Buffer;
        try {
          const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-xerror',
            '-protocol_whitelist',
            'fd',
            '-format_whitelist',
            'mov,matroska',
            '-fd',
            '3',
            '-i',
            'fd:',
            '-map',
            `0:${source.index}`,
            ...(source.audioIndex === null ? [] : ['-map', `0:${source.audioIndex}`]),
            '-map_metadata',
            '-1',
            '-map_chapters',
            '-1',
            '-sn',
            '-dn',
            '-vf',
            `scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,fps=${Math.min(source.fps, 30)}`,
            '-c:v',
            'libx264',
            '-preset',
            'medium',
            '-crf',
            '23',
            '-pix_fmt',
            'yuv420p',
            '-threads',
            '1',
            ...(source.audioIndex === null ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k']),
            '-movflags',
            'frag_keyframe+empty_moov+default_base_moof',
            '-f',
            'mp4',
            '-fd',
            '1',
            'fd:',
          ];
          bytes = await run(ffmpegPath, args, MAX_BYTES, cancel, handle.fd);
        } finally {
          await handle.close();
        }
        if (bytes.length === 0) fail('decode_failed');
        await using outputFile = await open(outputPath, 'wx', 0o600);
        await outputFile.writeFile(bytes);
        const result = await probe(ffprobePath, outputPath, cancel, true);
        if ((source.audioIndex !== null) !== (result.audioIndex !== null)) fail('invalid_media');
        if (
          result.width > source.rotatedWidth ||
          result.height > source.rotatedHeight ||
          Math.abs(result.displayAspect - source.displayAspect) >
            2 / Math.min(result.width, result.height)
        )
          fail('invalid_media');
        if (result.durationSeconds > source.durationSeconds + 1 / Math.min(source.fps, 30))
          fail('invalid_media');
        if (cancel.signal.aborted) fail(cancel.reason());
        return {
          recipeVersion: 1 as const,
          kind: 'video_playback' as const,
          original,
          sourceObservation: {
            format: source.format,
            videoCodec: source.videoCodec,
            audioCodec: source.audioCodec,
            width: source.width,
            height: source.height,
            sampleAspectNumerator: source.sampleAspectNumerator,
            sampleAspectDenominator: source.sampleAspectDenominator,
            rotationDegrees: source.rotationDegrees,
            rotatedWidth: source.rotatedWidth,
            rotatedHeight: source.rotatedHeight,
            displayAspect: source.displayAspect,
            fps: source.fps,
            durationSeconds: source.durationSeconds,
            frameCount: source.frameCount,
            hasAudio: source.audioIndex !== null,
          },
          output: {
            mediaType: 'video/mp4' as const,
            sha256: hash(bytes),
            byteSize: bytes.length,
            bytes: Uint8Array.from(bytes),
            width: result.width,
            height: result.height,
            durationSeconds: result.durationSeconds,
            frameCount: result.frameCount,
            hasAudio: result.audioIndex !== null,
          },
          build: { ffmpeg, ffprobe },
        };
      } catch (error) {
        if (error instanceof GalleryVideoRenditionError) throw error;
        if (controller.signal.aborted) fail(reason);
        fail('decode_failed');
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

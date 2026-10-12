import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { types } from 'node:util';
import type { renderGalleryImageRendition } from './gallery-image-rendition.js';
import type { createGalleryVideoRenditionCodec } from './gallery-video-rendition.js';

type ImageResult = Awaited<ReturnType<typeof renderGalleryImageRendition>>;
type VideoResult = Awaited<
  ReturnType<ReturnType<typeof createGalleryVideoRenditionCodec>['render']>
>;
export type GallerySupervisedRendition = ImageResult | VideoResult;
export type GalleryCodecKind = 'image_preview' | 'image_thumbnail' | 'video_playback';
const KINDS: readonly GalleryCodecKind[] = ['image_preview', 'image_thumbnail', 'video_playback'];
const CODEC_CODES = [
  'input_invalid',
  'input_budget',
  'codec_unavailable',
  'unsupported_format',
  'unsupported_pages',
  'pixel_budget',
  'invalid_media',
  'decode_failed',
  'output_budget',
  'aborted',
  'timeout',
] as const;
export type GalleryCodecSupervisorCode =
  | (typeof CODEC_CODES)[number]
  | 'configuration_invalid'
  | 'protocol_invalid'
  | 'integrity_mismatch'
  | 'cleanup_uncertain'
  | 'io_failed';
export interface GalleryCodecSupervision {
  childReady: boolean;
  codecStarted: boolean;
  cancellationReceived: boolean;
  settlementAcknowledged: boolean;
  childClosed: boolean;
  childExitCode: number | null;
  childExitSignal: NodeJS.Signals | null;
  terminationRequested: 'SIGTERM' | 'SIGKILL' | null;
  workspaceCleaned: boolean;
  workspaceRetained: boolean;
  elapsedMs: number;
  stopReason: 'aborted' | 'timeout' | 'protocol_invalid' | null;
  memoryLimit: 'not_enforced';
  diskHardLimit: 'not_enforced';
  networkIsolation: 'not_enforced';
  descendantEnforcement: 'codec_acknowledgement_only';
}
export class GalleryCodecSupervisorError extends Error {
  constructor(
    readonly code: GalleryCodecSupervisorCode,
    readonly supervision: Readonly<GalleryCodecSupervision>,
  ) {
    super(code);
    this.name = 'GalleryCodecSupervisorError';
  }
}
function invalid(): never {
  throw new Error('protocol_invalid');
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function fields(value: unknown, required: readonly string[], optional: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string' || ![...required, ...optional].includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  const names = keys.filter((key): key is string => typeof key === 'string');
  const result = record(value, names);
  for (const key of optional)
    if (!Object.hasOwn(result, key))
      Object.defineProperty(result, key, { value: undefined, enumerable: true });
  return result;
}
function absolute(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    Buffer.byteLength(value) > 1024 ||
    value.includes('\0') ||
    !isAbsolute(value)
  )
    invalid();
  return value;
}
function enumeration<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string') invalid();
  const selected = choices.find((choice) => choice === value);
  if (selected === undefined) invalid();
  return selected;
}
function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum)
    invalid();
  return value;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = positive(value, maximum);
  if (!Number.isSafeInteger(number)) invalid();
  return number;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
function version(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+[.]\d+[.]\d+$/.test(value)) invalid();
  return value;
}
function nullableInteger(value: unknown, maximum: number): number | null {
  return value === null ? null : integer(value, maximum);
}
function identity(value: unknown) {
  const item = record(value, ['sha256', 'version', 'buildSha256']);
  if (item['version'] !== '9.0.2') invalid();
  return {
    sha256: digest(item['sha256']),
    version: '9.0.2',
    buildSha256: digest(item['buildSha256']),
  };
}
/** Private parent/child transport validator. It does not authenticate a job or source owner. */
export function parseGalleryCodecResultMetadata(
  value: unknown,
  bytes: Uint8Array<ArrayBuffer>,
): GallerySupervisedRendition {
  const root = record(value, [
    'recipeVersion',
    'kind',
    'original',
    'sourceObservation',
    'output',
    'build',
  ]);
  if (root['recipeVersion'] !== 1) invalid();
  const kind = enumeration(root['kind'], KINDS);
  const originalRaw = record(root['original'], ['sha256', 'byteSize']);
  const original = {
    sha256: digest(originalRaw['sha256']),
    byteSize: integer(
      originalRaw['byteSize'],
      kind === 'video_playback' ? 64 * 1024 * 1024 : 15 * 1024 * 1024,
    ),
  };
  if (kind !== 'video_playback') {
    const source = record(root['sourceObservation'], [
      'format',
      'width',
      'height',
      'orientation',
      'pages',
      'orientedWidth',
      'orientedHeight',
    ]);
    const sourceObservation = {
      format: enumeration(source['format'], ['jpeg', 'png', 'webp']),
      width: integer(source['width']),
      height: integer(source['height']),
      orientation: nullableInteger(source['orientation'], 8),
      pages: nullableInteger(source['pages'], 1),
      orientedWidth: integer(source['orientedWidth']),
      orientedHeight: integer(source['orientedHeight']),
    };
    if (sourceObservation.width * sourceObservation.height > 20_000_000) invalid();
    const swap = sourceObservation.orientation !== null && sourceObservation.orientation >= 5;
    if (
      sourceObservation.orientedWidth !==
        (swap ? sourceObservation.height : sourceObservation.width) ||
      sourceObservation.orientedHeight !==
        (swap ? sourceObservation.width : sourceObservation.height)
    )
      invalid();
    const output = record(root['output'], ['mediaType', 'sha256', 'byteSize', 'width', 'height']);
    if (output['mediaType'] !== 'image/webp') invalid();
    const width = integer(output['width'], kind === 'image_preview' ? 1600 : 320),
      height = integer(output['height'], kind === 'image_preview' ? 1600 : 320);
    if (width > sourceObservation.orientedWidth || height > sourceObservation.orientedHeight)
      invalid();
    const build = record(root['build'], ['sharp', 'vips']);
    return {
      recipeVersion: 1,
      kind,
      original,
      sourceObservation,
      output: {
        mediaType: 'image/webp',
        sha256: digest(output['sha256']),
        byteSize: integer(output['byteSize'], 2 * 1024 * 1024),
        width,
        height,
        bytes,
      },
      build: { sharp: version(build['sharp']), vips: version(build['vips']) },
    };
  }
  const source = record(root['sourceObservation'], [
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
  ]);
  const rotation = source['rotationDegrees'];
  if (
    rotation !== null &&
    (typeof rotation !== 'number' ||
      !Number.isSafeInteger(rotation) ||
      Math.abs(rotation) > 360 ||
      rotation % 90 !== 0)
  )
    invalid();
  const rotationDegrees = typeof rotation === 'number' ? rotation : null;
  const sourceObservation = {
    format: enumeration(source['format'], ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm']),
    videoCodec: enumeration(source['videoCodec'], ['h264', 'hevc', 'vp8', 'vp9', 'av1']),
    audioCodec:
      source['audioCodec'] === null
        ? null
        : enumeration(source['audioCodec'], ['aac', 'opus', 'vorbis']),
    width: integer(source['width']),
    height: integer(source['height']),
    sampleAspectNumerator: integer(source['sampleAspectNumerator']),
    sampleAspectDenominator: integer(source['sampleAspectDenominator']),
    rotationDegrees,
    rotatedWidth: integer(source['rotatedWidth']),
    rotatedHeight: integer(source['rotatedHeight']),
    displayAspect: positive(source['displayAspect']),
    fps: positive(source['fps'], 240),
    durationSeconds: positive(source['durationSeconds'], 3600),
    frameCount: integer(source['frameCount'], 864000),
    hasAudio: boolean(source['hasAudio']),
  };
  const swap = rotationDegrees !== null && Math.abs(rotationDegrees) % 180 === 90;
  const scale = sourceObservation.sampleAspectNumerator / sourceObservation.sampleAspectDenominator;
  const aspect = swap
    ? sourceObservation.height / (sourceObservation.width * scale)
    : (sourceObservation.width * scale) / sourceObservation.height;
  if (
    sourceObservation.width * sourceObservation.height > 8_294_400 ||
    scale < 0.01 ||
    scale > 100 ||
    sourceObservation.displayAspect !== aspect ||
    sourceObservation.rotatedWidth !==
      (swap ? sourceObservation.height : sourceObservation.width) ||
    sourceObservation.rotatedHeight !==
      (swap ? sourceObservation.width : sourceObservation.height) ||
    sourceObservation.hasAudio !== (sourceObservation.audioCodec !== null)
  )
    invalid();
  const output = record(root['output'], [
    'mediaType',
    'sha256',
    'byteSize',
    'width',
    'height',
    'durationSeconds',
    'frameCount',
    'hasAudio',
  ]);
  if (output['mediaType'] !== 'video/mp4') invalid();
  const width = integer(output['width'], 1280),
    height = integer(output['height'], 1280),
    hasAudio = boolean(output['hasAudio']),
    durationSeconds = positive(output['durationSeconds'], 3600);
  if (
    width > sourceObservation.rotatedWidth ||
    height > sourceObservation.rotatedHeight ||
    hasAudio !== sourceObservation.hasAudio ||
    durationSeconds > sourceObservation.durationSeconds + 1 / Math.min(sourceObservation.fps, 30)
  )
    invalid();
  const build = record(root['build'], ['ffmpeg', 'ffprobe']);
  return {
    recipeVersion: 1,
    kind,
    original,
    sourceObservation,
    output: {
      mediaType: 'video/mp4',
      sha256: digest(output['sha256']),
      byteSize: integer(output['byteSize'], 64 * 1024 * 1024),
      width,
      height,
      durationSeconds,
      frameCount: integer(output['frameCount'], 864000),
      hasAudio,
      bytes,
    },
    build: { ffmpeg: identity(build['ffmpeg']), ffprobe: identity(build['ffprobe']) },
  };
}
export function galleryCodecMetadata(result: GallerySupervisedRendition) {
  const { bytes: _bytes, ...output } = result.output;
  return { ...result, output };
}
export interface GalleryCodecChildRequest {
  kind: GalleryCodecKind;
  original: { sha256: string; byteSize: number };
  ffmpegPath: string;
  ffprobePath: string;
}
export function parseGalleryCodecChildRequest(value: unknown): GalleryCodecChildRequest {
  const item = record(value, ['kind', 'original', 'ffmpegPath', 'ffprobePath']);
  const kind = enumeration(item['kind'], KINDS),
    original = record(item['original'], ['sha256', 'byteSize']);
  if (
    typeof item['ffmpegPath'] !== 'string' ||
    !isAbsolute(item['ffmpegPath']) ||
    typeof item['ffprobePath'] !== 'string' ||
    !isAbsolute(item['ffprobePath'])
  )
    invalid();
  return {
    kind,
    original: {
      sha256: digest(original['sha256']),
      byteSize: integer(
        original['byteSize'],
        kind === 'video_playback' ? 64 * 1024 * 1024 : 15 * 1024 * 1024,
      ),
    },
    ffmpegPath: item['ffmpegPath'],
    ffprobePath: item['ffprobePath'],
  };
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
function snapshot(value: unknown, maximum: number): Buffer {
  if (
    !types.isUint8Array(value) ||
    types.isProxy(value) ||
    ![Buffer.prototype, Uint8Array.prototype].includes(Object.getPrototypeOf(value))
  )
    invalid();
  for (const key of ['buffer', 'byteLength', 'byteOffset', 'length'])
    if (Object.getOwnPropertyDescriptor(value, key)) invalid();
  const buffer: unknown = Object.getOwnPropertyDescriptor(typedArray, 'buffer')?.get?.call(value);
  const length: unknown = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')?.get?.call(
    value,
  );
  const offset: unknown = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')?.get?.call(
    value,
  );
  if (
    !types.isArrayBuffer(buffer) ||
    types.isSharedArrayBuffer(buffer) ||
    Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get?.call(buffer) ===
      true ||
    typeof length !== 'number' ||
    length < 1 ||
    length > maximum ||
    typeof offset !== 'number'
  )
    invalid();
  return Buffer.from(new Uint8Array(buffer, offset, length));
}
export interface GalleryCodecSupervisorConfiguration {
  nodePath: string;
  childModulePath: string;
  typescriptLoaderPath?: string;
  ffmpegPath: string;
  ffprobePath: string;
  scratchRoot?: string;
  wallMs?: number;
  shutdownGraceMs?: number;
}
export function createGalleryCodecSupervisor(config: GalleryCodecSupervisorConfiguration) {
  const resolved = (() => {
    try {
      const item = fields(
        config,
        ['nodePath', 'childModulePath', 'ffmpegPath', 'ffprobePath'],
        ['typescriptLoaderPath', 'scratchRoot', 'wallMs', 'shutdownGraceMs'],
      );
      return {
        nodePath: absolute(item['nodePath']),
        childModulePath: absolute(item['childModulePath']),
        ffmpegPath: absolute(item['ffmpegPath']),
        ffprobePath: absolute(item['ffprobePath']),
        typescriptLoaderPath:
          item['typescriptLoaderPath'] === undefined
            ? undefined
            : absolute(item['typescriptLoaderPath']),
        scratchRoot: item['scratchRoot'] === undefined ? tmpdir() : absolute(item['scratchRoot']),
        wallMs: item['wallMs'] === undefined ? 30000 : integer(item['wallMs'], 30000),
        shutdownGraceMs:
          item['shutdownGraceMs'] === undefined ? 2000 : integer(item['shutdownGraceMs'], 10000),
      };
    } catch {
      throw new Error('configuration_invalid');
    }
  })();
  const {
    nodePath,
    childModulePath,
    ffmpegPath,
    ffprobePath,
    typescriptLoaderPath,
    scratchRoot,
    wallMs,
    shutdownGraceMs,
  } = resolved;
  return {
    async render(rawBytes: unknown, options: { kind: GalleryCodecKind; signal?: AbortSignal }) {
      const startedAt = performance.now();
      const facts: GalleryCodecSupervision = {
        childReady: false,
        codecStarted: false,
        cancellationReceived: false,
        settlementAcknowledged: false,
        childClosed: false,
        childExitCode: null,
        childExitSignal: null,
        terminationRequested: null,
        workspaceCleaned: false,
        workspaceRetained: false,
        elapsedMs: 0,
        stopReason: null,
        memoryLimit: 'not_enforced',
        diskHardLimit: 'not_enforced',
        networkIsolation: 'not_enforced',
        descendantEnforcement: 'codec_acknowledgement_only',
      };
      let directory: string | undefined,
        childSpawned = false,
        quiescent = true;
      let failure: GalleryCodecSupervisorCode | null = null,
        result: GallerySupervisedRendition | undefined;
      let signal: AbortSignal | undefined;
      let cancelChild: (() => void) | undefined;
      const abort = () => {
        failure ??= 'aborted';
        facts.stopReason ??= 'aborted';
        cancelChild?.();
      };
      const timer = setTimeout(() => {
        failure ??= 'timeout';
        facts.stopReason ??= 'timeout';
        cancelChild?.();
      }, wallMs);
      try {
        const selectedOptions = fields(options, ['kind'], ['signal']);
        const kind = enumeration(selectedOptions['kind'], KINDS);
        const suppliedSignal = selectedOptions['signal'];
        if (
          suppliedSignal !== undefined &&
          (!(suppliedSignal instanceof AbortSignal) || types.isProxy(suppliedSignal))
        )
          invalid();
        signal = suppliedSignal;
        if (signal?.aborted) {
          failure = 'aborted';
          throw new Error('cancelled');
        }
        signal?.addEventListener('abort', abort, { once: true });
        const input = snapshot(
          rawBytes,
          kind === 'video_playback' ? 64 * 1024 * 1024 : 15 * 1024 * 1024,
        );
        const original = {
          sha256: createHash('sha256').update(input).digest('hex'),
          byteSize: input.length,
        };
        const canonicalRoot = await realpath(scratchRoot);
        if (!(await lstat(canonicalRoot)).isDirectory()) invalid();
        directory = await mkdtemp(join(canonicalRoot, 'wm-gallery-codec-'));
        await chmod(directory, 0o700);
        await using inputFile = await open(join(directory, 'input'), 'wx', 0o600);
        await inputFile.writeFile(input);
        await using outputFile = await open(join(directory, 'output'), 'wx+', 0o600);
        await using requestFile = await open(join(directory, 'request'), 'wx', 0o600);
        const requestBytes = Buffer.from(
          JSON.stringify({ kind, original, ffmpegPath, ffprobePath }),
        );
        if (requestBytes.length > 4096) invalid();
        await requestFile.writeFile(requestBytes);
        // Reopen read-only descriptors, so child code cannot rewrite the original or request.
        await using inputRead = await open(
          join(directory, 'input'),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        await using requestRead = await open(
          join(directory, 'request'),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        if (failure) throw new Error('cancelled');
        const settled = await new Promise<unknown>((resolve, reject) => {
          let child;
          try {
            child = spawn(
              nodePath,
              [
                ...(typescriptLoaderPath ? ['--import', typescriptLoaderPath] : []),
                childModulePath,
                '--gallery-codec-child',
              ],
              {
                shell: false,
                detached: true,
                env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: directory },
                stdio: ['ignore', 'pipe', 'pipe', inputRead.fd, outputFile.fd, requestRead.fd],
              },
            );
          } catch {
            failure = 'codec_unavailable';
            reject(new Error('spawn'));
            return;
          }
          child.on('spawn', () => {
            childSpawned = true;
            quiescent = false;
          });
          let pending = '',
            stdoutBytes = 0,
            stderrBytes = 0,
            settlement: unknown,
            closed = false;
          let exited = false;
          let grace: ReturnType<typeof setTimeout> | undefined;
          const stop = () => {
            if (closed || exited || grace) return;
            if (child.pid)
              try {
                process.kill(-child.pid, 'SIGTERM');
                facts.terminationRequested = 'SIGTERM';
              } catch {
                /* close decides */
              }
            grace = setTimeout(() => {
              if (!closed && !exited && child.pid)
                try {
                  process.kill(-child.pid, 'SIGKILL');
                  facts.terminationRequested = 'SIGKILL';
                } catch {
                  /* retain on uncertainty */
                }
            }, shutdownGraceMs);
          };
          cancelChild = stop;
          child.stdout?.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > 16384) {
              failure ??= 'protocol_invalid';
              facts.stopReason ??= 'protocol_invalid';
              stop();
              return;
            }
            pending += chunk.toString('utf8');
            let newline;
            while ((newline = pending.indexOf('\n')) !== -1) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              try {
                const event: unknown = JSON.parse(line);
                if (!event || typeof event !== 'object') invalid();
                if (facts.settlementAcknowledged) invalid();
                const state = Reflect.get(event, 'state');
                if (state === 'ready') {
                  record(event, ['protocolVersion', 'state']);
                  if (Reflect.get(event, 'protocolVersion') !== 1 || facts.childReady) invalid();
                  facts.childReady = true;
                } else if (state === 'started') {
                  record(event, ['protocolVersion', 'state']);
                  if (
                    Reflect.get(event, 'protocolVersion') !== 1 ||
                    !facts.childReady ||
                    facts.codecStarted ||
                    facts.cancellationReceived
                  )
                    invalid();
                  facts.codecStarted = true;
                } else if (state === 'cancellation_received') {
                  record(event, ['protocolVersion', 'state']);
                  if (
                    Reflect.get(event, 'protocolVersion') !== 1 ||
                    !facts.childReady ||
                    facts.cancellationReceived
                  )
                    invalid();
                  facts.cancellationReceived = true;
                } else if (state === 'settled') {
                  const item = record(event, [
                    'protocolVersion',
                    'state',
                    'outcome',
                    'reason',
                    'result',
                  ]);
                  if (
                    item['protocolVersion'] !== 1 ||
                    !facts.childReady ||
                    facts.settlementAcknowledged
                  )
                    invalid();
                  enumeration(item['outcome'], ['success', 'failed']);
                  if (
                    item['outcome'] === 'success' &&
                    (!facts.codecStarted || facts.cancellationReceived)
                  )
                    invalid();
                  if (
                    item['outcome'] === 'success'
                      ? item['reason'] !== null || item['result'] === null
                      : item['result'] !== null ||
                        !CODEC_CODES.some((code) => code === item['reason'])
                  )
                    invalid();
                  facts.settlementAcknowledged = true;
                  settlement = item;
                } else invalid();
              } catch {
                failure ??= 'protocol_invalid';
                facts.stopReason ??= 'protocol_invalid';
                stop();
              }
            }
          });
          child.stderr?.on('data', (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes > 65536) {
              failure ??= 'protocol_invalid';
              facts.stopReason ??= 'protocol_invalid';
              stop();
            }
          });
          child.on('error', () => {
            failure ??= 'codec_unavailable';
          });
          child.on('exit', () => {
            exited = true;
          });
          child.on('close', (code, signal) => {
            closed = true;
            facts.childClosed = true;
            facts.childExitCode = code;
            facts.childExitSignal = signal;
            cancelChild = undefined;
            if (grace) clearTimeout(grace);
            quiescent = !childSpawned || facts.settlementAcknowledged;
            if (!quiescent) {
              failure = 'cleanup_uncertain';
              reject(new Error('unacknowledged'));
            } else if (failure || code !== 0 || signal !== null || pending !== '') {
              failure ??= 'protocol_invalid';
              reject(new Error('failed'));
            } else resolve(settlement);
          });
          if (failure) stop();
        });
        const envelope = record(settled, [
          'protocolVersion',
          'state',
          'outcome',
          'reason',
          'result',
        ]);
        if (envelope['outcome'] === 'failed') {
          failure = enumeration(envelope['reason'], CODEC_CODES);
          throw new Error('codec failed');
        }
        const maximum = kind === 'video_playback' ? 64 * 1024 * 1024 : 2 * 1024 * 1024;
        const stat = await outputFile.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > maximum) {
          failure = 'output_budget';
          throw new Error('budget');
        }
        let length = 0;
        const digest = createHash('sha256'),
          chunks: Buffer[] = [];
        for await (const chunk of outputFile.createReadStream({ autoClose: false, start: 0 })) {
          length += chunk.length;
          if (length > maximum) {
            failure = 'output_budget';
            throw new Error('budget');
          }
          chunks.push(chunk);
          digest.update(chunk);
        }
        result = parseGalleryCodecResultMetadata(
          envelope['result'],
          Uint8Array.from(Buffer.concat(chunks, length)),
        );
        if (
          result.kind !== kind ||
          result.original.sha256 !== original.sha256 ||
          result.original.byteSize !== original.byteSize ||
          result.output.sha256 !== digest.digest('hex') ||
          result.output.byteSize !== length
        ) {
          failure = 'integrity_mismatch';
          throw new Error('integrity');
        }
      } catch {
        failure ??= 'protocol_invalid';
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (directory) {
          if (!childSpawned || quiescent)
            try {
              await rm(directory, { recursive: true, force: false });
              facts.workspaceCleaned = true;
            } catch {
              failure = 'io_failed';
              facts.workspaceRetained = true;
            }
          else facts.workspaceRetained = true;
        }
        facts.elapsedMs = performance.now() - startedAt;
      }
      if (signal?.aborted) failure ??= 'aborted';
      if (failure || !result)
        throw new GalleryCodecSupervisorError(
          failure ?? 'protocol_invalid',
          Object.freeze({ ...facts }),
        );
      return { result, supervision: Object.freeze({ ...facts }) };
    },
  };
}

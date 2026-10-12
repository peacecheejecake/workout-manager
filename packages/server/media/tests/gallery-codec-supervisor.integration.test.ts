import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGalleryCodecSupervisor,
  GalleryCodecSupervisorError,
} from '../src/gallery-codec-supervisor.js';
const execute = promisify(execFile);
const roots: string[] = [];
const childModulePath = fileURLToPath(new URL('../src/gallery-codec-child.ts', import.meta.url));
const typescriptLoaderPath = fileURLToPath(import.meta.resolve('tsx'));
async function binary(name: 'ffmpeg' | 'ffprobe') {
  const explicit = process.env[name === 'ffmpeg' ? 'WM_TEST_FFMPEG_PATH' : 'WM_TEST_FFPROBE_PATH'];
  if (explicit !== undefined && !isAbsolute(explicit))
    throw new Error('test_binary_configuration_invalid');
  for (const path of explicit
    ? [explicit]
    : (process.env['PATH'] ?? '')
        .split(delimiter)
        .filter(isAbsolute)
        .map((path) => join(path, name))) {
    let actual: string;
    try {
      actual = await realpath(path);
      await access(actual, constants.X_OK);
    } catch {
      continue;
    }
    const version = await execute(actual, ['-version'], { maxBuffer: 65536, timeout: 5000 });
    if (!new RegExp(`^${name} version 9\\.0\\.2(?: |\\n)`).test(version.stdout))
      throw new Error('test_binary_version_required_9_0_2');
    return actual;
  }
  throw new Error('test_binary_unavailable');
}
const ffmpegPath = await binary('ffmpeg'),
  ffprobePath = await binary('ffprobe');
const base = {
  nodePath: process.execPath,
  childModulePath,
  typescriptLoaderPath,
  ffmpegPath,
  ffprobePath,
};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'wm-supervisor-test-'));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function image() {
  return sharp({ create: { width: 640, height: 480, channels: 3, background: '#204060' } })
    .withMetadata({ orientation: 6 })
    .png()
    .toBuffer();
}
async function clip(options: { size?: string; fps?: string; duration?: string } = {}) {
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
      `testsrc2=size=${options.size ?? '96x64'}:rate=${options.fps ?? '12'}:duration=${options.duration ?? '0.5'}`,
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 10000 },
  );
  return stdout;
}
async function failure(pending: Promise<unknown>) {
  try {
    await pending;
    throw new Error('expected finite failure');
  } catch (error) {
    if (!(error instanceof GalleryCodecSupervisorError)) throw error;
    return error;
  }
}
describe('actual isolated gallery codec child', () => {
  it('renders native oriented image, preserves original and cleans after acknowledged close', async () => {
    const scratchRoot = await root(),
      input = await image(),
      before = Buffer.from(input);
    const result = await createGalleryCodecSupervisor({ ...base, scratchRoot }).render(input, {
      kind: 'image_thumbnail',
    });
    expect(input).toEqual(before);
    expect(result.result.original).toEqual({ sha256: hash(before), byteSize: before.length });
    expect(result.result.sourceObservation).toMatchObject({
      width: 640,
      height: 480,
      orientation: 6,
      orientedWidth: 480,
      orientedHeight: 640,
    });
    expect([result.result.output.width, result.result.output.height]).toEqual([240, 320]);
    expect(result.result.output.sha256).toBe(hash(result.result.output.bytes));
    expect((await sharp(result.result.output.bytes).metadata()).exif).toBeUndefined();
    expect(result.supervision).toMatchObject({
      childReady: true,
      codecStarted: true,
      childClosed: true,
      settlementAcknowledged: true,
      workspaceCleaned: true,
      workspaceRetained: false,
      memoryLimit: 'not_enforced',
    });
    expect(await readdir(scratchRoot)).toEqual([]);
  });
  it('snapshots caller bytes before asynchronous child preparation', async () => {
    const scratchRoot = await root(),
      input = await image(),
      original = Buffer.from(input);
    const pending = createGalleryCodecSupervisor({ ...base, scratchRoot }).render(input, {
      kind: 'image_thumbnail',
    });
    input.fill(0);
    const result = await pending;
    expect(result.result.original.sha256).toBe(hash(original));
    expect(await readdir(scratchRoot)).toEqual([]);
  });
  it('rejects actual output-file hash mismatch before returning a derivative', async () => {
    const scratchRoot = await root(),
      module = join(scratchRoot, 'corrupt-result.mjs');
    const source = `import {readFileSync,writeFileSync} from 'node:fs';
      const request=JSON.parse(readFileSync(5,'utf8'));
      const result={recipeVersion:1,kind:'image_thumbnail',original:request.original,
        sourceObservation:{format:'png',width:640,height:480,orientation:6,pages:null,orientedWidth:480,orientedHeight:640},
        output:{mediaType:'image/webp',sha256:'a'.repeat(64),byteSize:20,width:240,height:320},build:{sharp:'0.35.4',vips:'8.18.6'}};
      writeFileSync(4,Buffer.alloc(20));
      for(const event of [{protocolVersion:1,state:'ready'},{protocolVersion:1,state:'started'},{protocolVersion:1,state:'settled',outcome:'success',reason:null,result}]) writeFileSync(1,JSON.stringify(event)+'\\n');`;
    await writeFile(module, source, { mode: 0o600 });
    const error = await failure(
      createGalleryCodecSupervisor({ ...base, scratchRoot, childModulePath: module }).render(
        await image(),
        { kind: 'image_thumbnail' },
      ),
    );
    expect(error.code).toBe('integrity_mismatch');
    expect(error.supervision).toMatchObject({
      settlementAcknowledged: true,
      childClosed: true,
      workspaceCleaned: true,
      workspaceRetained: false,
    });
    expect(await readdir(scratchRoot)).toEqual(['corrupt-result.mjs']);
  });
  it('runs actual fd-only native video in child and returns full typed source observation', async () => {
    const scratchRoot = await root(),
      input = await clip();
    const result = await createGalleryCodecSupervisor({ ...base, scratchRoot }).render(input, {
      kind: 'video_playback',
    });
    expect(result.result.kind).toBe('video_playback');
    expect(result.result.original).toEqual({ sha256: hash(input), byteSize: input.length });
    expect(result.result.sourceObservation).toMatchObject({
      width: 96,
      height: 64,
      fps: 12,
      frameCount: 6,
      hasAudio: false,
    });
    expect(result.result.output.sha256).toBe(hash(result.result.output.bytes));
    expect(result.supervision.childClosed).toBe(true);
    expect(result.supervision.settlementAcknowledged).toBe(true);
    expect(await readdir(scratchRoot)).toEqual([]);
  });
  it('refuses external-reference bytes through the real existing video protocol guard', async () => {
    const scratchRoot = await root();
    const error = await failure(
      createGalleryCodecSupervisor({ ...base, scratchRoot }).render(
        Buffer.from('#EXTM3U\nhttps://invalid.example/segment.ts\n'),
        { kind: 'video_playback' },
      ),
    );
    expect(error.code).toBe('decode_failed');
    expect(error.supervision.workspaceCleaned).toBe(true);
    expect(error.supervision.settlementAcknowledged).toBe(true);
    expect(await readdir(scratchRoot)).toEqual([]);
  });
  it('rejects proxy/shared bytes and pre-abort without spawning or creating a workspace', async () => {
    const scratchRoot = await root(),
      codec = createGalleryCodecSupervisor({ ...base, scratchRoot });
    for (const input of [
      new Proxy(Buffer.from('x'), {}),
      new Uint8Array(new SharedArrayBuffer(1)),
    ]) {
      const error = await failure(codec.render(input, { kind: 'image_preview' }));
      expect(error.supervision.codecStarted).toBe(false);
    }
    const aborted = await failure(
      codec.render(await image(), { kind: 'image_preview', signal: AbortSignal.abort() }),
    );
    expect(aborted.code).toBe('aborted');
    expect(await readdir(scratchRoot)).toEqual([]);
  });
  it('acknowledges real abort of existing native video codec and cleans only after child close', async () => {
    const scratchRoot = await root();
    const input = await clip({ size: '384x256', fps: '60', duration: '20' });
    const controller = new AbortController();
    const pending = createGalleryCodecSupervisor({ ...base, scratchRoot }).render(input, {
      kind: 'video_playback',
      signal: controller.signal,
    });
    const abortTimer = setTimeout(() => controller.abort(), 350);
    try {
      const error = await failure(pending);
      expect(error.code).toBe('aborted');
      expect(error.supervision).toMatchObject({
        childReady: true,
        codecStarted: true,
        cancellationReceived: true,
        settlementAcknowledged: true,
        childClosed: true,
        childExitCode: 0,
        childExitSignal: null,
        terminationRequested: 'SIGTERM',
        workspaceCleaned: true,
        workspaceRetained: false,
      });
      expect(await readdir(scratchRoot)).toEqual([]);
    } finally {
      clearTimeout(abortTimer);
    }
  });
  it('rejects inherited/getter options without invocation or workspace creation', async () => {
    const scratchRoot = await root(),
      codec = createGalleryCodecSupervisor({ ...base, scratchRoot });
    let invoked = false;
    const options = { kind: 'image_preview' as const };
    Object.defineProperty(options, 'kind', {
      enumerable: true,
      get() {
        invoked = true;
        return 'image_preview';
      },
    });
    expect((await failure(codec.render(await image(), options))).code).toBe('protocol_invalid');
    expect(
      (await failure(codec.render(await image(), Object.create({ kind: 'image_preview' })))).code,
    ).toBe('protocol_invalid');
    expect(invoked).toBe(false);
    expect(await readdir(scratchRoot)).toEqual([]);
  });
  it('requires started before success and denies any trailing event', async () => {
    for (const events of [
      [
        { protocolVersion: 1, state: 'ready' },
        { protocolVersion: 1, state: 'settled', outcome: 'success', reason: null, result: {} },
      ],
      [
        { protocolVersion: 1, state: 'ready' },
        {
          protocolVersion: 1,
          state: 'settled',
          outcome: 'failed',
          reason: 'input_invalid',
          result: null,
        },
        { protocolVersion: 1, state: 'ready' },
      ],
    ]) {
      const scratchRoot = await root(),
        module = join(scratchRoot, 'wrong-order.mjs');
      await writeFile(
        module,
        `process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join('\n') + '\n')});`,
        { mode: 0o600 },
      );
      const error = await failure(
        createGalleryCodecSupervisor({ ...base, scratchRoot, childModulePath: module }).render(
          await image(),
          { kind: 'image_preview' },
        ),
      );
      expect(['protocol_invalid', 'cleanup_uncertain']).toContain(error.code);
      expect(error.supervision.stopReason).toBe('protocol_invalid');
      expect(error.supervision.childClosed).toBe(true);
    }
  });
  it('enforces a real reduced deadline and actual SIGKILL-close for an unresponsive owned child', async () => {
    const scratchRoot = await root(),
      module = join(scratchRoot, 'unresponsive.mjs');
    await writeFile(
      module,
      "process.on('SIGTERM',()=>{}); process.stdout.write(JSON.stringify({protocolVersion:1,state:'ready'})+'\\n'); setInterval(()=>{},1000);",
      { mode: 0o600 },
    );
    const error = await failure(
      createGalleryCodecSupervisor({
        ...base,
        scratchRoot,
        childModulePath: module,
        wallMs: 500,
        shutdownGraceMs: 100,
      }).render(await image(), { kind: 'image_preview' }),
    );
    expect(error.code).toBe('cleanup_uncertain');
    expect(error.supervision).toMatchObject({
      stopReason: 'timeout',
      childReady: true,
      childClosed: true,
      terminationRequested: 'SIGKILL',
      childExitSignal: 'SIGKILL',
      settlementAcknowledged: false,
      workspaceRetained: true,
      workspaceCleaned: false,
    });
  });
  it('retains own workspace on actual unacknowledged child crash, never reports native quiescence', async () => {
    const scratchRoot = await root(),
      module = join(scratchRoot, 'crash.mjs');
    await writeFile(module, 'process.exit(70);', { mode: 0o600 });
    const error = await failure(
      createGalleryCodecSupervisor({ ...base, scratchRoot, childModulePath: module }).render(
        await image(),
        { kind: 'image_preview' },
      ),
    );
    expect(error.code).toBe('cleanup_uncertain');
    expect(error.supervision).toMatchObject({
      childClosed: true,
      settlementAcknowledged: false,
      workspaceCleaned: false,
      workspaceRetained: true,
    });
    const retained = (await readdir(scratchRoot)).filter((name) =>
      name.startsWith('wm-gallery-codec-'),
    );
    expect(retained).toHaveLength(1);
    expect((await readdir(join(scratchRoot, retained[0] ?? 'invalid'))).sort()).toEqual([
      'input',
      'output',
      'request',
    ]);
    expect(error.message).toBe('cleanup_uncertain');
  });
  it('caps metadata transport and retains uncertainty after actual malformed protocol', async () => {
    const scratchRoot = await root(),
      module = join(scratchRoot, 'overflow.mjs');
    await writeFile(module, "process.stdout.write('x'.repeat(20000)); setInterval(()=>{},1000);", {
      mode: 0o600,
    });
    const error = await failure(
      createGalleryCodecSupervisor({
        ...base,
        scratchRoot,
        childModulePath: module,
        shutdownGraceMs: 100,
      }).render(await image(), { kind: 'image_preview' }),
    );
    expect(error.code).toBe('cleanup_uncertain');
    expect(error.supervision.stopReason).toBe('protocol_invalid');
    expect(error.supervision.childClosed).toBe(true);
  });
});

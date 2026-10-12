import { describe, expect, it } from 'vitest';
import {
  createGalleryCodecSupervisor,
  parseGalleryCodecChildRequest,
  parseGalleryCodecResultMetadata,
} from '../src/gallery-codec-supervisor.js';
const sha256 = 'a'.repeat(64);
const valid = {
  recipeVersion: 1,
  kind: 'image_preview',
  original: { sha256, byteSize: 100 },
  sourceObservation: {
    format: 'png',
    width: 8,
    height: 6,
    orientedWidth: 6,
    orientedHeight: 8,
    orientation: 6,
    pages: null,
  },
  output: { mediaType: 'image/webp', sha256, byteSize: 100, width: 6, height: 8 },
  build: { sharp: '0.35.4', vips: '8.18.6' },
};
describe('private isolated codec protocol', () => {
  it('preserves actual source/output distinction and null observations', () => {
    const result = parseGalleryCodecResultMetadata(valid, new Uint8Array(100));
    expect(result.sourceObservation).toEqual(valid.sourceObservation);
    expect(result.output.bytes.byteLength).toBe(100);
  });
  it.each([
    { ...valid, recipeVersion: 2 },
    { ...valid, kind: 'concat' },
    { ...valid, extra: 'url' },
    { ...valid, original: { sha256, byteSize: 0 } },
    { ...valid, sourceObservation: { ...valid.sourceObservation, orientedWidth: 8 } },
    { ...valid, sourceObservation: { ...valid.sourceObservation, pages: 2 } },
    { ...valid, sourceObservation: { ...valid.sourceObservation, rawExif: 'private' } },
    { ...valid, output: { ...valid.output, width: 1601 } },
    { ...valid, output: { ...valid.output, mediaType: 'image/jpeg' } },
    { ...valid, output: { ...valid.output, byteSize: 2 * 1024 * 1024 + 1 } },
  ])('closes malformed or expanded metadata %#', (value) => {
    expect(() => parseGalleryCodecResultMetadata(value, new Uint8Array(1))).toThrow(
      'protocol_invalid',
    );
  });
  it('does not invoke metadata accessors or permit proxies', () => {
    const getter = { ...valid };
    let invoked = false;
    Object.defineProperty(getter, 'kind', {
      enumerable: true,
      get() {
        invoked = true;
        return 'image_preview';
      },
    });
    expect(() => parseGalleryCodecResultMetadata(getter, new Uint8Array(1))).toThrow();
    expect(() =>
      parseGalleryCodecResultMetadata(new Proxy(valid, {}), new Uint8Array(1)),
    ).toThrow();
    expect(invoked).toBe(false);
  });
  it('rejects caller URL, argv and protocol fields in the child request', () => {
    const request = {
      kind: 'image_preview',
      original: { sha256, byteSize: 100 },
      ffmpegPath: '/trusted/ffmpeg',
      ffprobePath: '/trusted/ffprobe',
    };
    expect(parseGalleryCodecChildRequest(request)).toEqual(request);
    for (const value of [
      { ...request, argv: ['-i', 'https://invalid'] },
      { ...request, protocol: 'http' },
      { ...request, inputPath: '/other' },
      { ...request, ffmpegPath: 'https://invalid' },
    ])
      expect(() => parseGalleryCodecChildRequest(value)).toThrow('protocol_invalid');
  });
  it('accepts only a bounded trusted local configuration', () => {
    const config = {
      nodePath: process.execPath,
      childModulePath: '/trusted/child.mjs',
      ffmpegPath: '/trusted/ffmpeg',
      ffprobePath: '/trusted/ffprobe',
    };
    expect(() => createGalleryCodecSupervisor(config)).not.toThrow();
    expect(() => createGalleryCodecSupervisor({ ...config, wallMs: 30001 })).toThrow(
      'configuration_invalid',
    );
    expect(() => createGalleryCodecSupervisor({ ...config, shutdownGraceMs: 0 })).toThrow(
      'configuration_invalid',
    );
    expect(() =>
      createGalleryCodecSupervisor({ ...config, childModulePath: 'https://invalid' }),
    ).toThrow('configuration_invalid');
  });
  it('rejects inherited required config and getter/proxy without evaluating it', () => {
    const config = {
      nodePath: process.execPath,
      childModulePath: '/trusted/child.mjs',
      ffmpegPath: '/trusted/ffmpeg',
      ffprobePath: '/trusted/ffprobe',
    };
    let invoked = false;
    const accessor = { ...config };
    Object.defineProperty(accessor, 'nodePath', {
      enumerable: true,
      get() {
        invoked = true;
        return process.execPath;
      },
    });
    expect(() => createGalleryCodecSupervisor(accessor)).toThrow('configuration_invalid');
    expect(() => createGalleryCodecSupervisor(Object.create(config))).toThrow(
      'configuration_invalid',
    );
    expect(() => createGalleryCodecSupervisor(new Proxy(config, {}))).toThrow(
      'configuration_invalid',
    );
    expect(invoked).toBe(false);
  });
});

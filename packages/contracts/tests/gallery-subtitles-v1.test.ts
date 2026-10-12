import { describe, expect, it } from 'vitest';
import { gallerySubtitleTrackSchema, galleryViewerSubtitlesSchema } from '../src/gallery-viewer.js';
import {
  GALLERY_SUBTITLE_SOURCE_MAX_BYTES,
  GALLERY_SUBTITLE_REQUEST_MAX_BYTES,
  GALLERY_SUBTITLE_ACTIVE_RESPONSE_MAX_BYTES,
  gallerySubtitleBase64V1Schema,
  gallerySubtitleAttachBodyV1Schema,
  gallerySubtitleDetachBodyV1Schema,
  gallerySubtitleIdempotencyHeaderV1Schema,
  gallerySubtitleReadRequestV1Schema,
  gallerySubtitleReadResultV1Schema,
  gallerySubtitleAttachResultV1Schema,
  gallerySubtitleSourceFactsV1Schema,
  gallerySubtitleDetachResultV1Schema,
} from '../src/gallery-subtitles-v1.js';
const id = '12345678-1234-4234-8234-123456789abc';
const body = () => ({
  expectedAccessRevision: 2,
  language: 'ko-KR',
  label: '한국어 자막',
  file: { originalFileName: '사용자.vtt', base64: 'V0VCVlRUCgo=' },
});
const facts = () => ({
  byteSize: 8,
  sha256: 'a'.repeat(64),
  parserVersion: 'user-webvtt-plain-v1',
  origin: 'user_supplied',
});
const receipt = () => ({
  schemaVersion: 1,
  mediaItemId: id,
  accessRevision: 3,
  trackId: id,
  trackRevision: 1,
});
function encodedZeroBytes(size: number): string {
  const groups = Math.floor(size / 3);
  return 'AAAA'.repeat(groups) + (size % 3 === 1 ? 'AA==' : size % 3 === 2 ? 'AAA=' : '');
}
describe('gallery subtitles v1', () => {
  it('accepts exact attach body and reuses label/language semantics without changing bytes', () => {
    expect(gallerySubtitleAttachBodyV1Schema.parse(body())).toEqual(body());
    for (const language of ['ko', 'en-US', 'zh-Hant-TW', 'bad_language']) {
      expect(gallerySubtitleAttachBodyV1Schema.safeParse({ ...body(), language }).success).toBe(
        gallerySubtitleTrackSchema.shape.language.safeParse(language).success,
      );
    }
    const input = body();
    input.file.originalFileName = '  user.vtt  ';
    expect(gallerySubtitleAttachBodyV1Schema.parse(input).file.originalFileName).toBe('user.vtt');
    expect(
      gallerySubtitleAttachBodyV1Schema.parse({
        ...body(),
        file: { ...body().file, originalFileName: null },
      }).file.originalFileName,
    ).toBeNull();
  });
  it('keeps header-only stable idempotency and forbids caller facts', () => {
    expect(
      gallerySubtitleIdempotencyHeaderV1Schema.parse({ 'idempotency-key': 'subtitles:once:1' }),
    ).toEqual({ 'idempotency-key': 'subtitles:once:1' });
    for (const key of [
      'tenantId',
      'athleteId',
      'sha256',
      'parserVersion',
      'cues',
      'idempotencyKey',
      'trackId',
      'url',
    ])
      expect(
        gallerySubtitleAttachBodyV1Schema.safeParse({ ...body(), [key]: 'caller' }).success,
      ).toBe(false);
    for (const value of ['', 'short', 'spaces forbidden', 'é'.repeat(8), 'a'.repeat(129)])
      expect(
        gallerySubtitleIdempotencyHeaderV1Schema.safeParse({ 'idempotency-key': value }).success,
      ).toBe(false);
    expect(
      gallerySubtitleIdempotencyHeaderV1Schema.safeParse({
        'idempotency-key': ['once-once', 'again-again'],
      }).success,
    ).toBe(false);
  });
  it('checks canonical padded base64 including unused bits', () => {
    for (const value of ['AA==', 'AAA=', 'AAAA', '/w==', '//8=', 'V0VCVlRUCgo='])
      expect(gallerySubtitleBase64V1Schema.safeParse(value).success).toBe(true);
    for (const value of [
      '',
      'A',
      'AA',
      'AAA',
      'AAAA=',
      'AA===',
      '=AAA',
      'A=A=',
      'AB==',
      'AAB=',
      '//9=',
      ' AA==',
      'AA==\n',
      'AA-_',
      'data:text/vtt;base64,AA==',
      'https://example.test/a.vtt',
    ])
      expect(gallerySubtitleBase64V1Schema.safeParse(value).success).toBe(false);
  });
  it('enforces exact decoded 512KiB separately from request and GET budgets', () => {
    const maximum = encodedZeroBytes(GALLERY_SUBTITLE_SOURCE_MAX_BYTES);
    expect(gallerySubtitleBase64V1Schema.safeParse(maximum).success).toBe(true);
    expect(
      gallerySubtitleAttachBodyV1Schema.safeParse({
        ...body(),
        file: { originalFileName: null, base64: maximum },
      }).success,
    ).toBe(true);
    expect(
      gallerySubtitleBase64V1Schema.safeParse(
        encodedZeroBytes(GALLERY_SUBTITLE_SOURCE_MAX_BYTES + 1),
      ).success,
    ).toBe(false);
    expect(GALLERY_SUBTITLE_REQUEST_MAX_BYTES).toBe(704 * 1024);
    expect(GALLERY_SUBTITLE_ACTIVE_RESPONSE_MAX_BYTES).toBe(512 * 1024);
    expect(
      gallerySubtitleAttachBodyV1Schema.safeParse({
        ...body(),
        extra: 'x'.repeat(GALLERY_SUBTITLE_REQUEST_MAX_BYTES),
      }).success,
    ).toBe(false);
  });
  it('rejects empty/malformed, nested unknowns, filenames and invalid text', () => {
    for (const value of [
      null,
      {},
      [],
      { ...body(), expectedAccessRevision: 0 },
      { ...body(), expectedAccessRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...body(), file: { ...body().file, sha256: 'a'.repeat(64) } },
      { ...body(), file: { ...body().file, originalFileName: '../secret.vtt' } },
      { ...body(), label: '\ud800' },
      { ...body(), label: '\u0000' },
      { ...body(), label: 'x'.repeat(101) },
    ])
      expect(gallerySubtitleAttachBodyV1Schema.safeParse(value).success).toBe(false);
  });
  it('rejects accessor/proxy exceptions safely without reading getters', () => {
    let reads = 0;
    const getter = { ...body() };
    Object.defineProperty(getter, 'label', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('private');
      },
    });
    const values = [
      getter,
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('private');
          },
        },
      ),
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('private');
          },
        },
      ),
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error('private');
          },
          ownKeys() {
            return ['label'];
          },
        },
      ),
    ];
    for (const value of values) {
      expect(() => gallerySubtitleAttachBodyV1Schema.safeParse(value)).not.toThrow();
      expect(gallerySubtitleAttachBodyV1Schema.safeParse(value).success).toBe(false);
    }
    expect(reads).toBe(0);
    // A reflective proxy cannot redirect schema property reads: validation uses a descriptor snapshot.
    const proxy = new Proxy(body(), {
      get() {
        throw new Error('must not read caller');
      },
    });
    expect(gallerySubtitleAttachBodyV1Schema.parse(proxy)).toEqual(body());
  });
  it('rejects sparse/subclass arrays, cycles, symbols, deep/wide and nonfinite input', () => {
    class ArraySubclass extends Array<unknown> {}
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: unknown = null;
    for (let i = 0; i < 14; i++) deep = { deep };
    for (const value of [
      new Array(2),
      new ArraySubclass(),
      cycle,
      { ...body(), [Symbol('hidden')]: 'x' },
      { ...body(), extra: deep },
      { ...body(), extra: Array.from({ length: 10_001 }, () => null) },
      { ...body(), expectedAccessRevision: Infinity },
    ])
      expect(gallerySubtitleAttachBodyV1Schema.safeParse(value).success).toBe(false);
  });
  it('isolates a parsed body from subsequent caller mutation', () => {
    const input = body();
    const parsed = gallerySubtitleAttachBodyV1Schema.parse(input);
    input.file.base64 = 'AAAA';
    input.label = 'changed';
    expect(parsed).toEqual(body());
  });
  it('requires exact detach CAS and canonical paired read identity', () => {
    expect(
      gallerySubtitleDetachBodyV1Schema.parse({
        expectedAccessRevision: 3,
        trackId: id.toUpperCase(),
        expectedTrackRevision: 2,
      }).trackId,
    ).toBe(id);
    expect(
      gallerySubtitleReadRequestV1Schema.parse({
        mediaItemId: id.toUpperCase(),
        accessRevision: 3,
      }),
    ).toEqual({ mediaItemId: id, accessRevision: 3 });
    for (const value of [
      { expectedAccessRevision: 3, trackId: id },
      { expectedAccessRevision: 3, trackId: id, expectedTrackRevision: 0 },
      {
        expectedAccessRevision: 3,
        trackId: id,
        expectedTrackRevision: 2,
        idempotencyKey: 'forbidden',
      },
    ])
      expect(gallerySubtitleDetachBodyV1Schema.safeParse(value).success).toBe(false);
    expect(
      gallerySubtitleReadRequestV1Schema.safeParse({
        mediaItemId: id,
        accessRevision: 3,
        tenantId: id,
      }).success,
    ).toBe(false);
  });
  it('keeps owned file-name provenance separate from durable receipts', () => {
    for (const originalFileName of [null, '개인 자막.vtt']) {
      const source = { ...facts(), originalFileName };
      expect(gallerySubtitleSourceFactsV1Schema.parse(source)).toEqual(source);
      expect(
        gallerySubtitleAttachResultV1Schema.safeParse({ ...receipt(), status: 'attached', source })
          .success,
      ).toBe(false);
    }
    expect(gallerySubtitleSourceFactsV1Schema.safeParse(facts()).success).toBe(false);
    for (const field of ['originalFileName', 'label', 'language', 'cues', 'base64']) {
      expect(
        gallerySubtitleAttachResultV1Schema.safeParse({
          ...receipt(),
          status: 'attached',
          source: { ...facts(), [field]: field === 'cues' ? [] : '개인 자료' },
        }).success,
      ).toBe(false);
    }
  });
  it('returns only server-known minimal attachment and detached facts', () => {
    const attached = { ...receipt(), status: 'attached', source: facts() };
    expect(gallerySubtitleAttachResultV1Schema.parse(attached)).toEqual(attached);
    for (const extra of [
      { track: { cues: [] } },
      { cues: [] },
      { language: 'ko' },
      { base64: 'AAAA' },
    ])
      expect(gallerySubtitleAttachResultV1Schema.safeParse({ ...attached, ...extra }).success).toBe(
        false,
      );
    for (const source of [
      { ...facts(), byteSize: null },
      { ...facts(), sha256: null },
      { ...facts(), parserVersion: null },
      { ...facts(), origin: 'ai_reviewed' },
      { ...facts(), byteSize: 0 },
      { ...facts(), byteSize: GALLERY_SUBTITLE_SOURCE_MAX_BYTES + 1 },
    ])
      expect(gallerySubtitleAttachResultV1Schema.safeParse({ ...attached, source }).success).toBe(
        false,
      );
    const detached = { ...receipt(), status: 'detached' };
    expect(gallerySubtitleDetachResultV1Schema.parse(detached)).toEqual(detached);
    expect(
      gallerySubtitleDetachResultV1Schema.safeParse({ ...detached, source: facts() }).success,
    ).toBe(false);
  });
  it('reuses the existing viewer read schema and preserves empty/missing/unavailable distinctions', () => {
    expect(gallerySubtitleReadResultV1Schema).toBe(galleryViewerSubtitlesSchema);
    for (const status of ['none', 'missing'])
      expect(
        gallerySubtitleReadResultV1Schema.safeParse({
          schemaVersion: 1,
          mediaItemId: id,
          accessRevision: 2,
          status,
        }).success,
      ).toBe(true);
    expect(
      gallerySubtitleReadResultV1Schema.safeParse({
        schemaVersion: 1,
        mediaItemId: id,
        accessRevision: 2,
        status: 'available',
        tracks: [],
      }).success,
    ).toBe(false);
    expect(
      gallerySubtitleReadResultV1Schema.safeParse({
        schemaVersion: 1,
        mediaItemId: id,
        accessRevision: 2,
        status: 'unavailable',
        reason: 'reader_unavailable',
      }).success,
    ).toBe(true);
  });
});

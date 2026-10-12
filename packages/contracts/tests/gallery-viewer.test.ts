import { describe, expect, it } from 'vitest';
import { galleryViewerSubtitlesSchema, gallerySubtitleCueSchema } from '../src/gallery-viewer';

const identity = {
  schemaVersion: 1,
  mediaItemId: '10000000-0000-4000-8000-000000000001',
  accessRevision: 2,
};
const track = {
  id: '10000000-0000-4000-8000-000000000002',
  revision: 1,
  language: 'ko-KR',
  label: '한국어',
  cues: [{ startMs: 0, endMs: 1000, text: '첫 줄\n\n<script>문자 그대로</script> 😀' }],
};
const available = { ...identity, status: 'available', tracks: [track] };
describe('gallery viewer subtitles', () => {
  it('preserves description-independent timed text, newlines and Unicode', () => {
    expect(galleryViewerSubtitlesSchema.parse(available)).toEqual(available);
  });
  it.each(['missing', 'none'])(
    'binds %s to the requested parent revision without asserting a current head',
    (status) => {
      expect(galleryViewerSubtitlesSchema.safeParse({ ...identity, status }).success).toBe(true);
      expect(
        galleryViewerSubtitlesSchema.safeParse({
          schemaVersion: 1,
          mediaItemId: identity.mediaItemId,
          status,
        }).success,
      ).toBe(false);
    },
  );
  it('keeps an unconnected reader unavailable instead of reporting no tracks', () => {
    expect(
      galleryViewerSubtitlesSchema.safeParse({
        ...identity,
        status: 'unavailable',
        reason: 'reader_unavailable',
      }).success,
    ).toBe(true);
    expect(
      galleryViewerSubtitlesSchema.safeParse({ ...identity, status: 'available', tracks: [] })
        .success,
    ).toBe(false);
  });
  it.each([
    { startMs: -1, endMs: 100 },
    { startMs: 0.5, endMs: 100 },
    { startMs: 100, endMs: 100 },
    { startMs: 100, endMs: 99 },
  ])('rejects invalid millisecond intervals %j', (interval) => {
    expect(gallerySubtitleCueSchema.safeParse({ ...interval, text: '자막' }).success).toBe(false);
  });
  it('rejects reordered cues, duplicate tracks and unknown response fields', () => {
    expect(
      galleryViewerSubtitlesSchema.safeParse({
        ...available,
        tracks: [
          {
            ...track,
            cues: [
              { startMs: 100, endMs: 200, text: '뒤' },
              { startMs: 0, endMs: 50, text: '앞' },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      galleryViewerSubtitlesSchema.safeParse({ ...available, tracks: [track, track] }).success,
    ).toBe(false);
    expect(galleryViewerSubtitlesSchema.safeParse({ ...available, url: 'private' }).success).toBe(
      false,
    );
  });
  it.each(['\ud800', '\udc00', 'a\u0000b'])(
    'rejects unsupported text without trimming valid lines',
    (text) => {
      expect(gallerySubtitleCueSchema.safeParse({ startMs: 0, endMs: 1, text }).success).toBe(
        false,
      );
    },
  );
  it('rejects accessor/cycle and throwing reflection boundaries without evaluating accessors', () => {
    let reads = 0;
    const accessor = Object.defineProperty({ ...identity, status: 'none' }, 'extra', {
      enumerable: true,
      get() {
        reads++;
        return 'secret';
      },
    });
    expect(galleryViewerSubtitlesSchema.safeParse(accessor).success).toBe(false);
    expect(reads).toBe(0);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(galleryViewerSubtitlesSchema.safeParse(cycle).success).toBe(false);
    for (const proxy of [
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('blocked');
          },
        },
      ),
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('blocked');
          },
        },
      ),
      new Proxy(
        { key: 1 },
        {
          getOwnPropertyDescriptor() {
            throw new Error('blocked');
          },
        },
      ),
    ]) {
      expect(() => galleryViewerSubtitlesSchema.safeParse(proxy)).not.toThrow();
      expect(galleryViewerSubtitlesSchema.safeParse(proxy).success).toBe(false);
    }
  });
  it('rejects huge unknown strings before serialization and enforces escaped UTF8 total bytes', () => {
    const huge = { ...identity, status: 'none', extra: 'x'.repeat(512 * 1024 + 1) };
    expect(galleryViewerSubtitlesSchema.safeParse(huge).success).toBe(false);
    const cues = Array.from({ length: 100 }, (_, index) => ({
      startMs: index,
      endMs: index + 1,
      text: '😀'.repeat(500),
    }));
    expect(
      galleryViewerSubtitlesSchema.safeParse({ ...available, tracks: [{ ...track, cues }] })
        .success,
    ).toBe(true);
    expect(
      galleryViewerSubtitlesSchema.safeParse({
        ...available,
        tracks: [{ ...track, cues: [...cues, ...cues, ...cues] }],
      }).success,
    ).toBe(false);
  });
});

it('rejects sparse and decorated arrays before serialization or recursive parsing', () => {
  expect(
    galleryViewerSubtitlesSchema.safeParse({ ...available, tracks: new Array(100000000) }).success,
  ).toBe(false);
  const decorated = Object.assign([track], { unexpected: 'not a track' });
  expect(galleryViewerSubtitlesSchema.safeParse({ ...available, tracks: decorated }).success).toBe(
    false,
  );
});

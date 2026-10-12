import { z } from 'zod';

const MAX_BYTES = 512 * 1024;
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function plainBounded(value: unknown): boolean {
  try {
    const seen = new Set<object>();
    const pending = [{ value, depth: 0 }];
    let visits = 0;
    let stringLowerBound = 0;
    function charge(text: string): boolean {
      if (text.length > MAX_BYTES || !wellFormed(text)) return false;
      stringLowerBound += text.length;
      return stringLowerBound <= MAX_BYTES;
    }
    while (pending.length) {
      const node = pending.pop();
      if (!node || ++visits > 20_000 || node.depth > 12) return false;
      const current = node.value;
      if (typeof current === 'string') {
        if (!charge(current)) return false;
        continue;
      }
      if (current === null || typeof current === 'boolean') continue;
      if (typeof current === 'number') {
        if (!Number.isFinite(current)) return false;
        continue;
      }
      if (typeof current !== 'object' || seen.has(current)) return false;
      seen.add(current);
      const prototype: unknown = Object.getPrototypeOf(current);
      const array = Array.isArray(current);
      if (
        array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
      )
        return false;
      const keys = Reflect.ownKeys(current);
      if (keys.length > 10_000) return false;
      if (array) {
        const length = Object.getOwnPropertyDescriptor(current, 'length');
        if (
          !length ||
          !('value' in length) ||
          !Number.isInteger(length.value) ||
          length.value < 0 ||
          length.value > 9999 ||
          keys.length !== length.value + 1
        )
          return false;
        for (const key of keys) {
          if (
            key !== 'length' &&
            (typeof key !== 'string' ||
              !/^(0|[1-9][0-9]*)$/.test(key) ||
              Number(key) >= length.value)
          )
            return false;
        }
      }
      for (const key of keys) {
        if (typeof key !== 'string') return false;
        if (array && key === 'length') continue;
        if (!charge(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
        pending.push({ value: descriptor.value, depth: node.depth + 1 });
      }
    }
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_BYTES;
  } catch {
    return false;
  }
}
const text = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => {
    if (value.length > 2000 || !wellFormed(value)) return false;
    for (const character of value) {
      const code = character.charCodeAt(0);
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return false;
    }
    return true;
  });
const cue = z
  .strictObject({
    startMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    endMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    text,
  })
  .refine((value) => value.endMs > value.startMs, { path: ['endMs'] });
export const gallerySubtitleCueSchema = cue;
export const gallerySubtitleTrackSchema = z
  .strictObject({
    id: z.uuid(),
    revision: z.number().int().positive(),
    language: z
      .string()
      .max(35)
      .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/),
    label: text.pipe(z.string().max(100)),
    cues: z.array(cue).max(1000),
  })
  .superRefine((track, context) => {
    for (let index = 1; index < track.cues.length; index += 1) {
      const current = track.cues[index];
      const previous = track.cues[index - 1];
      if (current && previous && current.startMs < previous.startMs)
        context.addIssue({
          code: 'custom',
          path: ['cues', index],
          message: 'Cues must preserve time order.',
        });
    }
  });
const identity = { schemaVersion: z.literal(1), mediaItemId: z.uuid() };
const revision = { ...identity, accessRevision: z.number().int().positive() };
const result = z
  .discriminatedUnion('status', [
    // The echoed revision binds the request; it is not a current-head proof.
    z.strictObject({ ...revision, status: z.literal('missing') }),
    z.strictObject({ ...revision, status: z.literal('none') }),
    z.strictObject({
      ...revision,
      status: z.literal('unavailable'),
      reason: z.enum(['reader_unavailable', 'load_failed', 'stale_response']),
    }),
    z.strictObject({
      ...revision,
      status: z.literal('available'),
      tracks: z.array(gallerySubtitleTrackSchema).min(1).max(8),
    }),
  ])
  .superRefine((value, context) => {
    if (
      value.status === 'available' &&
      new Set(value.tracks.map((track) => track.id)).size !== value.tracks.length
    )
      context.addIssue({ code: 'custom', message: 'Track identities must be unique.' });
  });
/** Server data only. This descriptor never grants access or supplies a media URL. */
export const galleryViewerSubtitlesSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (!plainBounded(value))
      context.addIssue({ code: 'custom', message: 'Invalid bounded plain subtitle response.' });
  })
  .pipe(result);
export type GallerySubtitleCue = z.infer<typeof gallerySubtitleCueSchema>;
export type GallerySubtitleTrack = z.infer<typeof gallerySubtitleTrackSchema>;
export type GalleryViewerSubtitles = z.infer<typeof galleryViewerSubtitlesSchema>;

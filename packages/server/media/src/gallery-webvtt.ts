import { createHash } from 'node:crypto';
import { isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import {
  gallerySubtitleCueSchema,
  type GallerySubtitleCue,
} from '@workout/contracts/gallery-viewer';

/** A strict plain-text subset, not a general browser WebVTT recovery parser.
 * Syntax reference: https://www.w3.org/TR/2026/CRD-webvtt1-20260520/#syntax
 * STYLE/REGION/NOTE, header annotations, cue settings and markup are explicitly
 * unsupported. Six named WebVTT character references become literal cue text.
 */
export const galleryWebVttParserVersion = 'user-webvtt-plain-v1' as const;
export const galleryWebVttLimits = Object.freeze({
  sourceBytes: 512 * 1024,
  normalizedBytes: 512 * 1024,
  cues: 1000,
  textCodeUnits: 2000,
  identifierCodeUnits: 2000,
  lines: 20_000,
});
export type GalleryWebVttErrorCode =
  | 'INVALID_INPUT'
  | 'SOURCE_TOO_LARGE'
  | 'INVALID_UTF8'
  | 'INVALID_CHARACTER'
  | 'INVALID_HEADER'
  | 'UNSUPPORTED_HEADER_METADATA'
  | 'UNSUPPORTED_BLOCK'
  | 'UNSUPPORTED_CUE_SETTINGS'
  | 'UNSUPPORTED_CUE_MARKUP'
  | 'UNSUPPORTED_CHARACTER_REFERENCE'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_CUE'
  | 'DUPLICATE_CUE_IDENTIFIER'
  | 'CUE_ORDER_INVALID'
  | 'LIMIT_EXCEEDED';
export class GalleryWebVttError extends Error {
  constructor(readonly code: GalleryWebVttErrorCode) {
    super(code);
    this.name = 'GalleryWebVttError';
  }
}
export interface ParsedGalleryWebVtt {
  readonly parserVersion: typeof galleryWebVttParserVersion;
  readonly source: { readonly byteSize: number; readonly sha256: string };
  readonly cues: readonly Readonly<GallerySubtitleCue>[];
  /** Original optional identifiers are preserved, never used as an access key. */
  readonly cueIdentifiers: readonly (string | null)[];
}
function fail(code: GalleryWebVttErrorCode): never {
  throw new GalleryWebVttError(code);
}
function sourceSnapshot(raw: unknown): Uint8Array {
  try {
    if (!isUint8Array(raw)) return fail('INVALID_INPUT');
    const prototype: unknown = Object.getPrototypeOf(Uint8Array.prototype);
    const sizeGetter = Object.getOwnPropertyDescriptor(prototype, 'byteLength')?.get;
    const bufferGetter = Object.getOwnPropertyDescriptor(prototype, 'buffer')?.get;
    if (!sizeGetter || !bufferGetter) return fail('INVALID_INPUT');
    const size: unknown = Reflect.apply(sizeGetter, raw, []);
    const buffer: unknown = Reflect.apply(bufferGetter, raw, []);
    if (
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      isSharedArrayBuffer(buffer)
    )
      return fail('INVALID_INPUT');
    if (size > galleryWebVttLimits.sourceBytes) return fail('SOURCE_TOO_LARGE');
    const copy = new Uint8Array(size);
    // Native typed-array set reads internal slots, not caller getters/iterators.
    Uint8Array.prototype.set.call(copy, raw);
    return copy;
  } catch (error) {
    if (error instanceof GalleryWebVttError) throw error;
    return fail('INVALID_INPUT');
  }
}
function timestamp(value: string): number {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value);
  if (!match || value.length > 32) return fail('INVALID_TIMESTAMP');
  const hours = Number(match[1] ?? 0);
  const result =
    hours * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1000 + Number(match[4]);
  if (!Number.isSafeInteger(result) || result < 0) return fail('INVALID_TIMESTAMP');
  return result;
}
const references: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  lrm: '\u200e',
  rlm: '\u200f',
  nbsp: '\u00a0',
});
function payload(value: string): string {
  if (value.includes('<')) return fail('UNSUPPORTED_CUE_MARKUP');
  if (value.includes('-->')) return fail('INVALID_CUE');
  const decoded = value.replace(/&([^\s&;]*);?/g, (_match: string, token: string) => {
    // Require the complete named token, never numeric/HTML expansion or double decode.
    if (!Object.hasOwn(references, token) || !_match.endsWith(';'))
      return fail('UNSUPPORTED_CHARACTER_REFERENCE');
    return references[token] ?? fail('UNSUPPORTED_CHARACTER_REFERENCE');
  });
  // Bare '&' is outside this supported caption-text grammar too.
  if (value.endsWith('&') || /&(?=[\s&])/.test(value))
    return fail('UNSUPPORTED_CHARACTER_REFERENCE');
  return decoded;
}
/** Returned structural correspondence never proves tenant ownership or admission. */
export function parseGalleryWebVtt(raw: unknown): ParsedGalleryWebVtt {
  const bytes = sourceSnapshot(raw);
  const source = Object.freeze({
    byteSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail('INVALID_UTF8');
  }
  if (text.startsWith('\ufeff')) text = text.slice(1);
  for (const character of text) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159))
    )
      return fail('INVALID_CHARACTER');
  }
  text = text.replace(/\r\n?/g, '\n');
  let lineCount = 1;
  for (const character of text)
    if (character === '\n' && ++lineCount > galleryWebVttLimits.lines)
      return fail('LIMIT_EXCEEDED');
  const lines = text.split('\n');
  const header = lines[0];
  if (header !== 'WEBVTT') {
    if (header?.startsWith('WEBVTT ') || header?.startsWith('WEBVTT\t'))
      return fail('UNSUPPORTED_HEADER_METADATA');
    return fail('INVALID_HEADER');
  }
  if (lines[1] !== '') return fail('INVALID_HEADER');
  const cues: Readonly<GallerySubtitleCue>[] = [];
  const cueIdentifiers: (string | null)[] = [];
  const identifiers = new Set<string>();
  let normalizedBytes = Buffer.byteLength(
    JSON.stringify({ parserVersion: galleryWebVttParserVersion, source, cues, cueIdentifiers }),
    'utf8',
  );
  let index = 2;
  while (index < lines.length) {
    if (lines[index] === '') {
      index++;
      continue;
    }
    if (cues.length >= galleryWebVttLimits.cues) return fail('LIMIT_EXCEEDED');
    const first = lines[index];
    if (first === undefined) return fail('INVALID_CUE');
    if (/^(?:STYLE|REGION|NOTE)(?:[ \t]|$)/.test(first)) return fail('UNSUPPORTED_BLOCK');
    let identifier: string | null = null;
    let timing = first;
    if (!first.includes('-->')) {
      identifier = first;
      if (!identifier || identifier.length > galleryWebVttLimits.identifierCodeUnits)
        return fail('LIMIT_EXCEEDED');
      if (identifiers.has(identifier)) return fail('DUPLICATE_CUE_IDENTIFIER');
      identifiers.add(identifier);
      index++;
      const next = lines[index];
      if (next === undefined) return fail('INVALID_CUE');
      timing = next;
    }
    const timingMatch = /^(\S+)[ \t]+-->[ \t]+(\S+)(.*)$/.exec(timing);
    if (!timingMatch) return fail('INVALID_TIMESTAMP');
    const start = timingMatch[1];
    const end = timingMatch[2];
    const tail = timingMatch[3];
    if (start === undefined || end === undefined || tail === undefined)
      return fail('INVALID_TIMESTAMP');
    if (tail.trim() !== '') return fail('UNSUPPORTED_CUE_SETTINGS');
    const startMs = timestamp(start);
    const endMs = timestamp(end);
    index++;
    const fragments: string[] = [];
    let textLength = 0;
    while (index < lines.length && lines[index] !== '') {
      const line = lines[index];
      if (line === undefined) return fail('INVALID_CUE');
      textLength += line.length + (fragments.length ? 1 : 0);
      if (textLength > galleryWebVttLimits.textCodeUnits) return fail('LIMIT_EXCEEDED');
      fragments.push(line);
      index++;
    }
    const parsed = gallerySubtitleCueSchema.safeParse({
      startMs,
      endMs,
      text: payload(fragments.join('\n')),
    });
    if (!parsed.success) return fail('INVALID_CUE');
    const previous = cues.at(-1);
    if (previous && startMs < previous.startMs) return fail('CUE_ORDER_INVALID');
    const cue = Object.freeze(parsed.data);
    normalizedBytes +=
      Buffer.byteLength(JSON.stringify(cue), 'utf8') +
      Buffer.byteLength(JSON.stringify(identifier), 'utf8') +
      (cues.length ? 2 : 0);
    if (normalizedBytes > galleryWebVttLimits.normalizedBytes) return fail('LIMIT_EXCEEDED');
    cues.push(cue);
    cueIdentifiers.push(identifier);
  }
  return Object.freeze({
    parserVersion: galleryWebVttParserVersion,
    source,
    cues: Object.freeze(cues),
    cueIdentifiers: Object.freeze(cueIdentifiers),
  });
}

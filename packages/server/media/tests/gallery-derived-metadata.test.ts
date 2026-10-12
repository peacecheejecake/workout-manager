import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { renderGalleryImageRendition } from '../src/gallery-image-rendition.js';
import { createGalleryVideoRenditionCodec } from '../src/gallery-video-rendition.js';

// User decision 2026-10-10: originals keep their EXIF/GPS privately and byte-identical; every
// derived preview, thumbnail and playback rendition carries no metadata. Synthetic fixtures
// with location data only (coordinates 1/2/3 degrees, no real place).
const execute = promisify(execFile);
const SENTINEL = 'synthetic-private-location-sentinel';

async function tool(name: 'ffmpeg' | 'ffprobe', setting: string) {
  const explicit = process.env[setting];
  if (explicit !== undefined && !isAbsolute(explicit)) throw new Error(`test_${name}_invalid`);
  const candidates =
    explicit !== undefined
      ? [explicit]
      : (process.env['PATH'] ?? '')
          .split(delimiter)
          .filter(isAbsolute)
          .map((path) => join(path, name));
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      await access(path, constants.X_OK);
      if (!(await stat(path)).isFile()) continue;
      const { stdout } = await execute(path, ['-version'], { maxBuffer: 64 * 1024 });
      if (!new RegExp(`^${name} version 9\\.0\\.2(?: |\\n)`).test(stdout))
        throw new Error(`test_${name}_version_required_9_0_2`);
      return path;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('test_')) throw error;
    }
  }
  throw new Error(`test_${name}_missing`);
}

/** RIFF chunk FourCCs of a WebP file (top level and inside VP8X container). */
function webpChunks(bytes: Buffer): string[] {
  expect(bytes.toString('latin1', 0, 4)).toBe('RIFF');
  expect(bytes.toString('latin1', 8, 12)).toBe('WEBP');
  const chunks: string[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    chunks.push(bytes.toString('latin1', offset, offset + 4));
    const size = bytes.readUInt32LE(offset + 4);
    offset += 8 + size + (size % 2);
  }
  return chunks;
}
/** ISO BMFF box paths (e.g. moov/udta/meta/ilst/\u00a9too), recursing into every container. */
function mp4Boxes(bytes: Buffer, start = 0, end = bytes.length, prefix = '', out: string[] = []) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      size = Number(bytes.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) break;
    const path = prefix + type;
    out.push(path);
    const containers = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'mvex'];
    if ([...containers, 'moof', 'traf', 'ilst', 'keys'].includes(type))
      mp4Boxes(bytes, offset + header, offset + size, `${path}/`, out);
    if (type === 'meta') mp4Boxes(bytes, offset + header + 4, offset + size, `${path}/`, out);
    offset += size;
  }
  return out;
}

const XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="1,2.05N" exif:GPSLongitude="3,4.05E"><dc:description xmlns:dc="http://purl.org/dc/elements/1.1/">${SENTINEL}</dc:description></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

async function locatedJpeg() {
  const pixels = Buffer.alloc(64 * 48 * 3, 90);
  return sharp(pixels, { raw: { width: 64, height: 48, channels: 3 } })
    .withExif({
      IFD0: { ImageDescription: SENTINEL, Make: 'synthetic' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '1/1 2/1 3/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '3/1 2/1 1/1',
      },
    })
    .withXmp(XMP)
    .withIccProfile('p3')
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

describe('derived gallery outputs carry no metadata', () => {
  it.each(['image_preview', 'image_thumbnail'] as const)(
    '%s WebP has no EXIF, XMP, ICC or GPS bytes while the original keeps them unchanged',
    async (kind) => {
      const input = await locatedJpeg();
      const source = await sharp(input).metadata();
      expect(source.exif).toBeDefined();
      expect(source.xmp).toBeDefined();
      expect(source.icc).toBeDefined();
      expect(input.includes(Buffer.from(SENTINEL, 'latin1'))).toBe(true);
      const before = Buffer.from(input);
      const result = await renderGalleryImageRendition(input, { kind });
      // The original object bytes are never rewritten.
      expect(input).toEqual(before);
      const bytes = Buffer.from(result.output.bytes);
      const metadata = await sharp(bytes).metadata();
      expect(metadata.format).toBe('webp');
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.iptc).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
      const chunks = webpChunks(bytes);
      for (const forbidden of ['EXIF', 'XMP ', 'ICCP']) expect(chunks).not.toContain(forbidden);
      for (const marker of [SENTINEL, 'Exif', 'GPS', 'xmpmeta', 'synthetic'])
        expect(bytes.includes(Buffer.from(marker, 'latin1'))).toBe(false);
    },
  );

  it('H.264 playback MP4 has no location, creation time, user data or QuickTime keys', async () => {
    const ffmpegPath = await tool('ffmpeg', 'WM_TEST_FFMPEG_PATH');
    const ffprobePath = await tool('ffprobe', 'WM_TEST_FFPROBE_PATH');
    const directory = await mkdtemp(join(tmpdir(), 'wm-derived-metadata-'));
    try {
      const sourcePath = join(directory, 'source.mov');
      await execute(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=96x64:rate=12:duration=0.5',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=0.5',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-metadata',
          'location=+01.0000+002.0000/',
          '-metadata',
          'location-eng=+01.0000+002.0000/',
          '-metadata',
          'com.apple.quicktime.location.ISO6709=+01.0000+002.0000+003.000/',
          '-metadata',
          `comment=${SENTINEL}`,
          '-metadata',
          'creation_time=2026-01-02T03:04:05Z',
          '-metadata:s:v:0',
          `handler_name=${SENTINEL}`,
          '-metadata:s:v:0',
          'location=+01.0000+002.0000/',
          '-metadata:s:a:0',
          'creation_time=2026-01-02T03:04:05Z',
          '-movflags',
          '+use_metadata_tags',
          '-f',
          'mov',
          sourcePath,
        ],
        { maxBuffer: 1024 * 1024 },
      );
      const input = await readFile(sourcePath);
      // Fixture sanity: the source really carries the container location and keys.
      const sourceBoxes = mp4Boxes(input);
      expect(sourceBoxes.some((box) => box.includes('/keys') || box.endsWith('\u00a9xyz'))).toBe(
        true,
      );
      expect(input.includes(Buffer.from('ISO6709', 'latin1'))).toBe(true);
      expect(input.includes(Buffer.from(SENTINEL, 'latin1'))).toBe(true);
      const before = Buffer.from(input);
      const result = await createGalleryVideoRenditionCodec({ ffmpegPath, ffprobePath }).render(
        input,
      );
      expect(input).toEqual(before);
      const bytes = Buffer.from(result.output.bytes);
      const boxes = mp4Boxes(bytes);
      // The only user-data item left is the muxer's own software tag (\u00a9too = Lavf
      // version); no location, time, comment, QuickTime key or source handler survives.
      expect(boxes.filter((box) => box.startsWith('moov/udta'))).toEqual([
        'moov/udta',
        'moov/udta/meta',
        'moov/udta/meta/hdlr',
        'moov/udta/meta/ilst',
        'moov/udta/meta/ilst/\u00a9too',
      ]);
      expect(
        boxes.some((box) => /\/(keys|loci|udta)$/.test(box) && !box.startsWith('moov/udta')),
      ).toBe(false);
      for (const marker of [SENTINEL, 'ISO6709', '+01.0000', '©xyz', 'location'])
        expect(bytes.includes(Buffer.from(marker, 'latin1'))).toBe(false);
      const path = join(directory, 'derived.mp4');
      await writeFile(path, bytes, { mode: 0o600 });
      const { stdout } = await execute(
        ffprobePath,
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
        { maxBuffer: 1024 * 1024 },
      );
      const probe = JSON.parse(stdout) as {
        format: { tags?: Record<string, string> };
        streams: { tags?: Record<string, string> }[];
      };
      const tags = [probe.format.tags ?? {}, ...probe.streams.map((s) => s.tags ?? {})];
      const allowed = [
        'major_brand',
        'minor_version',
        'compatible_brands',
        'encoder',
        'language',
        'handler_name',
        'vendor_id',
      ];
      for (const tagSet of tags) {
        for (const key of Object.keys(tagSet)) expect(allowed).toContain(key);
        for (const value of Object.values(tagSet)) expect(value).not.toContain(SENTINEL);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

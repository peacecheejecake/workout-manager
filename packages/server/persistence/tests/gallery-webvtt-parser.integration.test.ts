import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GalleryWebVttError,
  parseGalleryWebVtt,
  type GalleryWebVttErrorCode,
} from '@workout/server-media/gallery-webvtt';

const ownerUrl = process.env['TEST_DATABASE_OWNER_URL'];
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!ownerUrl || !adminUrl || !runtimeUrl)
  throw new Error('Run with an isolated PostgreSQL admin/plain-owner/runtime fixture');
const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
let installed = false;
const errors: readonly GalleryWebVttErrorCode[] = [
  'INVALID_INPUT',
  'SOURCE_TOO_LARGE',
  'INVALID_UTF8',
  'INVALID_CHARACTER',
  'INVALID_HEADER',
  'UNSUPPORTED_HEADER_METADATA',
  'UNSUPPORTED_BLOCK',
  'UNSUPPORTED_CUE_SETTINGS',
  'UNSUPPORTED_CUE_MARKUP',
  'UNSUPPORTED_CHARACTER_REFERENCE',
  'INVALID_TIMESTAMP',
  'INVALID_CUE',
  'DUPLICATE_CUE_IDENTIFIER',
  'CUE_ORDER_INVALID',
  'LIMIT_EXCEEDED',
];
const bytes = (text: string) => Buffer.from(text, 'utf8');
const document = (text = '사용자 자막', timing = '00:00.000 --> 00:02.500') =>
  `WEBVTT\n\n${timing}\n${text}\n`;
function nodeResult(raw: Buffer | null) {
  try {
    return { status: 'accepted' as const, value: parseGalleryWebVtt(raw) };
  } catch (error) {
    if (!(error instanceof GalleryWebVttError)) throw new Error('UNEXPECTED_NODE_PARSER_ERROR');
    return { status: 'rejected' as const, code: error.code };
  }
}
async function sqlResult(raw: Buffer | null) {
  try {
    const response = await owner.query(
      'SELECT public.parse_gallery_webvtt_v1($1::bytea) AS value',
      [raw],
    );
    return { status: 'accepted' as const, value: response.rows[0]?.['value'] as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = errors.find((code) => code === message);
    if (!code) throw new Error('UNEXPECTED_SQL_PARSER_ERROR');
    return { status: 'rejected' as const, code };
  }
}
async function parity(raw: Buffer | null) {
  const expected = nodeResult(raw);
  const actual = await sqlResult(raw);
  expect(actual.status).toBe(expected.status);
  if (actual.status === 'rejected' || expected.status === 'rejected') {
    if (actual.status !== 'rejected' || expected.status !== 'rejected')
      throw new Error('PARSER_STATUS_MISMATCH');
    expect(actual.code).toBe(expected.code);
  } else {
    // Compare full normalized facts without printing subtitle text on failure.
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
      if (value !== null && typeof value === 'object')
        return (
          '{' +
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry))
            .join(',') +
          '}'
        );
      const encoded = JSON.stringify(value);
      if (encoded === undefined) throw new Error('UNEXPECTED_PARSER_FACT');
      return encoded;
    };
    const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
    expect(hash(actual.value)).toBe(hash(expected.value));
  }
  return actual;
}
beforeAll(async () => {
  await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await owner.query(
    await readFile(new URL('../src/sql/gallery-webvtt-parser-v1.sql', import.meta.url), 'utf8'),
  );
  installed = true;
});
afterAll(async () => {
  try {
    if (installed) await owner.query('DROP FUNCTION public.parse_gallery_webvtt_v1(bytea)');
  } finally {
    await Promise.all([owner.end(), admin.end(), runtime.end()]);
  }
});

describe('unregistered owner-only WebVTT SQL parser parity', () => {
  it('preserves actual source bytes, multilingual cues, optional IDs and overlap', async () => {
    for (const text of [
      document(),
      'WEBVTT\n\n',
      document('  원문\t공백  '),
      document('첫째\n둘째 😀 e\u0301'),
      '\ufeffWEBVTT\r\n\r\ncue-한글\r\n00:00.000 --> 00:02.000\r\n자막 😀\r\n\r\nnext\r00:00.000 --> 00:03.000\r겹침\r',
      document('&amp; &lt;script&gt; &lrm; &rlm; &nbsp; &amp;lt;'),
      document('시간', '123:59:59.999 --> 124:00:00.000'),
      document('유니코드\u2028본문', '00:00.000 --> 00:01.000\u00a0'),
      document('시각', '00:00.000 --> 00:01.000\ufeff'),
    ])
      expect((await parity(bytes(text))).status).toBe('accepted');
  });
  it('rejects malformed headers, SRT, unsupported blocks/settings and markup', async () => {
    for (const text of [
      '',
      '1\n00:00:00,000 --> 00:00:01,000\nSRT\n',
      'WEBVTT\n00:00.000 --> 00:01.000\nx',
      'WEBVTT annotation\n\n',
      'WEBVTT\tannotation\n\n',
      'WEBVTT\n\nSTYLE\n::cue { color: red; }\n',
      'WEBVTT\n\nREGION\nid:1\n',
      'WEBVTT\n\nNOTE comment\nignored\n',
      document('<script>synthetic</script>'),
      document('<v Speaker>text'),
      document('<00:01.000>text'),
      document('text', '00:00.000 --> 00:01.000 align:start'),
      document('text', '00:00.000 --> 00:01.000 unknown:1'),
      document('&bogus;'),
      document('&#60;'),
      document('&amp'),
      document('bare &'),
      document('a --> b'),
      document(''),
    ])
      expect((await parity(bytes(text))).status).toBe('rejected');
  });
  it('keeps strict UTF8/control precedence and rejects malformed timestamps', async () => {
    for (const raw of [
      null,
      Buffer.alloc(0),
      Buffer.from([0xc0, 0x80]),
      Buffer.from([0xed, 0xa0, 0x80]),
      Buffer.from([0xf4, 0x90, 0x80, 0x80]),
      Buffer.from([0, 0xff]),
      bytes(document('a\0b')),
      bytes(document('\u0080')),
      bytes(document('\u000b')),
    ])
      expect((await parity(raw)).status).toBe('rejected');
    for (const timing of [
      '0:00.000 --> 00:01.000',
      '00:60.000 --> 00:01.000',
      '00:00,000 --> 00:01.000',
      '00:00.00 --> 00:01.000',
      '00:00.000-->00:01.000',
      '00:02.000 --> 00:01.000',
      '00:01.000 --> 00:01.000',
      '99999999999999999999:00:00.000 --> 99999999999999999999:00:01.000',
      '00:00.000 --> 00:01.000\u2028',
      '00:00.000 --> 00:01.000\u2029',
      '00:00.000 --> 00:01.000 unknown:\u2028x',
    ])
      expect((await parity(bytes(document('text', timing)))).status).toBe('rejected');
  });
  it('rejects duplicates and backwards starts while retaining equal starts', async () => {
    for (const text of [
      'WEBVTT\n\nsame\n00:00.000 --> 00:02.000\na\n\nsame\n00:00.000 --> 00:03.000\nb\n',
      'WEBVTT\n\n00:02.000 --> 00:03.000\na\n\n00:01.000 --> 00:03.000\nb\n',
    ])
      expect((await parity(bytes(text))).status).toBe('rejected');
  });
  it('matches exact UTF16 payload/identifier limits including astral characters', async () => {
    for (const text of ['x'.repeat(2000), '😀'.repeat(1000)])
      expect((await parity(bytes(document(text)))).status).toBe('accepted');
    for (const text of ['x'.repeat(2001), '😀'.repeat(1001)])
      expect((await parity(bytes(document(text)))).status).toBe('rejected');
    expect(
      (await parity(bytes(`WEBVTT\n\n${'😀'.repeat(1000)}\n00:00.000 --> 00:01.000\nx\n`))).status,
    ).toBe('accepted');
    expect(
      (await parity(bytes(`WEBVTT\n\n${'😀'.repeat(1001)}\n00:00.000 --> 00:01.000\nx\n`))).status,
    ).toBe('rejected');
  });
  it('applies raw, line, count and compact normalized JSON caps independently', async () => {
    const repeated = (count: number, text: string) =>
      `WEBVTT\n\n${Array.from({ length: count }, (_, i) => `cue-${i}\n00:00.000 --> 00:01.000\n${text}\n`).join('\n')}`;
    expect((await parity(bytes(repeated(1000, 'x')))).status).toBe('accepted');
    expect((await parity(bytes(repeated(1001, 'x')))).status).toBe('rejected');
    expect((await parity(Buffer.alloc(524289, 65))).status).toBe('rejected');
    expect((await parity(bytes(`WEBVTT\n\n${'\n'.repeat(20000)}`))).status).toBe('rejected');
    expect((await parity(bytes(repeated(200, '\\'.repeat(2000))))).status).toBe('rejected');
    const exactBytes = bytes(`WEBVTT\n\n${' '.repeat(524288 - 8)}`);
    expect(exactBytes.byteLength).toBe(524288);
    expect((await parity(exactBytes)).status).toBe('rejected');
  });
  it('is invoker with fixed configuration and denies PUBLIC/runtime execution', async () => {
    const row = (
      await owner.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,pg_get_userbyid(p.proowner)=current_user AS owned,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p WHERE p.oid='public.parse_gallery_webvtt_v1(bytea)'::regprocedure`)
    ).rows[0];
    expect(row).toEqual({
      prosecdef: false,
      provolatile: 'i',
      proconfig: ['search_path=pg_catalog'],
      owned: true,
      public_execute: false,
    });
    await expect(
      runtime.query('SELECT public.parse_gallery_webvtt_v1($1::bytea)', [bytes(document())]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

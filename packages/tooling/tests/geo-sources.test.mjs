import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  allowedSource,
  allowedSources,
  fetchAllowedSource,
  resolveUrl,
  verifyAllowedSourceFile,
} from '../../../scripts/geo/sources.mjs';

/**
 * Map data acquisition goes through the operations allowlist only (M2-01d, re-run for
 * M2-01k-e): callers name an allowlist id, never a URL, and the download refuses to be
 * moved elsewhere. `curl` is injected, so nothing here touches the network.
 */
let directory;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'geo-sources-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A stand-in for curl that records its arguments and writes what a server would send. */
function curl({ status = 200, body = 'extract-bytes', headers = 'last-modified: x' } = {}) {
  const calls = [];
  const execute = async (command, args) => {
    calls.push({ command, args });
    const output = args[args.indexOf('--output') + 1];
    const headerPath = args[args.indexOf('--dump-header') + 1];
    await writeFile(output, body);
    await writeFile(headerPath, `HTTP/1.1 ${status}\r\n${headers}\r\n`);
    return { stdout: String(status), stderr: '' };
  };
  return { calls, execute };
}

describe('the data acquisition allowlist', () => {
  it('is frozen and every entry is an https URL with no credentials', () => {
    expect(Object.isFrozen(allowedSources)).toBe(true);
    expect(() => allowedSources.push({ id: 'elsewhere' })).toThrow();
    for (const source of allowedSources) {
      const url = resolveUrl(source, { range: '0-255' });
      expect(url.protocol).toBe('https:');
      expect(url.username).toBe('');
      expect(url.password).toBe('');
      expect(source.license).not.toBe('');
    }
  });

  it('refuses an id that is not on the allowlist', () => {
    expect(() => allowedSource('https://example.com/other.osm.pbf')).toThrow(
      'SOURCE_NOT_ALLOWLISTED',
    );
    expect(() => allowedSource('osm-extract-busan')).toThrow('SOURCE_NOT_ALLOWLISTED');
  });

  it('allows only a numeric glyph range to be substituted', () => {
    const glyphs = allowedSource('glyphs-noto-sans-regular');
    expect(resolveUrl(glyphs, { range: '0-255' }).href).toMatch(/\/0-255\.pbf$/);
    for (const range of ['0-255/../../x', '//evil.example/0-255', '', 'a-b'])
      expect(() => resolveUrl(glyphs, { range })).toThrow('INVALID_GLYPH_RANGE');
  });

  it('fetches exactly the allowlisted URL, whatever else a caller passes', async () => {
    const fake = curl();
    const destination = join(directory, 'region.osm.pbf');
    const result = await fetchAllowedSource({
      id: 'osm-extract-seoul',
      destination,
      url: 'https://evil.example/region.osm.pbf',
      execute: fake.execute,
    });
    expect(fake.calls).toHaveLength(1);
    const { command, args } = fake.calls[0];
    expect(command).toBe('curl');
    expect(args[args.indexOf('--url') + 1]).toBe(
      'https://download.bbbike.org/osm/bbbike/Seoul/Seoul.osm.pbf',
    );
    expect(args.join(' ')).not.toContain('evil.example');
    expect(result.url).toBe('https://download.bbbike.org/osm/bbbike/Seoul/Seoul.osm.pbf');
  });

  it('never follows a redirect, ignores a local curlrc and speaks https only', async () => {
    const fake = curl();
    await fetchAllowedSource({
      id: 'osm-extract-seoul',
      destination: join(directory, 'region.osm.pbf'),
      execute: fake.execute,
    });
    const { args } = fake.calls[0];
    expect(args[0]).toBe('--disable');
    expect(args[args.indexOf('--max-redirs') + 1]).toBe('0');
    expect(args[args.indexOf('--proto') + 1]).toBe('=https');
    expect(args).not.toContain('--location');
    expect(args).not.toContain('-L');
    expect(args[args.indexOf('--max-filesize') + 1]).toBe(
      String(allowedSource('osm-extract-seoul').maxBytes),
    );
  });

  it('treats a redirect answer as a failure and keeps nothing of it', async () => {
    const fake = curl({ status: 302, body: '', headers: 'location: https://evil.example/x' });
    const destination = join(directory, 'region.osm.pbf');
    await expect(
      fetchAllowedSource({ id: 'osm-extract-seoul', destination, execute: fake.execute }),
    ).rejects.toThrow('SOURCE_HTTP_STATUS_302');
    expect(await readdir(directory)).toEqual([]);
  });

  it('refuses bytes that do not match a pinned hash and removes them', async () => {
    const fake = curl({ body: 'not-the-pinned-jar' });
    const destination = join(directory, 'graphhopper-web.jar');
    await expect(
      fetchAllowedSource({ id: 'graphhopper-web-jar', destination, execute: fake.execute }),
    ).rejects.toThrow('SOURCE_HASH_MISMATCH');
    expect(await readdir(directory)).toEqual([]);
    await writeFile(destination, 'not-the-pinned-jar');
    await expect(verifyAllowedSourceFile('graphhopper-web-jar', destination)).rejects.toThrow(
      'SOURCE_HASH_MISMATCH',
    );
  });
});

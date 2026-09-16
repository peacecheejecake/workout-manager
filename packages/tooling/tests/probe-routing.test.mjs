import { describe, expect, it, vi } from 'vitest';
import { curlRequest, parseArguments, probe } from '../../../scripts/probe-routing.mjs';

const url = new URL('https://routing.openstreetmap.de/routed-foot/route/v1/foot/0,0;0.001,0.001');
const testCase = {
  id: 'SYNTHETIC',
  context: 'unit fixture',
  coordinates: [
    [0, 0],
    [0.001, 0.001],
  ],
};
function payload() {
  return {
    code: 'Ok',
    routes: [
      {
        distance: 150,
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [0.001, 0.001],
          ],
        },
      },
    ],
    waypoints: [
      { location: [0, 0], distance: 0 },
      { location: [0.001, 0.001], distance: 1 },
    ],
  };
}

describe('explicit routing research transport', () => {
  it('requires explicit execution and curl opt-in without silently accepting extra options', () => {
    expect(parseArguments(['--execute'])).toBe('node');
    expect(parseArguments(['--execute', '--transport=curl'])).toBe('curl');
    for (const args of [
      [],
      ['--transport=curl'],
      ['--execute', '--transport=other'],
      ['--execute', '--transport=curl', '--url=http://invalid'],
    ])
      expect(parseArguments(args)).toBeNull();
  });

  it('runs curl without a shell, curlrc, redirects or retries, with TLS/time/body bounds', async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: `${JSON.stringify(payload())}\n200` });
    expect(await curlRequest(url, execute)).toEqual({ status: 200, payload: payload() });
    const [command, args, options] = execute.mock.calls[0];
    expect(command).toBe('curl');
    expect(args[0]).toBe('--disable');
    expect(args).toEqual(
      expect.arrayContaining([
        '--proto',
        '=https',
        '--max-redirs',
        '0',
        '--max-time',
        '15',
        '--max-filesize',
        '524288',
        '--user-agent',
        '--url',
        url.href,
      ]),
    );
    expect(args).not.toContain('--location');
    expect(args).not.toContain('--retry');
    expect(options).toEqual({
      timeout: 15000,
      killSignal: 'SIGKILL',
      maxBuffer: 524292,
      encoding: 'utf8',
    });
  });

  it.each([
    'http://routing.openstreetmap.de/routed-foot/route/v1/foot/0,0;0,0',
    'https://elsewhere.test/routed-foot/route/v1/foot/0,0;0,0',
    'https://secret@routing.openstreetmap.de/routed-foot/route/v1/foot/0,0;0,0',
  ])('rejects non-allowlisted endpoint %s before spawn', async (value) => {
    const execute = vi.fn();
    await expect(curlRequest(new URL(value), execute)).rejects.toThrow('INVALID_ENDPOINT');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects redirects and oversized bodies even if the process returns successfully', async () => {
    await expect(curlRequest(url, async () => ({ stdout: '{}\n302' }))).rejects.toThrow(
      'REDIRECT_REJECTED',
    );
    await expect(
      curlRequest(url, async () => ({ stdout: `${' '.repeat(524289)}\n200` })),
    ).rejects.toThrow('RESPONSE_TOO_LARGE');
    await expect(curlRequest(url, async () => ({ stdout: '{}\n000' }))).rejects.toThrow(
      'INVALID_HTTP_STATUS',
    );
  });

  it.each([
    [28, 'TIMEOUT'],
    [63, 'RESPONSE_TOO_LARGE'],
    ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'RESPONSE_TOO_LARGE'],
    [60, 'CURL_REQUEST_FAILED'],
  ])('sanitizes curl failure %s', async (code, errorCode) => {
    const execute = async () => {
      throw Object.assign(new Error('private provider stderr'), {
        code,
        stderr: 'private provider stderr',
      });
    };
    const result = await probe(testCase, (requestUrl) => curlRequest(requestUrl, execute));
    expect(result.error).toBe(errorCode);
    expect(JSON.stringify(result)).not.toContain('private provider stderr');
    expect(result.outcome).toBe('request_failed');
    expect(result.coverageReview).toBe('not_reviewed');
  });

  it.each([403, 429])(
    'preserves HTTP %s on non-JSON responses so the caller stops probing',
    async (status) => {
      const result = await probe(testCase, (requestUrl) =>
        curlRequest(requestUrl, async () => ({ stdout: `<html>blocked</html>\n${status}` })),
      );
      expect(result).toMatchObject({
        httpStatus: status,
        outcome: 'request_failed',
        error: 'REQUEST_OR_PARSE_FAILED',
      });
      expect(JSON.stringify(result)).not.toContain('blocked');
    },
  );

  it('records only bounded geometry summary and never promotes computed routes to coverage approval', async () => {
    const result = await probe(testCase, async () => ({ status: 200, payload: payload() }));
    expect(result).toMatchObject({
      httpStatus: 200,
      providerCode: 'Ok',
      distanceMeters: 150,
      geometryCoordinateCount: 2,
      outcome: 'computed_not_reviewed',
      coverageReview: 'not_reviewed',
      error: null,
    });
    expect(result.geometryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result).not.toHaveProperty('geometry');
    expect(result).not.toHaveProperty('routes');
  });

  it('rejects invalid geometry, out of radius snaps and malformed waypoints', async () => {
    const invalidGeometry = payload();
    invalidGeometry.routes[0].geometry.coordinates[0][0] = 181;
    const invalidSnap = payload();
    invalidSnap.waypoints[0].distance = 100.1;
    const nullSnap = payload();
    nullSnap.waypoints[0] = null;
    for (const [value, error] of [
      [invalidGeometry, 'INVALID_ROUTE'],
      [invalidSnap, 'INVALID_SNAP'],
      [nullSnap, 'INVALID_SNAP'],
    ]) {
      const result = await probe(testCase, async () => ({ status: 200, payload: value }));
      expect(result).toMatchObject({ outcome: 'request_failed', error, geometryHash: null });
    }
  });

  it('distinguishes unreachable from provider rejection without retaining upstream message', async () => {
    for (const [status, code, outcome] of [
      [400, 'NoSegment', 'unreachable'],
      [200, 'NoRoute', 'unreachable'],
      [429, 'TooManyRequests', 'provider_rejected'],
    ]) {
      const result = await probe(testCase, async () => ({
        status,
        payload: { code, message: 'untrusted details' },
      }));
      expect(result).toMatchObject({
        httpStatus: status,
        providerCode: code,
        outcome,
        coverageReview: 'not_reviewed',
      });
      expect(JSON.stringify(result)).not.toContain('untrusted details');
    }
  });
});

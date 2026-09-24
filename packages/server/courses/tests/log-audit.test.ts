import { describe, expect, it } from 'vitest';

import {
  auditLogLines,
  coordinateProbes,
  createLogCapture,
  formatLogFindings,
  valueProbes,
  type LogExpectation,
} from '../src/log-audit.js';

const reqId = '0b6f1a52-3c1e-4d7a-9f3e-5a2b8c9d0e1f';
const version = 'c2-release-7';
const expectation: LogExpectation = { traceField: 'reqId', version };

function line(fields: Record<string, unknown> = {}) {
  return JSON.stringify({
    level: 30,
    time: 1_758_000_000_000,
    pid: 4242,
    hostname: 'api-host',
    reqId,
    version,
    event: 'request_completed',
    method: 'POST',
    statusCode: 200,
    ...fields,
  });
}

const kinds = (lines: string[], override: Partial<LogExpectation> = {}) =>
  auditLogLines(lines, { ...expectation, ...override }).map((finding) => finding.kind);

describe('operational log audit', () => {
  it('accepts a clean, traced and versioned line', () => {
    expect(auditLogLines([line()], expectation)).toEqual([]);
    expect(
      auditLogLines([line({ event: 'request_failed', code: 'INTERNAL_ERROR' })], expectation),
    ).toEqual([]);
  });

  it('refuses a stream with no lines, so a discarded stream cannot pass', () => {
    expect(kinds([])).toEqual(['too_few_records']);
    expect(kinds([line()], { minRecords: 2 })).toEqual(['too_few_records']);
    expect(kinds([], { minRecords: 0 })).toEqual([]);
  });

  it('requires the trace id and the exact version on every line', () => {
    const { reqId: _dropped, ...withoutTrace } = JSON.parse(line()) as Record<string, unknown>;
    expect(kinds([JSON.stringify(withoutTrace)])).toEqual(['missing_trace_id']);
    expect(kinds([line({ reqId: 'req-1' })])).toEqual(['missing_trace_id']);
    const { version: _gone, ...withoutVersion } = JSON.parse(line()) as Record<string, unknown>;
    expect(kinds([JSON.stringify(withoutVersion)])).toEqual(['missing_version']);
    expect(kinds([line({ version: 'other' })])).toEqual(['missing_version']);
  });

  it('accepts a git SHA as the expected version, and only in the version field', () => {
    for (const sha of ['a1b2c3d4'.repeat(5), 'f00d'.repeat(16), '1.2345.6']) {
      expect(kinds([line({ version: sha })], { version: sha })).toEqual([]);
      // The same value in another field is still a token-like run or a decimal.
      expect(kinds([line({ version: sha, msg: `built ${sha}` })], { version: sha })).toHaveLength(
        1,
      );
    }
    // A different SHA in the version field is a wrong version and still a token-like run.
    expect(kinds([line({ version: 'b'.repeat(40) })], { version: 'a'.repeat(40) }).sort()).toEqual([
      'missing_version',
      'token',
    ]);
  });

  it('lets only a named process-level line omit the trace id', () => {
    const { reqId: _dropped, ...untraced } = JSON.parse(line()) as Record<string, unknown>;
    const listening = JSON.stringify({
      ...untraced,
      msg: 'Server listening at http://127.0.0.1:1',
    });
    const untracedMessagePrefixes = ['Server listening at '];
    expect(kinds([listening], { untracedMessagePrefixes })).toEqual([]);
    expect(kinds([listening])).toEqual(['missing_trace_id']);
    expect(
      kinds([JSON.stringify({ ...untraced, msg: 'other' })], { untracedMessagePrefixes }),
    ).toEqual(['missing_trace_id']);
  });

  it('refuses coordinates by field, by number and by decimal text', () => {
    expect(kinds([line({ geometry: { type: 'LineString' } })])).toEqual(['coordinate']);
    expect(kinds([line({ lat: 37 })])).toEqual(['coordinate']);
    expect(kinds([line({ msg: 'start 127.0201,37.5001' })])).toEqual(['coordinate']);
    expect(kinds([line({ code: 37.5 })])).toEqual(['coordinate']);
    // An ISO timestamp's milliseconds are not a coordinate.
    expect(kinds([line({ msg: 'at 2026-09-19T01:00:00.000Z' })])).toEqual([]);
  });

  it('refuses waypoints by field and by probe', () => {
    expect(kinds([line({ waypoints: [] })])).toEqual(['waypoint']);
    const probes = coordinateProbes([[126.97, 37.57]], 'waypoint');
    expect(kinds([line({ msg: 'leg 126.97' })], { probes })).toEqual(['waypoint']);
  });

  it('refuses object keys by field, by path shape and by probe', () => {
    expect(kinds([line({ objectKey: 'x' })])).toEqual(['object_key']);
    expect(kinds([line({ msg: 'wrote private/v1/tenants/x' })])).toEqual(['object_key']);
    expect(kinds([line({ msg: `a/sha256/${'a'.repeat(64)}.json` })])).toEqual([
      'object_key',
      'token',
    ]);
    const probes = valueProbes('object_key', ['/var/lib/objects']);
    expect(kinds([line({ msg: 'root /var/lib/objects' })], { probes })).toEqual(['object_key']);
  });

  it('refuses tokens by field, by bearer shape, by long runs and by probe', () => {
    expect(kinds([line({ authorization: 'x' })])).toEqual(['token']);
    expect(kinds([line({ leaseToken: 'x' })])).toEqual(['token']);
    expect(kinds([line({ msg: 'Bearer abc' })])).toEqual(['token']);
    expect(kinds([line({ msg: `csrf ${'c'.repeat(43)}` })])).toEqual(['token']);
    // UUIDs are identifiers and long error codes are vocabulary, not credentials.
    expect(kinds([line({ msg: `for ${reqId}` })])).toEqual([]);
    expect(kinds([line({ code: 'CANDIDATE_LOCKED_WAYPOINT_OUTSIDE_SEARCH_AREA' })])).toEqual([]);
    expect(kinds([line({ event: 'course_thumbnail_render_finished_for_a_long_time' })])).toEqual(
      [],
    );
    expect(kinds([line({ msg: `${'aB_'.repeat(12)}` })])).toEqual(['token']);
    expect(kinds([line({ msg: `${'A'.repeat(40)}` })])).toEqual(['token']);
    const probes = valueProbes('token', ['session=fixture']);
    expect(kinds([line({ msg: 'cookie session=fixture' })], { probes })).toEqual(['token']);
  });

  it('refuses bodies by field and by probe', () => {
    expect(kinds([line({ body: {} })])).toEqual(['body']);
    expect(kinds([line({ req: {} })])).toEqual(['body']);
    expect(kinds([line({ url: '/bff/v1/courses' })])).toEqual(['body']);
    const probes = valueProbes('body', ['Seoul loop']);
    expect(kinds([line({ msg: 'renamed to Seoul loop' })], { probes })).toEqual(['body']);
  });

  it('refuses an unlisted field and an unparseable line', () => {
    expect(kinds([line({ extra: 1 })])).toEqual(['unexpected_field']);
    expect(kinds([line({ extra: 1 })], { allowedFields: ['extra'] })).toEqual([]);
    expect(kinds(['not json'])).toEqual(['unparseable']);
    expect(kinds(['[1]'])).toEqual(['unparseable']);
  });

  it('never repeats the offending value in a finding', () => {
    const secret = 'Bearer do-not-print-this';
    const findings = auditLogLines([line({ msg: secret, authorization: secret })], expectation);
    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toContain('do-not-print-this');
    expect(formatLogFindings(findings)).not.toContain('do-not-print-this');
  });

  it('only probes fractional ordinates', () => {
    expect(coordinateProbes([[127, 37.5]])).toEqual([{ kind: 'coordinate', value: '37.5' }]);
  });

  it('captures a stream, an event sink and raw text without dropping anything', () => {
    const capture = createLogCapture();
    capture.stream.write(`${line()}\n${line({ event: 'a' })}`);
    capture.stream.write(`\n`);
    capture.sink({ event: 'b' });
    capture.append('partial');
    expect(capture.lines()).toHaveLength(4);
    expect(capture.lines().at(-1)).toBe('partial');
    expect(JSON.parse(capture.lines()[2] ?? '')).toEqual({ event: 'b' });
  });
});

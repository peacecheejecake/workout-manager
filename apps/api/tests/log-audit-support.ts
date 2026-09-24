import { afterAll, afterEach, expect } from 'vitest';

import {
  auditLogLines,
  createLogCapture,
  formatLogFindings,
  type LogCapture,
  type LogProbe,
} from '@workout/server-courses/log-audit';

/** The release every API a route test builds runs as, and so logs as `version`. */
export const testRelease = 'test-release-c2';

/**
 * Keep the log stream of every API a test file builds, and audit it after each test
 * (M2-01k-c2). The route tests used to hand the API a stream that dropped every line, so
 * nothing they ran could show what the routes log.
 *
 * Call it at the top of the file, before the file's own `afterEach`: hooks run in reverse,
 * so the audit sees the lines after the apps are closed. Each test's lines must carry a
 * UUID `reqId` and `version` {@link testRelease}, hold no coordinate, waypoint, object key,
 * token or body by name or shape, and contain none of the file's planted `probes`.
 *
 * A single test that builds an app but sends nothing writes no lines, so one test is not
 * held to a minimum. The file as a whole is: after all its tests at least `minFileLines`
 * lines must have been audited, so a stream that is silently discarded again — or a
 * logger turned off — fails the file rather than passing every audit vacuously.
 */
export function auditRouteLogs(
  probes: readonly LogProbe[] | (() => readonly LogProbe[]),
  minFileLines = 1,
) {
  let captures: LogCapture[] = [];
  let audited = 0;
  afterEach(() => {
    const lines = captures.flatMap((capture) => capture.lines());
    captures = [];
    audited += lines.length;
    const findings = auditLogLines(lines, {
      traceField: 'reqId',
      version: testRelease,
      // A function for probes only known once `beforeAll` ran, such as a storage root.
      probes: typeof probes === 'function' ? probes() : probes,
      minRecords: 0,
      // Fastify's own startup line, for tests that listen on a real socket.
      untracedMessagePrefixes: ['Server listening at '],
    });
    expect(findings, formatLogFindings(findings)).toEqual([]);
  });
  afterAll(() => {
    expect(audited, 'log lines audited in this file').toBeGreaterThanOrEqual(minFileLines);
  });
  return {
    /** Spread into `createApi`: a kept log stream and the release the lines must carry. */
    options() {
      const capture = createLogCapture();
      captures.push(capture);
      return { logStream: capture.stream, version: testRelease };
    },
    /** The lines kept so far in the current test, for a test that asserts what was logged. */
    lines() {
      return captures.flatMap((capture) => capture.lines());
    },
  };
}

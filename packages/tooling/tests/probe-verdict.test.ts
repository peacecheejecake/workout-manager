import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  coursePerformanceVerdict,
  iterativeEditChecks,
  iterativeEditSucceeded,
  routingOperationalVerdict,
  runIterativeEdits,
  type ProbeCheck,
  type ProbeFinding,
} from '../../../scripts/probe-verdict';

/**
 * M2-02 review M202-P1-05 and M202-P2-04: a probe that recorded a failed request must not
 * report success or exit 0. The probes themselves need GraphHopper, PostgreSQL and the
 * fixture OIDC provider, so the decision they now delegate is tested here on synthetic
 * answers, and the scripts are checked to use it for their report and exit code.
 */
const passing: ProbeCheck = { id: 'configured-direct-route-real-engine', passed: true, detail: '' };
const finding: ProbeFinding = {
  id: 'iterative-recompute-refused-by-proposal-quota',
  requirement: 'S14 edit loop',
  expected: 'Each recompute succeeds',
  observed: 'refused',
};

/** 200 route_computed, except the given edits, which answer 429 rate_limited. */
function sender(refused: ReadonlySet<number>) {
  const sent: number[] = [];
  const send = (edit: number) => {
    sent.push(edit);
    return Promise.resolve(
      refused.has(edit)
        ? { statusCode: 429, body: { error: { code: 'ROUTING_RATE_LIMITED' } } }
        : { statusCode: 200, body: { outcome: 'route_computed' } },
    );
  };
  return { sent, send };
}

describe('operational routing probe: 12 consecutive edits (M202-P1-05)', () => {
  it('passes with every edit answering 200 route_computed', async () => {
    const { sent, send } = sender(new Set());
    const entries = await runIterativeEdits(12, send, () => 0);
    expect(sent).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const checks = iterativeEditChecks(entries);
    expect(checks).toHaveLength(12);
    expect(checks.every((entry) => entry.passed)).toBe(true);
    expect(routingOperationalVerdict([passing, ...checks], [])).toEqual({
      result: 'all_checks_passed',
      failed: [],
      findings: [],
      exitCode: 0,
    });
  });

  it('fails the report and the exit code when some edits answer 429', async () => {
    const { sent, send } = sender(new Set([6, 9]));
    const entries = await runIterativeEdits(12, send, () => 0);
    // A refusal does not stop the loop: all twelve are sent and recorded.
    expect(sent).toHaveLength(12);
    expect(entries[5]).toEqual({
      edit: 6,
      status: 429,
      outcome: 'ROUTING_RATE_LIMITED',
      milliseconds: 0,
    });
    const checks = iterativeEditChecks(entries);
    expect(checks.filter((entry) => !entry.passed).map((entry) => entry.id)).toEqual([
      'iterative-edit-6-route-computed',
      'iterative-edit-9-route-computed',
    ]);
    expect(checks[5]?.detail).toBe('status 429 ROUTING_RATE_LIMITED in 0 ms');
    const verdict = routingOperationalVerdict([passing, ...checks], [finding]);
    expect(verdict).toEqual({
      result: 'checks_failed',
      failed: ['iterative-edit-6-route-computed', 'iterative-edit-9-route-computed'],
      findings: ['iterative-recompute-refused-by-proposal-quota'],
      exitCode: 1,
    });
  });

  it('requires route_computed, not only status 200', () => {
    expect(
      iterativeEditSucceeded({ edit: 1, status: 200, outcome: 'no_route', milliseconds: 1 }),
    ).toBe(false);
    expect(
      iterativeEditSucceeded({ edit: 1, status: 200, outcome: 'route_computed', milliseconds: 1 }),
    ).toBe(true);
  });

  it('records an answer without a JSON body as ? and fails it', async () => {
    const entries = await runIterativeEdits(
      1,
      () => Promise.resolve({ statusCode: 503, body: null }),
      () => 0,
    );
    expect(entries).toEqual([{ edit: 1, status: 503, outcome: '?', milliseconds: 0 }]);
    expect(iterativeEditChecks(entries)[0]?.passed).toBe(false);
  });

  it('fails the run on a finding even when every check passed (the historical r2 case)', () => {
    expect(routingOperationalVerdict([passing], [finding])).toEqual({
      result: 'findings_recorded',
      failed: [],
      findings: ['iterative-recompute-refused-by-proposal-quota'],
      exitCode: 1,
    });
  });

  it('is what the probe writes as result and sets as exit code', () => {
    const source = readFileSync(
      new URL('../../../scripts/probe-routing-operational.mts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('const verdict = routingOperationalVerdict(checks, findings);');
    expect(source).toContain('result: verdict.result,');
    expect(source).toContain('process.exitCode = verdict.exitCode;');
    expect(source).toContain('for (const entry of iterativeEditChecks(iterativeEntries))');
    expect(source).not.toContain('failed.length > 0');
  });
});

describe('course performance probe: failed steps (M202-P2-04)', () => {
  it('exits 0 with no failed step; in-process steps have no status', () => {
    expect(
      coursePerformanceVerdict([
        { step: 'activity-import', status: 200 },
        { step: 'thumbnail-render-in-process', status: null },
      ]),
    ).toEqual({ failures: [], exitCode: 0 });
  });

  it('lists every failed step in the report and exits nonzero', () => {
    expect(
      coursePerformanceVerdict([
        { step: 'activity-import', status: 200 },
        { step: 'gpx-export', status: 409 },
        { step: 'thumbnail-render-in-process', status: null },
        { step: 'candidates-2000m', status: 429 },
        { step: 'course-list', status: 500 },
      ]),
    ).toEqual({ failures: ['gpx-export', 'candidates-2000m', 'course-list'], exitCode: 1 });
  });

  it('is what the probe writes as failures and sets as exit code, after the report', () => {
    const source = readFileSync(
      new URL('../../../scripts/probe-course-performance.mts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('const verdict = coursePerformanceVerdict(steps);');
    expect(source).toContain('failures: verdict.failures,');
    const written = source.indexOf('await rename(`${reportPath}.tmp`, reportPath);');
    const exit = source.indexOf('process.exitCode = verdict.exitCode;');
    expect(written).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(written);
  });
});

/**
 * M2-02 review M202-P1-05 / M202-P2-04: the pass/fail decision of the operational routing
 * probe and the course performance probe, kept free of engines, databases and HTTP so the
 * decision itself is unit tested (packages/tooling/tests/probe-verdict.test.ts).
 *
 * A probe that recorded a failed request must not report success or exit 0. Before this,
 * the routing probe put a failed iterative edit only in `findings` and judged `result` and
 * the exit code on `checks` alone, and the course probe listed HTTP failures in `failures`
 * but always exited 0.
 */

export interface ProbeCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ProbeFinding {
  readonly id: string;
  readonly requirement: string;
  readonly expected: string;
  readonly observed: string;
}

/** One recompute of the iterative editing loop, as the API answered it. */
export interface IterativeEdit {
  readonly edit: number;
  readonly status: number;
  /** The result's `outcome`, else the error code, else `?`. */
  readonly outcome: string;
  readonly milliseconds: number;
}

export function iterativeEditOutcome(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '?';
  const { outcome, error } = body as { outcome?: unknown; error?: { code?: unknown } };
  if (typeof outcome === 'string') return outcome;
  if (typeof error?.code === 'string') return error.code;
  return '?';
}

export function iterativeEditSucceeded(entry: IterativeEdit) {
  return entry.status === 200 && entry.outcome === 'route_computed';
}

export function formatIterativeEdit(entry: IterativeEdit) {
  return `${entry.edit}:${entry.status}:${entry.outcome}:${entry.milliseconds}ms`;
}

/**
 * Runs `edits` consecutive recomputes through `send` and records each answer. Nothing is
 * judged here; a failed edit is recorded and the loop goes on, so the report shows them all.
 */
export async function runIterativeEdits(
  edits: number,
  send: (edit: number) => Promise<{ statusCode: number; body: unknown }>,
  now: () => number = () => performance.now(),
): Promise<IterativeEdit[]> {
  const entries: IterativeEdit[] = [];
  for (let edit = 1; edit <= edits; edit += 1) {
    const started = now();
    const response = await send(edit);
    entries.push({
      edit,
      status: response.statusCode,
      outcome: iterativeEditOutcome(response.body),
      milliseconds: Math.round(now() - started),
    });
  }
  return entries;
}

/** Every edit of the loop is its own check: each must answer `200 route_computed`. */
export function iterativeEditChecks(entries: readonly IterativeEdit[]): ProbeCheck[] {
  return entries.map((entry) => ({
    id: `iterative-edit-${entry.edit}-route-computed`,
    passed: iterativeEditSucceeded(entry),
    detail: `status ${entry.status} ${entry.outcome} in ${entry.milliseconds} ms`,
  }));
}

export type RoutingOperationalResult = 'all_checks_passed' | 'checks_failed' | 'findings_recorded';

/**
 * The routing probe passes only with every check passed AND no finding recorded: a finding
 * is a product requirement the run observed unmet, so it fails the run as a check does.
 */
export function routingOperationalVerdict(
  checks: readonly ProbeCheck[],
  findings: readonly ProbeFinding[],
): {
  result: RoutingOperationalResult;
  failed: string[];
  findings: string[];
  exitCode: 0 | 1;
} {
  const failed = checks.filter((entry) => !entry.passed).map((entry) => entry.id);
  const findingIds = findings.map((entry) => entry.id);
  const result: RoutingOperationalResult =
    failed.length > 0
      ? 'checks_failed'
      : findingIds.length > 0
        ? 'findings_recorded'
        : 'all_checks_passed';
  return {
    result,
    failed,
    findings: findingIds,
    exitCode: result === 'all_checks_passed' ? 0 : 1,
  };
}

/** A measured step of the course performance probe; `status` is null for in-process work. */
export interface MeasuredStep {
  readonly step: string;
  readonly status: number | null;
}

/** Any HTTP failure in a measured step fails the course performance run. */
export function coursePerformanceVerdict(steps: readonly MeasuredStep[]): {
  failures: string[];
  exitCode: 0 | 1;
} {
  const failures = steps
    .filter((entry) => entry.status !== null && entry.status >= 400)
    .map((entry) => entry.step);
  return { failures, exitCode: failures.length === 0 ? 0 : 1 };
}

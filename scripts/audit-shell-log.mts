/**
 * T11, the web-shell stream (M2-01k-o §8): audit what the two shells wrote during an identity
 * run in which a link was made and read through them.
 *
 *   IDENTITY_E2E_COURSE_SHARING=on IDENTITY_E2E_SHELL_LOGS=pipe \
 *   IDENTITY_E2E_SHELL_PROBES=/tmp/probes.jsonl \
 *     pnpm exec playwright test --config playwright.identity.config.ts \
 *     tests/identity/course-sharing.spec.ts > run.log 2>&1
 *   node --import tsx scripts/audit-shell-log.mts run.log /tmp/probes.jsonl
 *
 * `IDENTITY_E2E_SHELL_LOGS=pipe` makes Playwright print each shell's stdout and stderr into the
 * run's output, prefixed `[WebServer]`. The spec writes the values it planted — the token, its
 * SHA-256, every ordinate of the line it was shown, the course name — one JSON line each to the
 * probe file. This script looks for every probe in every captured shell line, the same probe
 * layer as `auditLogLines` (the shells write plain text, not JSON, so the field and shape
 * layers do not apply). A finding names the line number and the probe kind, never the value.
 * The probe file holds synthetic test values only and is deleted here.
 *
 * Exit 0: the shells' lines were captured (both shells' start-up lines are present) and none
 * holds a probe. Exit 1: a probe was found, or nothing was captured to judge.
 */
import { readFileSync, rmSync } from 'node:fs';

const [runLog, probeFile] = process.argv.slice(2);
if (!runLog || !probeFile) {
  console.error('usage: audit-shell-log.mts <run log> <probe file>');
  process.exit(2);
}

const probes = readFileSync(probeFile, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as { kind: string; value: string })
  .filter((probe) => probe.value.length > 0);
rmSync(probeFile, { force: true });

const shellLines = readFileSync(runLog, 'utf8')
  .split('\n')
  .filter((line) => line.includes('[WebServer]'));

const findings: { line: number; kind: string }[] = [];
for (const [index, line] of shellLines.entries())
  for (const probe of probes)
    if (line.includes(probe.value)) findings.push({ line: index + 1, kind: probe.kind });

const kinds = Object.fromEntries(
  [...new Set(probes.map((probe) => probe.kind))].map((kind) => [
    kind,
    probes.filter((probe) => probe.kind === kind).length,
  ]),
);
// Both shells announced themselves, so the capture really was on.
const next = shellLines.some((line) => /next start/.test(line));
const vite = shellLines.some((line) => /vite preview/.test(line));
const summary = {
  shellLines: shellLines.length,
  captured: { next, vite },
  probes: kinds,
  findings,
};
console.log(JSON.stringify(summary, null, 2));
if (!next || !vite || probes.length === 0 || findings.length > 0) process.exit(1);

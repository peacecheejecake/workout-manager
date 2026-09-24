import { Writable } from 'node:stream';

/**
 * What an operational log line may and may not carry (M2-01k-c2, map plan section 7:
 * "원본 GPS·정확한 waypoint·객체 key·토큰·본문은 로그/trace에 넣지 않는다", V2-F36: trace IDs
 * and versions, no raw tokens).
 *
 * Two halves, both reusable by any node that writes or tests a log stream:
 *
 * - {@link createLogCapture} keeps a log stream instead of discarding it. It is a
 *   `Writable` for a pino/Fastify logger, a sink for a worker's event callback, and an
 *   `append` for a child process's stdout/stderr, so the lines under audit are the lines
 *   the process really wrote.
 * - {@link auditLogLines} judges those lines. Every line must be one JSON object that
 *   carries the trace id and the expected version, holds only allowed top-level fields,
 *   and contains nothing that looks like — or exactly is — a coordinate, waypoint, object
 *   key, token or request/response body.
 *
 * The audit never copies an offending value into a finding: a finding names the line, the
 * JSON path and the rule, so a failing assertion does not print the secret it caught.
 *
 * Detection is layered because each layer misses something the others see:
 *
 * 1. **Field names.** A key such as `waypoints`, `geometry`, `objectKey`, `authorization`
 *    or `body` is refused at any depth, whatever its value.
 * 2. **Value shapes.** A fractional number, a decimal with three or more fractional digits
 *    inside a string, a `private/v1/…` or `…/sha256/…` storage path, a bearer credential
 *    or a long unbroken token-like run is refused wherever it appears, including in `msg`.
 * 3. **Probes.** The caller lists the exact values its fixtures planted — the coordinates
 *    it sent, the object key its storage returned, the token in its headers, the course
 *    name in its body — and any of them anywhere in the raw line is a leak, even under an
 *    innocent field name and in a shape the patterns do not know.
 * 4. **Allowlist.** A top-level field outside the operational set is refused as
 *    `unexpected_field`, so a new field is a conscious decision rather than an accident.
 */
export type LogLeakKind = 'coordinate' | 'waypoint' | 'object_key' | 'token' | 'body';

export type LogFindingKind =
  | LogLeakKind
  | 'missing_trace_id'
  | 'missing_version'
  | 'unexpected_field'
  | 'unparseable'
  | 'too_few_records';

export interface LogFinding {
  readonly kind: LogFindingKind;
  /** One-based line number in the captured stream; 0 for a finding about the whole stream. */
  readonly line: number;
  /** JSON path of the offending leaf (`$.msg`, `$.err.message`), or `$` for the line. */
  readonly path: string;
  /** Which rule fired. Never the offending value. */
  readonly rule: string;
}

/** An exact value a test planted and that must not appear anywhere in a log line. */
export interface LogProbe {
  readonly kind: LogLeakKind;
  readonly value: string;
}

export interface LogExpectation {
  /** The field that carries the per-request or per-run trace id, e.g. `reqId` or `runId`. */
  readonly traceField: string;
  /** The version every line must carry in its `version` field. */
  readonly version: string;
  readonly probes?: readonly LogProbe[];
  /** Top-level fields allowed in addition to {@link operationalLogFields}. */
  readonly allowedFields?: readonly string[];
  /** Fewer captured lines than this is itself a finding. Defaults to 1. */
  readonly minRecords?: number;
  /**
   * Process-level lines that belong to no request or run, such as a server's
   * `Server listening at …`, named by the start of their `msg`. Only these may omit the trace
   * id; they still need the version and are still searched for leaks.
   */
  readonly untracedMessagePrefixes?: readonly string[];
}

/**
 * Top-level fields an operational line may carry: pino's own, the event name and its
 * bounded outcome, the trace id and the version. Nothing here can hold user content.
 */
export const operationalLogFields: readonly string[] = [
  'level',
  'time',
  'pid',
  'hostname',
  'msg',
  'event',
  'version',
  'method',
  'statusCode',
  'code',
  'result',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

/** Field names refused at any depth, keyed by their normalised spelling. */
const deniedFieldKinds: ReadonlyMap<string, LogLeakKind> = new Map<string, LogLeakKind>([
  ...(['waypoint', 'waypoints', 'via', 'vias', 'routepoint', 'routepoints'] as const).map(
    (name) => [name, 'waypoint'] as const,
  ),
  ...(
    [
      'coordinate',
      'coordinates',
      'coords',
      'geometry',
      'geojson',
      'polyline',
      'position',
      'positions',
      'point',
      'points',
      'lat',
      'lng',
      'lon',
      'long',
      'latitude',
      'longitude',
      'bbox',
      'bounds',
      'center',
      'location',
    ] as const
  ).map((name) => [name, 'coordinate'] as const),
  ...(
    [
      'key',
      'objectkey',
      'storagekey',
      'storageref',
      'storagepath',
      'temporaryref',
      'temporarykey',
      'finalref',
      'finalkey',
      'ref',
      'path',
      'filepath',
      'signedurl',
    ] as const
  ).map((name) => [name, 'object_key'] as const),
  ...(
    [
      'authorization',
      'cookie',
      'cookies',
      'setcookie',
      'token',
      'secret',
      'password',
      'apikey',
      'signature',
      'credential',
      'credentials',
    ] as const
  ).map((name) => [name, 'token'] as const),
  ...(
    [
      'body',
      'rawbody',
      'payload',
      'req',
      'request',
      'res',
      'response',
      'headers',
      'query',
      'params',
      'url',
      'content',
      'name',
      'filename',
      'originalfilename',
      'description',
      'note',
      'gpx',
      'text',
      'input',
    ] as const
  ).map((name) => [name, 'body'] as const),
]);

function deniedField(name: string): LogLeakKind | null {
  const normalised = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const exact = deniedFieldKinds.get(normalised);
  if (exact !== undefined) return exact;
  if (normalised.endsWith('token') || normalised.endsWith('secret')) return 'token';
  return null;
}

/** Shapes refused inside any string leaf, `msg` included. */
const stringRules: readonly { kind: LogLeakKind; rule: string; pattern: RegExp }[] = [
  // A storage key or a path under one. Every private object lives under `private/v<n>/`.
  { kind: 'object_key', rule: 'private-object-prefix', pattern: /private\/v\d+\//i },
  { kind: 'object_key', rule: 'tenant-object-path', pattern: /\/tenants\/[0-9a-f-]{36}\//i },
  { kind: 'object_key', rule: 'content-addressed-path', pattern: /sha256\/[0-9a-f]{64}/i },
  { kind: 'token', rule: 'bearer-credential', pattern: /\bbearer\s+\S/i },
  // A decimal with three or more fractional digits: a longitude/latitude written as text.
  // Not preceded by `:` so the milliseconds of an ISO timestamp are not mistaken for one.
  { kind: 'coordinate', rule: 'decimal-degrees', pattern: /(?<![\w.:])-?\d{1,3}\.\d{3,}/ },
];

/** A long unbroken run of token characters once UUIDs are set aside: a secret or a digest. */
const TOKEN_RUN = /[A-Za-z0-9_-]{32,}/g;
/**
 * A stable code or event name (`COURSE_GRAPH_ACKNOWLEDGEMENT_STALE`,
 * `course_thumbnail_render_finished`): single-case words joined by underscores. Fixed
 * vocabulary, not a credential, however long. A mixed-case or unbroken run still counts.
 */
const VOCABULARY = /^(?:[A-Z0-9]+(?:_[A-Z0-9]+)+|[a-z0-9]+(?:_[a-z0-9]+)+)$/;

function hasTokenRun(value: string): boolean {
  const runs = value.replace(UUID_ANYWHERE, '-').match(TOKEN_RUN) ?? [];
  return runs.some((run) => !VOCABULARY.test(run));
}

interface Leaf {
  readonly path: string;
  readonly key: string | null;
  readonly value: unknown;
}

function* walk(value: unknown, path: string, key: string | null): Generator<Leaf> {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* walk(item, `${path}[${index}]`, key);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) yield* walk(item, `${path}.${name}`, name);
    return;
  }
  yield { path, key, value };
}

/** Every key along the way, so a denied name is caught even when its value is an object. */
function* keysOf(value: unknown, path: string): Generator<{ path: string; name: string }> {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* keysOf(item, `${path}[${index}]`);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) {
      yield { path: `${path}.${name}`, name };
      yield* keysOf(item, `${path}.${name}`);
    }
  }
}

function auditRecord(
  record: Record<string, unknown>,
  line: number,
  expectation: LogExpectation,
  allowed: ReadonlySet<string>,
): LogFinding[] {
  const findings: LogFinding[] = [];
  const trace = record[expectation.traceField];
  const message = record['msg'];
  const processLevel =
    trace === undefined &&
    typeof message === 'string' &&
    (expectation.untracedMessagePrefixes ?? []).some((prefix) => message.startsWith(prefix));
  if (!processLevel && (typeof trace !== 'string' || !UUID.test(trace)))
    findings.push({
      kind: 'missing_trace_id',
      line,
      path: `$.${expectation.traceField}`,
      rule: 'uuid',
    });
  if (record['version'] !== expectation.version)
    findings.push({ kind: 'missing_version', line, path: '$.version', rule: 'exact' });

  for (const name of Object.keys(record)) {
    if (!allowed.has(name) && deniedField(name) === null)
      findings.push({ kind: 'unexpected_field', line, path: `$.${name}`, rule: 'allowlist' });
  }
  for (const { path, name } of keysOf(record, '$')) {
    const kind = deniedField(name);
    if (kind !== null) findings.push({ kind, line, path, rule: 'field-name' });
  }
  for (const leaf of walk(record, '$', null)) {
    if (
      typeof leaf.value === 'number' &&
      Number.isFinite(leaf.value) &&
      !Number.isInteger(leaf.value)
    )
      findings.push({ kind: 'coordinate', line, path: leaf.path, rule: 'fractional-number' });
    if (typeof leaf.value !== 'string') continue;
    // The expected release in its own field is the one value the caller vouches for. A
    // git SHA (40 or 64 hex) would otherwise read as a token-like run, and a dotted build
    // number as decimal degrees. Anything else there, or that value anywhere else, is
    // still judged.
    if (leaf.path === '$.version' && leaf.value === expectation.version) continue;
    for (const { kind, rule, pattern } of stringRules)
      if (pattern.test(leaf.value)) findings.push({ kind, line, path: leaf.path, rule });
    // The trace id is a UUID by contract; every other UUID is set aside too, since an
    // identifier is not a credential. What is left must not be a long token-like run.
    if (hasTokenRun(leaf.value))
      findings.push({ kind: 'token', line, path: leaf.path, rule: 'token-like-run' });
  }
  return findings;
}

/**
 * Judge captured log lines. An empty result means every line is clean, traced and
 * versioned, and at least `minRecords` lines were captured.
 */
export function auditLogLines(lines: readonly string[], expectation: LogExpectation): LogFinding[] {
  const allowed = new Set([
    ...operationalLogFields,
    expectation.traceField,
    ...(expectation.allowedFields ?? []),
  ]);
  const probes = (expectation.probes ?? []).filter((probe) => probe.value.length > 0);
  const findings: LogFinding[] = [];
  const minRecords = expectation.minRecords ?? 1;
  if (lines.length < minRecords)
    findings.push({ kind: 'too_few_records', line: 0, path: '$', rule: `at-least-${minRecords}` });
  for (const [index, text] of lines.entries()) {
    const line = index + 1;
    for (const [probeIndex, probe] of probes.entries())
      if (text.includes(probe.value))
        findings.push({ kind: probe.kind, line, path: '$', rule: `probe-${probeIndex}` });
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      findings.push({ kind: 'unparseable', line, path: '$', rule: 'json' });
      continue;
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      findings.push({ kind: 'unparseable', line, path: '$', rule: 'json-object' });
      continue;
    }
    findings.push(...auditRecord(record as Record<string, unknown>, line, expectation, allowed));
  }
  return findings;
}

/**
 * Probes for positions a test sent or stored: each fractional ordinate as JavaScript prints
 * it. Integral ordinates are skipped — `127` is too common to mean a coordinate — and the
 * pattern and field-name layers still cover them.
 */
export function coordinateProbes(
  positions: readonly (readonly number[])[],
  kind: Extract<LogLeakKind, 'coordinate' | 'waypoint'> = 'coordinate',
): LogProbe[] {
  const values = new Set<string>();
  for (const position of positions)
    for (const ordinate of position)
      if (Number.isFinite(ordinate) && !Number.isInteger(ordinate)) values.add(String(ordinate));
  return [...values].map((value) => ({ kind, value }));
}

/** Probes of one kind for exact values: object keys, tokens, body text. */
export function valueProbes(kind: LogLeakKind, values: readonly string[]): LogProbe[] {
  return values.filter((value) => value.length > 0).map((value) => ({ kind, value }));
}

/** One finding per line, for an assertion message. Values are never included. */
export function formatLogFindings(findings: readonly LogFinding[]): string {
  return findings
    .map((finding) => `line ${finding.line} ${finding.kind} at ${finding.path} (${finding.rule})`)
    .join('\n');
}

export interface LogCapture {
  /** For a pino/Fastify logger's `stream` option. */
  readonly stream: Writable;
  /** For a worker's event callback: one event becomes one JSON line. */
  sink(event: unknown): void;
  /** For raw text such as a child process's stdout or stderr. */
  append(text: string): void;
  /**
   * Every line written so far, in order. A trailing line without its newline is included,
   * so a truncated write is audited (and refused as unparseable) rather than dropped.
   */
  lines(): readonly string[];
}

/** Keep a log stream so it can be audited. Nothing written to it is discarded. */
export function createLogCapture(): LogCapture {
  const complete: string[] = [];
  let pending = '';
  const append = (text: string) => {
    const parts = `${pending}${text}`.split('\n');
    pending = parts.pop() ?? '';
    complete.push(...parts);
  };
  const decoder = new TextDecoder();
  const stream = new Writable({
    write(chunk: unknown, _encoding, callback) {
      append(
        typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true }),
      );
      callback();
    },
  });
  return {
    stream,
    sink: (event) => append(`${JSON.stringify(event)}\n`),
    append,
    lines: () => (pending === '' ? [...complete] : [...complete, pending]),
  };
}

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * pg_dump correspondence (EXT-RESTOREa).
 *
 * An independent channel: `pg_dump --data-only --snapshot=<exported id>` reads the
 * SAME snapshot as the capture transaction. This module parses the plain dump's
 * COPY sections and setval lines and compares relation set, column order, row
 * counts and sequence state with the inventory facts supplied by the caller.
 * It never restores from the dump and grants no authority. Row content equality
 * is not claimed (COPY text and the JSON row packets are different encodings);
 * each COPY section's raw SHA is reported for audit only.
 */
export class FullRestoreDumpCorrespondenceErrorV1 extends Error {
  constructor(
    readonly code:
      | 'DUMP_INPUT_INVALID'
      | 'DUMP_BOUND_EXCEEDED'
      | 'DUMP_SYNTAX_UNSUPPORTED'
      | 'DUMP_EXECUTION_FAILED',
  ) {
    super(code);
    this.name = 'FullRestoreDumpCorrespondenceErrorV1';
  }
}
const fail = (code: FullRestoreDumpCorrespondenceErrorV1['code']): never => {
  throw new FullRestoreDumpCorrespondenceErrorV1(code);
};

export type ParsedDataDumpV1 = Readonly<{
  relations: readonly Readonly<{
    schema: string;
    relation: string;
    columns: readonly string[];
    rowCount: number;
    copySha256: string;
  }>[];
  sequences: readonly Readonly<{
    schema: string;
    relation: string;
    lastValue: string;
    isCalled: boolean;
  }>[];
}>;

/** One identifier as pg_dump's fmtId writes it: bare lowercase or double-quoted. */
function identifiers(text: string): string[] {
  const out: string[] = [];
  const pattern = /\s*(?:"((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*))\s*(,|\.|$)/y;
  let offset = 0;
  let current: string[] = [];
  while (offset < text.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(text);
    if (!match) return fail('DUMP_SYNTAX_UNSUPPORTED');
    current.push(match[1] !== undefined ? match[1].replaceAll('""', '"') : (match[2] ?? ''));
    if (match[3] !== '.') {
      out.push(current.join('.'));
      current = [];
    }
    offset = pattern.lastIndex;
    if (match[3] === '') break;
  }
  if (current.length > 0) fail('DUMP_SYNTAX_UNSUPPORTED');
  return out;
}
function qualified(text: string): { schema: string; relation: string } {
  const pattern =
    /^(?:"((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*))\.(?:"((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*))$/;
  const match = pattern.exec(text);
  if (!match) return fail('DUMP_SYNTAX_UNSUPPORTED');
  return {
    schema: match[1] !== undefined ? match[1].replaceAll('""', '"') : (match[2] ?? ''),
    relation: match[3] !== undefined ? match[3].replaceAll('""', '"') : (match[4] ?? ''),
  };
}

export function parsePlainDataDumpV1(
  bytes: Uint8Array,
  limits: Readonly<{ maxBytes: number; maxRelations: number }>,
): ParsedDataDumpV1 {
  if (!(bytes instanceof Uint8Array)) fail('DUMP_INPUT_INVALID');
  if (bytes.byteLength > limits.maxBytes) fail('DUMP_BOUND_EXCEEDED');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail('DUMP_INPUT_INVALID');
  }
  const lines = text.split('\n');
  const relations: {
    schema: string;
    relation: string;
    columns: string[];
    rowCount: number;
    copySha256: string;
  }[] = [];
  const sequences: { schema: string; relation: string; lastValue: string; isCalled: boolean }[] =
    [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const copy = /^COPY (\S+(?:\.\S+)?) \((.*)\) FROM stdin;$/.exec(line);
    if (copy) {
      const target = qualified(copy[1] ?? '');
      const key = `${target.schema}.${target.relation}`;
      if (seen.has(key)) fail('DUMP_SYNTAX_UNSUPPORTED');
      seen.add(key);
      if (seen.size > limits.maxRelations) fail('DUMP_BOUND_EXCEEDED');
      const hash = createHash('sha256');
      let rowCount = 0;
      for (i++; ; i++) {
        if (i >= lines.length) fail('DUMP_SYNTAX_UNSUPPORTED');
        const row = lines[i] ?? '';
        if (row === '\\.') break;
        hash.update(row).update('\n');
        rowCount++;
      }
      relations.push({
        ...target,
        columns: identifiers(copy[2] ?? ''),
        rowCount,
        copySha256: hash.digest('hex'),
      });
      continue;
    }
    if (line.startsWith('COPY ')) fail('DUMP_SYNTAX_UNSUPPORTED');
    const setval =
      /^SELECT pg_catalog\.setval\('((?:[^']|'')+)', (-?[0-9]+), (true|false)\);$/.exec(line);
    if (setval) {
      sequences.push({
        ...qualified((setval[1] ?? '').replaceAll("''", "'")),
        lastValue: setval[2] ?? '',
        isCalled: setval[3] === 'true',
      });
      continue;
    }
    if (/^\s*(INSERT|ALTER TABLE .* DISABLE TRIGGER|CREATE|DROP)\b/i.test(line))
      fail('DUMP_SYNTAX_UNSUPPORTED');
  }
  const order = (
    a: { schema: string; relation: string },
    b: { schema: string; relation: string },
  ) => (`${a.schema}.${a.relation}` < `${b.schema}.${b.relation}` ? -1 : 1);
  return Object.freeze({
    relations: Object.freeze(
      relations.sort(order).map((r) => Object.freeze({ ...r, columns: Object.freeze(r.columns) })),
    ),
    sequences: Object.freeze(sequences.sort(order).map((s) => Object.freeze(s))),
  });
}

export type DumpCorrespondenceExpectationV1 = Readonly<{
  relations: readonly Readonly<{
    schema: string;
    relation: string;
    columns: readonly string[];
    rowCount: number;
  }>[];
  sequences: readonly Readonly<{
    schema: string;
    relation: string;
    lastValue: string;
    isCalled: boolean;
  }>[];
}>;
export type DumpCorrespondenceResultV1 = Readonly<{
  kind: 'full_restore_dump_correspondence_v1';
  corresponds: boolean;
  differences: readonly string[];
  relationCount: number;
  rowContent: 'not_compared';
  authority: 'none';
  admissionAllowed: false;
}>;

export function compareDumpCorrespondenceV1(
  dump: ParsedDataDumpV1,
  expected: DumpCorrespondenceExpectationV1,
): DumpCorrespondenceResultV1 {
  const differences: string[] = [];
  const key = (v: { schema: string; relation: string }) => `${v.schema}.${v.relation}`;
  const actual = new Map(dump.relations.map((r) => [key(r), r]));
  const wanted = new Map(expected.relations.map((r) => [key(r), r]));
  if (wanted.size !== expected.relations.length) differences.push('expected:duplicate');
  for (const [name, want] of wanted) {
    const got = actual.get(name);
    if (!got) differences.push(`${name}:missing`);
    else {
      if (got.columns.join(',') !== want.columns.join(',')) differences.push(`${name}:columns`);
      if (got.rowCount !== want.rowCount) differences.push(`${name}:rowCount`);
    }
  }
  for (const name of actual.keys()) if (!wanted.has(name)) differences.push(`${name}:unexpected`);
  const actualSequences = new Map(dump.sequences.map((s) => [key(s), s]));
  for (const want of expected.sequences) {
    const got = actualSequences.get(key(want));
    if (!got) differences.push(`${key(want)}:sequence_missing`);
    else if (BigInt(got.lastValue) < BigInt(want.lastValue) || got.isCalled !== want.isCalled)
      // The capture floor is read non-transactionally after the snapshot; the dump
      // value may be equal or (with concurrent allocation) different. Below-floor fails.
      differences.push(`${key(want)}:sequence_state`);
  }
  for (const name of actualSequences.keys())
    if (!expected.sequences.some((s) => key(s) === name))
      differences.push(`${name}:sequence_unexpected`);
  return Object.freeze({
    kind: 'full_restore_dump_correspondence_v1',
    corresponds: differences.length === 0,
    differences: Object.freeze(differences.slice(0, 256)),
    relationCount: dump.relations.length,
    rowContent: 'not_compared',
    authority: 'none',
    admissionAllowed: false,
  });
}

/**
 * Runs pg_dump against an exported snapshot. Connection parameters go through
 * the environment (no password argument); the caller's exporting transaction
 * must stay open until this resolves.
 */
export async function runSnapshotDataDumpV1(input: {
  readonly pgDumpPath: string;
  readonly snapshotId: string;
  readonly connection: Readonly<{ host: string; port?: number; user: string; database: string }>;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}): Promise<Uint8Array> {
  if (
    !/^\/[A-Za-z0-9._/@-]+\/pg_dump$/.test(input.pgDumpPath) ||
    !/^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/.test(input.snapshotId)
  )
    fail('DUMP_INPUT_INVALID');
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    PGHOST: input.connection.host,
    PGUSER: input.connection.user,
    PGDATABASE: input.connection.database,
    PGAPPNAME: 'wm-full-restore-dump-correspondence',
  };
  if (input.connection.port !== undefined) env['PGPORT'] = String(input.connection.port);
  const child = spawn(
    input.pgDumpPath,
    [
      '--data-only',
      '--no-owner',
      '--no-privileges',
      '--enable-row-security',
      '--encoding=UTF8',
      `--snapshot=${input.snapshotId}`,
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const chunks: Buffer[] = [];
  let size = 0,
    overflow = false;
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.byteLength;
    if (size > input.maxBytes) {
      overflow = true;
      child.kill('SIGKILL');
    } else chunks.push(chunk);
  });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), input.timeoutMs);
  const code = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('close', resolve);
  });
  clearTimeout(timer);
  if (overflow) fail('DUMP_BOUND_EXCEEDED');
  if (code !== 0) fail('DUMP_EXECUTION_FAILED');
  return new Uint8Array(Buffer.concat(chunks));
}

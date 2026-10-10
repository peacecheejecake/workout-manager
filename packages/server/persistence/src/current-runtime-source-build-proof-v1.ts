import { createHash } from 'node:crypto';
import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { currentRuntimeSourceBuildProofV1AssetSha256 } from './current-runtime-source-build-proof-v1-pin.js';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import {
  currentRuntimeV9RpcSignatures,
  currentRuntimeV9OwnerOnlyPublicHelpers,
  currentRuntimeV9PrivateHelpers,
} from './current-runtime-grants-v9.js';
import {
  currentRuntimeV9ParentMembers,
  currentRuntimeV9ExtensionMembers,
} from './current-runtime-installation-v9.js';

const catalogDigest = '127a416fb0435ed46225efc82db503d33597dcb01e006f15fb5a7ac3b4c170ed';
const expectedDynamic = [
  {
    signature: 'public.observe_manual_review_full_owned_source_bindings_v2(refs jsonb)',
    sourceSha256: '789b41a5e88437b29a39789168904e702de726a0043e6d6290bb5fe776d277bf',
    executeStatements: 1,
    selector: 'kind27',
  },
  {
    signature: 'public.observe_manual_review_multi_owned_source_bindings_v3(refs jsonb)',
    sourceSha256: '8ad144ad00ec7249774ce6c3eb9013dd005c51016f0ce257a4f5079a3537ffdf',
    executeStatements: 1,
    selector: 'kind27',
  },
  {
    signature:
      'public.store_manual_race_multi_owned_chain_v3(evidence_id uuid, decision_id uuid, proposal_id uuid, receipt_key text, request jsonb, payload jsonb, basis jsonb, lifecycle jsonb)',
    sourceSha256: 'cebc600818ea852473d718006ba6f939cf81e7b56c1e7770dbed33f60d7a926b',
    executeStatements: 2,
    selector: 'heads3_dependency7',
  },
  {
    signature:
      'public.store_manual_race_chain_v2(evidence_id uuid, decision_id uuid, proposal_id uuid, receipt_key text, request jsonb, payload jsonb, basis jsonb, lifecycle jsonb)',
    sourceSha256: '0538523f733a77b73733431a2cd0b836c65837c1ac437d0b1bb6fe9f39196598',
    executeStatements: 2,
    selector: 'heads3_dependency7',
  },
  {
    signature:
      'public.store_manual_race_pooled_chain_v1(evidence_id uuid, decision_id uuid, proposal_id uuid, receipt_key text, request jsonb, payload jsonb, basis jsonb, lifecycle jsonb)',
    sourceSha256: 'e21ba72f44e2cdf563d3a8a7b7c9f1c6b0e51877db9ab7be12e13f6bfd6bc4ff',
    executeStatements: 2,
    selector: 'heads3_dependency7',
  },
  {
    signature:
      'public.validate_race_manual_pooled_application_basis_v1(retained jsonb, basis jsonb, lifecycle jsonb)',
    sourceSha256: 'd1b54a97a1c3474d8d5c416dc9bdaeb2337eadac91bcd2830c24e7d0028e83c7',
    executeStatements: 2,
    selector: 'heads3_dependency7',
  },
  {
    signature: 'public.manual_race_v2_parent_edges(refs jsonb)',
    sourceSha256: 'd3b3f04af1f120b8f9be8d460f4f65180ab970e82cfc740f5aee8841c4feb729',
    executeStatements: 2,
    selector: 'kind27',
  },
  {
    signature: 'public.manual_race_v2_source_dto(i jsonb)',
    sourceSha256: 'd4b325d5b65c6828ed52ecdfd578850110aede5811e74442149e4ab74ea19162',
    executeStatements: 2,
    selector: 'kind27',
  },
  {
    signature:
      'public.validate_race_manual_multi_owned_basis_v3(retained jsonb, basis jsonb, lifecycle jsonb)',
    sourceSha256: '37af20b64a540ef98c9246e10fe564b2549523615f060d3d76b756b5a675b339',
    executeStatements: 2,
    selector: 'heads3_dependency7',
  },
  {
    signature: 'public.manual_source_personal_row_exists_v1(i jsonb, refs jsonb)',
    sourceSha256: '53e9705ccab5ccdddb9fe16b3dc06a91e02af0fc5aa3d8b6fd08dc0c8270f5cb',
    executeStatements: 1,
    selector: 'kind27',
  },
  {
    signature: 'public.manual_race_v2_media_fact(v_identity jsonb)',
    sourceSha256: '51aba501327f9769f2a44550e3e81469bc3dd51a9a91a27e118acf7ba88b1763',
    executeStatements: 1,
    selector: 'fixed_media_rpc',
  },
] as const;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      p.split('/').every((part) => part !== '..' && part !== '.' && part.length > 0),
  );
const pinSchema = z.strictObject({
  path: pathSchema,
  sha256: hash,
  role: z.enum(['source', 'sql', 'fixture', 'log', 'metadata', 'dependency']),
});
const caseSchema = z.strictObject({
  runner: z.enum(['vitest', 'playwright']),
  fixture: pathSchema,
  label: z.string().min(1).max(2048),
  log: pathSchema,
  suitePassed: z.number().int().positive().max(10000),
  scope: z.enum(['same_body_suite', 'historical_suite', 'latest_dense', 'latest_http']),
});
const dynamicSchema = z.strictObject({
  signature: z.string().min(1).max(1024),
  sourceSha256: hash,
  executeStatements: z.number().int().min(1).max(2),
  selector: z.enum(['kind27', 'heads3_dependency7', 'fixed_media_rpc']),
});
const manifestSchema = z.strictObject({
  proofVersion: z.literal(1),
  sourceBuildRevision: z.literal(1),
  profileVersion: z.literal(9),
  runtimeStep: z.literal(25),
  sourceDdlTip: z.literal(142),
  catalogDigest: z.literal(catalogDigest),
  files: z.array(pinSchema).min(1).max(1000),
  sourceEntrypoints: z.array(pathSchema).min(1).max(100),
  workspaceImports: z.record(z.string().min(1).max(256), pathSchema),
  roots: z.array(z.string()).length(42),
  helpers: z.array(z.string()).length(17),
  dynamic: z.array(dynamicSchema).length(11),
  cases: z.array(caseSchema).min(1).max(1000),
  limitations: z.tuple([
    z.literal('historical_116_whole_file_not_final_body_execution'),
    z.literal('suite_totals_are_not_individual_branch_traces'),
    z.literal('unavailable_source_modes_are_not_positive_execution'),
  ]),
});
const bounded = createBoundedPlainJsonSchema(8 * 1024 * 1024);
type Manifest = z.infer<typeof manifestSchema>;
// Build recipe only, never a verified asset or processing credential.
export const currentRuntimeSourceBuildProofV1CompilerProfile = Object.freeze({
  roots: currentRuntimeV9RpcSignatures,
  helpers: Object.freeze([
    ...currentRuntimeV9OwnerOnlyPublicHelpers,
    ...currentRuntimeV9PrivateHelpers,
  ]),
  dynamic: Object.freeze(expectedDynamic.map((entry) => Object.freeze({ ...entry }))),
  catalogDigest,
});
export type CurrentRuntimeSourceBuildProofV1 = Readonly<{
  state: 'verified' | 'unavailable';
  reason:
    | 'verified_build_evidence'
    | 'compiled_asset_unavailable'
    | 'asset_invalid'
    | 'source_unavailable'
    | 'source_drift';
  profileVersion: 9;
  runtimeStep: 25;
  sourceDdlTip: 142;
  catalogDigest: typeof catalogDigest;
  sourceManifestSha256: string | null;
  buildProofVersion: 1;
  sourceBuildRevision: 1;
  currentFunctionalExecution: 'not_executed';
  authority: 'none';
  approvalAllowed: false;
  restoreAuthority: 'none';
}>;
export class CurrentRuntimeSourceBuildProofError extends Error {
  constructor(
    readonly code:
      'INVALID_INPUT' | 'SOURCE_UNAVAILABLE' | 'SOURCE_DRIFT' | 'INVALID_EVIDENCE' | 'LIMIT',
  ) {
    super(code);
    this.name = 'CurrentRuntimeSourceBuildProofError';
  }
}
export function parseCurrentRuntimeSourceBuildProofManifestV1(raw: unknown): Manifest {
  try {
    const plain = bounded.safeParse(raw);
    if (!plain.success) throw new CurrentRuntimeSourceBuildProofError('INVALID_INPUT');
    return manifestSchema.parse(plain.data);
  } catch (error) {
    if (error instanceof CurrentRuntimeSourceBuildProofError) throw error;
    throw new CurrentRuntimeSourceBuildProofError('INVALID_INPUT');
  }
}
function read(root: string, relative: string): Buffer {
  const full = resolve(root, relative);
  if (!full.startsWith(root + sep)) throw new CurrentRuntimeSourceBuildProofError('INVALID_INPUT');
  try {
    // Each component is checked: O_NOFOLLOW alone only protects the final component.
    let component = root;
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw Error();
    for (const part of relative.split('/')) {
      component = resolve(component, part);
      if (lstatSync(component).isSymbolicLink()) throw Error();
    }
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > MAX_BYTES)
        throw new CurrentRuntimeSourceBuildProofError('LIMIT');
      const body = readFileSync(fd);
      const after = fstatSync(fd);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        body.length !== before.size
      )
        throw new CurrentRuntimeSourceBuildProofError('SOURCE_DRIFT');
      return body;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof CurrentRuntimeSourceBuildProofError) throw error;
    throw new CurrentRuntimeSourceBuildProofError('SOURCE_UNAVAILABLE');
  }
}
/** Build-only lexer: literals in comments, strings and regexes are not call sites. */
export function enumerateCurrentRuntimeSourceBuildImportsV1(source: string): readonly string[] {
  if (
    typeof source !== 'string' ||
    source.length > MAX_BYTES ||
    Buffer.byteLength(source) > MAX_BYTES
  )
    throw new CurrentRuntimeSourceBuildProofError('LIMIT');
  type Token = {
    kind: 'word' | 'punct' | 'literal';
    value: string;
    plain?: boolean;
  };
  const tokens: Token[] = [];
  let at = 0;
  function quoted(quote: string) {
    at++;
    let value = '',
      plain = true;
    while (at < source.length) {
      const character = source[at++];
      if (character === quote) return { kind: 'literal' as const, value, plain };
      if (character === '\\') {
        plain = false;
        value += character;
        value += source[at++] ?? '';
      } else value += character;
    }
    throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
  }
  function template(depth: number) {
    if (depth > 64) throw new CurrentRuntimeSourceBuildProofError('LIMIT');
    at++;
    while (at < source.length) {
      const character = source[at++];
      if (character === '\\') {
        at++;
        continue;
      }
      if (character === '`') return;
      if (character === '$' && source[at] === '{') {
        at++;
        code(true, depth + 1);
      }
    }
    throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
  }
  function code(interpolation: boolean, depth: number) {
    let braces = 0,
      regexAllowed = true;
    while (at < source.length) {
      const character = source[at];
      if (!character) break;
      if (/\s/.test(character)) {
        at++;
        continue;
      }
      if (source.startsWith('//', at)) {
        const end = source.indexOf('\n', at + 2);
        at = end < 0 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith('/*', at)) {
        const end = source.indexOf('*/', at + 2);
        if (end < 0) throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
        at = end + 2;
        continue;
      }
      if (character === '}' && interpolation && braces === 0) {
        at++;
        return;
      }
      if (character === "'" || character === '"') {
        tokens.push(quoted(character));
        regexAllowed = false;
        continue;
      }
      if (character === '`') {
        tokens.push({ kind: 'punct', value: '`' });
        template(depth);
        regexAllowed = false;
        continue;
      }
      if (character === '/' && regexAllowed) {
        at++;
        let inClass = false,
          ended = false;
        while (at < source.length) {
          const c = source[at++];
          if (c === '\\') {
            at++;
            continue;
          }
          if (c === '[') inClass = true;
          if (c === ']') inClass = false;
          if (c === '/' && !inClass) {
            ended = true;
            break;
          }
          if (c === '\n') break;
        }
        if (!ended) throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
        while (at < source.length && /[a-z]/i.test(source[at] ?? '')) at++;
        tokens.push({ kind: 'punct', value: 'regex' });
        regexAllowed = false;
        continue;
      }
      if (/[a-z_$]/i.test(character)) {
        const start = at++;
        while (at < source.length && /[a-z0-9_$]/i.test(source[at] ?? '')) at++;
        const value = source.slice(start, at);
        tokens.push({ kind: 'word', value });
        regexAllowed = [
          'return',
          'throw',
          'case',
          'yield',
          'await',
          'typeof',
          'void',
          'delete',
          'in',
          'of',
        ].includes(value);
        continue;
      }
      tokens.push({ kind: 'punct', value: character });
      at++;
      if (character === '{') braces++;
      if (character === '}') braces--;
      regexAllowed = !/[a-z0-9_$)\].}]/i.test(character);
    }
    if (interpolation) throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
  }
  code(false, 0);
  const imports: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i],
      next = tokens[i + 1];
    if (token?.kind !== 'word') continue;
    if (token.value === 'require' && next?.value === '(')
      throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
    if (token.value === 'import' && next?.value === '(') {
      const argument = tokens[i + 2],
        close = tokens[i + 3];
      if (argument?.kind !== 'literal' || !argument.plain || close?.value !== ')')
        throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
      imports.push(argument.value);
      continue;
    }
    if ((token.value === 'import' || token.value === 'from') && next?.kind === 'literal') {
      if (!next.plain) throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
      imports.push(next.value);
    }
  }
  return Object.freeze(imports);
}
function equalOrdered(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
function validate(root: string, manifest: Manifest) {
  if (
    !equalOrdered(manifest.roots, currentRuntimeV9RpcSignatures) ||
    !equalOrdered(manifest.helpers, [
      ...currentRuntimeV9OwnerOnlyPublicHelpers,
      ...currentRuntimeV9PrivateHelpers,
    ])
  )
    throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
  if (
    new Set(manifest.files.map((p) => p.path)).size !== manifest.files.length ||
    new Set(manifest.dynamic.map((p) => p.signature)).size !== 11 ||
    JSON.stringify(manifest.dynamic) !== JSON.stringify(expectedDynamic) ||
    manifest.dynamic.reduce((n, p) => n + p.executeStatements, 0) !== 18 ||
    manifest.dynamic.filter((p) => p.selector === 'kind27').length !== 5 ||
    manifest.dynamic.filter((p) => p.selector === 'heads3_dependency7').length !== 5 ||
    manifest.dynamic.filter((p) => p.selector === 'fixed_media_rpc').length !== 1
  )
    throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
  const files = new Map<string, { body: string; role: z.infer<typeof pinSchema>['role'] }>();
  let total = 0;
  for (const pin of manifest.files) {
    const bytes = read(root, pin.path);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new CurrentRuntimeSourceBuildProofError('LIMIT');
    if (digest(bytes) !== pin.sha256) throw new CurrentRuntimeSourceBuildProofError('SOURCE_DRIFT');
    files.set(pin.path, { body: bytes.toString('utf8'), role: pin.role });
  }
  for (const member of [...currentRuntimeV9ParentMembers, ...currentRuntimeV9ExtensionMembers]) {
    const path = 'packages/server/persistence/migrations/' + member.filename;
    const pin = manifest.files.find((entry) => entry.path === path);
    if (pin?.role !== 'sql' || pin.sha256 !== member.sha256)
      throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
  }
  for (const entrypoint of [
    'packages/server/persistence/src/current-runtime-source-build-proof-v1.ts',
    'packages/server/persistence/src/current-runtime-source-build-proof-v1-compiler.ts',
    'apps/api/src/current-runtime-repositories-registration-v1.ts',
  ]) {
    if (
      !manifest.sourceEntrypoints.includes(entrypoint) ||
      files.get(entrypoint)?.role !== 'source'
    )
      throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
  }
  const excludedGeneratedInputs = new Set([
    'packages/server/persistence/src/current-runtime-source-build-proof-v1-pin.ts',
  ]);
  if (manifest.files.some((file) => excludedGeneratedInputs.has(file.path)))
    throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
  const visited = new Set<string>();
  const queue = [...manifest.sourceEntrypoints];
  while (queue.length) {
    const path = queue.shift();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    const file = files.get(path);
    if (!file || file.role !== 'source')
      throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
    // Static and fixed literal lazy imports share the same exact resolution and source pins.
    for (const specifier of enumerateCurrentRuntimeSourceBuildImportsV1(file.body)) {
      if (specifier.startsWith('node:') || ['zod', 'pg'].includes(specifier)) continue;
      const destination = specifier.startsWith('.')
        ? resolve(root, dirname(path), specifier.replace(/\.js$/, '.ts')).slice(root.length + 1)
        : manifest.workspaceImports[specifier];
      if (!destination || !pathSchema.safeParse(destination).success)
        throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
      if (!excludedGeneratedInputs.has(destination)) queue.push(destination);
    }
  }
  for (const evidence of manifest.cases) {
    const fixture = files.get(evidence.fixture),
      log = files.get(evidence.log);
    const labels = fixture
      ? [
          ...fixture.body.matchAll(
            /(?:^|\n)\s*(?:it(?:\.each\([^;]*?\))?|fixtureIt|test)\s*\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g,
          ),
        ].map((match) => match[2])
      : [];
    if (fixture?.role !== 'fixture' || log?.role !== 'log' || !labels.includes(evidence.label))
      throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
    // Suite totals attest that pinned invocation only. A label in code is not a branch trace.
    const header =
      evidence.runner === 'vitest'
        ? /(?:^|\n)\s*RUN\s+v[0-9]/
        : /(?:^|\n)Running \d+ tests using \d+ workers?/;
    const totalsPattern =
      evidence.runner === 'vitest'
        ? /^[ \t]*Tests[ \t]+(\d+) passed(?:[ \t]+\|[ \t]+0 (?:failed|skipped))*[ \t]+\((\d+)\)[ \t]*\r?$/gm
        : /^[ \t]*(\d+) passed \([0-9]+(?:\.[0-9]+)?(?:ms|s|m|h)\)[ \t]*\r?$/gm;
    const summaries = [...log.body.matchAll(totalsPattern)];
    const totals = summaries.map((match) => Number(match[1]));
    const allPassed =
      evidence.runner !== 'vitest' || summaries.every((match) => match[1] === match[2]);
    const failures = [
      ...log.body.matchAll(/(?:^|\n)\s*(?:Tests\s+)?(\d+) (?:failed|skipped)/g),
    ].some((match) => Number(match[1]) > 0);
    if (
      !header.test(log.body) ||
      totals.length !== 1 ||
      totals[0] !== evidence.suitePassed ||
      !allPassed ||
      failures ||
      /(?:^|\n)\s*Tests[^\n]*[1-9]\d* (?:failed|skipped)/.test(log.body)
    )
      throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
  }
  return digest(JSON.stringify(manifest));
}
/** Build-only configured boundary. The independently pinned manifest is not an HTTP request.
 * Closure covers declared entrypoints and supported literal imports. A pinned configured.ts
 * member does not establish its complete external package AST or functional execution. */
export function compileCurrentRuntimeSourceBuildProofV1(
  root: string,
  manifestPath: string,
  expectedManifestSha256: string,
) {
  if (
    typeof root !== 'string' ||
    root.length > 4096 ||
    !root.startsWith('/') ||
    !pathSchema.safeParse(manifestPath).success ||
    !hash.safeParse(expectedManifestSha256).success
  )
    throw new CurrentRuntimeSourceBuildProofError('INVALID_INPUT');
  const bytes = read(resolve(root), manifestPath);
  if (digest(bytes) !== expectedManifestSha256)
    throw new CurrentRuntimeSourceBuildProofError('SOURCE_DRIFT');
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new CurrentRuntimeSourceBuildProofError('INVALID_INPUT');
  }
  const manifest = parseCurrentRuntimeSourceBuildProofManifestV1(raw);
  const sourceManifestSha256 = validate(resolve(root), manifest);
  return Object.freeze({
    assetVersion: 1 as const,
    buildProofVersion: 1 as const,
    sourceBuildRevision: 1 as const,
    currentFunctionalExecution: 'not_executed' as const,
    sourceManifestSha256,
    manifestFileSha256: expectedManifestSha256,
    manifestPath,
    profileVersion: 9 as const,
    runtimeStep: 25 as const,
    sourceDdlTip: 142 as const,
    catalogDigest,
    compilerAlgorithm: 'source-bound-evidence-build-v1-static-imports-v1' as const,
    sourceFiles: Object.freeze(
      manifest.files
        .filter((file) => ['source', 'sql', 'dependency'].includes(file.role))
        .map((file) => Object.freeze({ ...file })),
    ),
    evidenceScopes: Object.freeze(manifest.cases.map((entry) => Object.freeze({ ...entry }))),
    authority: 'none' as const,
    approvalAllowed: false as const,
    restoreAuthority: 'none' as const,
  });
}
// Only the independently Root-pinned asset module is cut from import traversal.
// The algorithm source itself remains part of the compiled source manifest.
export function verifyCurrentRuntimeSourceBuildProofV1(): CurrentRuntimeSourceBuildProofV1 {
  const base = {
    profileVersion: 9 as const,
    runtimeStep: 25 as const,
    sourceDdlTip: 142 as const,
    catalogDigest,
    buildProofVersion: 1 as const,
    sourceBuildRevision: 1 as const,
    currentFunctionalExecution: 'not_executed' as const,
    authority: 'none' as const,
    approvalAllowed: false as const,
    restoreAuthority: 'none' as const,
  } as const;
  if (currentRuntimeSourceBuildProofV1AssetSha256 === null)
    return Object.freeze({
      ...base,
      state: 'unavailable',
      reason: 'compiled_asset_unavailable',
      sourceManifestSha256: null,
    });
  // The compile-time asset pin is integrated by Root; source files must accompany deployment.
  return verifyPinnedBuild(base, currentRuntimeSourceBuildProofV1AssetSha256);
}
function verifyPinnedBuild(
  base: Pick<
    CurrentRuntimeSourceBuildProofV1,
    | 'profileVersion'
    | 'runtimeStep'
    | 'sourceDdlTip'
    | 'catalogDigest'
    | 'buildProofVersion'
    | 'sourceBuildRevision'
    | 'currentFunctionalExecution'
    | 'authority'
    | 'approvalAllowed'
    | 'restoreAuthority'
  >,
  assetSha256: string,
): CurrentRuntimeSourceBuildProofV1 {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const asset = read(
      root,
      'packages/server/persistence/src/current-runtime-source-build-proof-v1.asset.json',
    );
    if (digest(asset) !== assetSha256)
      throw new CurrentRuntimeSourceBuildProofError('SOURCE_DRIFT');
    let raw: unknown;
    try {
      raw = JSON.parse(asset.toString('utf8'));
    } catch {
      throw new CurrentRuntimeSourceBuildProofError('INVALID_INPUT');
    }
    const compiled = parseCurrentRuntimeSourceBuildProofAssetV1(raw);
    if (new Set(compiled.sourceFiles.map((file) => file.path)).size !== compiled.sourceFiles.length)
      throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
    let total = 0;
    for (const file of compiled.sourceFiles) {
      if (!['source', 'sql', 'dependency'].includes(file.role))
        throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
      const bytes = read(root, file.path);
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES) throw new CurrentRuntimeSourceBuildProofError('LIMIT');
      if (digest(bytes) !== file.sha256)
        throw new CurrentRuntimeSourceBuildProofError('SOURCE_DRIFT');
    }
    // Root's pinned compiled asset carries build-time evidence. Deployment needs
    // exact source files, not the historical test runner or operational log files.
    return Object.freeze({
      ...base,
      state: 'verified',
      reason: 'verified_build_evidence',
      sourceManifestSha256: compiled.sourceManifestSha256,
    });
  } catch (error) {
    const reason =
      error instanceof CurrentRuntimeSourceBuildProofError && error.code === 'SOURCE_DRIFT'
        ? 'source_drift'
        : error instanceof CurrentRuntimeSourceBuildProofError &&
            error.code === 'SOURCE_UNAVAILABLE'
          ? 'source_unavailable'
          : 'asset_invalid';
    return Object.freeze({
      ...base,
      state: 'unavailable',
      reason,
      sourceManifestSha256: null,
    });
  }
}

const assetSchema = z.strictObject({
  assetVersion: z.literal(1),
  buildProofVersion: z.literal(1),
  sourceBuildRevision: z.literal(1),
  currentFunctionalExecution: z.literal('not_executed'),
  sourceManifestSha256: hash,
  manifestFileSha256: hash,
  manifestPath: pathSchema,
  profileVersion: z.literal(9),
  runtimeStep: z.literal(25),
  sourceDdlTip: z.literal(142),
  catalogDigest: z.literal(catalogDigest),
  compilerAlgorithm: z.literal('source-bound-evidence-build-v1-static-imports-v1'),
  sourceFiles: z.array(pinSchema).min(1).max(1000),
  evidenceScopes: z.array(caseSchema).min(1).max(1000),
  authority: z.literal('none'),
  approvalAllowed: z.literal(false),
  restoreAuthority: z.literal('none'),
});

/** Structural validation only; it cannot mint a registered or verified proof. */
export function parseCurrentRuntimeSourceBuildProofAssetV1(raw: unknown) {
  try {
    const plain = bounded.safeParse(raw);
    if (!plain.success) throw new CurrentRuntimeSourceBuildProofError('INVALID_INPUT');
    const asset = assetSchema.parse(plain.data);
    for (const required of [
      'packages/server/persistence/src/current-runtime-source-build-proof-v1.ts',
      'packages/server/persistence/src/current-runtime-source-build-proof-v1-compiler.ts',
      'apps/api/src/current-runtime-repositories-registration-v1.ts',
    ]) {
      if (!asset.sourceFiles.some((file) => file.path === required && file.role === 'source'))
        throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
    }
    if (
      asset.sourceFiles.some(
        (file) =>
          file.path ===
          'packages/server/persistence/src/current-runtime-source-build-proof-v1-pin.ts',
      ) ||
      new Set(asset.sourceFiles.map((file) => file.path)).size !== asset.sourceFiles.length
    )
      throw new CurrentRuntimeSourceBuildProofError('INVALID_EVIDENCE');
    return asset;
  } catch (error) {
    if (error instanceof CurrentRuntimeSourceBuildProofError) throw error;
    throw new CurrentRuntimeSourceBuildProofError('INVALID_INPUT');
  }
}

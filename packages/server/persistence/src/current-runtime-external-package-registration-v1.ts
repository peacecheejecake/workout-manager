import { createHash } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { types, TextDecoder } from 'node:util';
import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      ![...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) &&
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value.split('/').every((part) => part !== '.' && part !== '..' && part.length > 0),
  );
const name = z
  .string()
  .regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/)
  .max(256);
const id = z.string().min(1).max(512);
const roots = ['fastify', 'jose', 'openid-client', 'pg', 'zod'] as const;
const file = z.strictObject({
  path,
  byteSize: z.number().int().min(0).max(16777216),
  sha256: hash,
});
const edge = z.strictObject({ name, range: z.string().min(1).max(256), targetPackageId: id });
const resolution = z.strictObject({
  issuerPackageId: id.nullable(),
  specifier: z.string().min(1).max(512),
  mode: z.enum(['import', 'require']),
  targetPackageId: id,
  targetPath: path,
  selection: z.enum(['exports', 'main', 'relative', 'imports']),
  selectedKeys: z.array(z.string().min(1).max(256)).max(16),
  issuerPath: path.nullable(),
});
const packageSchema = z.strictObject({
  packageId: id,
  name,
  version: z
    .string()
    .regex(
      /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    )
    .max(128),
  root: path,
  packageJsonSha256: hash,
  fileIndexSha256: hash,
  exportsSha256: hash.nullable(),
  importsSha256: hash.nullable(),
  files: z.array(file).min(1).max(10000),
  dependencies: z.array(edge).max(1000),
  optionalDependencies: z.array(edge).max(1000),
  peers: z.array(edge).max(1000),
  lockIntegrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
});
const conditions = z.strictObject({
  import: z.tuple([z.literal('node'), z.literal('import'), z.literal('default')]),
  require: z.tuple([z.literal('node'), z.literal('require'), z.literal('default')]),
});
const registrationSchema = z.strictObject({
  registrationVersion: z.literal(1),
  nodeVersion: z.literal('24.12.0'),
  conditions,
  roots: z.array(z.strictObject({ specifier: z.enum(roots), packageId: id })).length(5),
  packages: z.array(packageSchema).min(5).max(1000),
  resolutions: z.array(resolution).min(10).max(20000),
  observation: z.strictObject({ path, sha256: hash }),
  provenance: z.strictObject({
    source: z.enum(['synthetic_fixture', 'independently_registered_build']),
    sriArchiveVerification: z.literal('not_executed'),
    astDynamicSemantics: z.literal('not_verified'),
  }),
});
const observationSchema = z.strictObject({
  observationVersion: z.literal(1),
  nodeVersion: z.literal('24.12.0'),
  conditions,
  resolutions: z.array(resolution).min(10).max(20000),
});
export type CurrentRuntimeExternalPackageRegistrationV1 = z.infer<typeof registrationSchema>;
export class CurrentRuntimeExternalPackageRegistrationV1Error extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'INVALID_REGISTRATION'
      | 'SOURCE_UNAVAILABLE'
      | 'SOURCE_DRIFT'
      | 'RESOLUTION_MISMATCH'
      | 'LIMIT',
  ) {
    super(code);
  }
}
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function fail(code: CurrentRuntimeExternalPackageRegistrationV1Error['code']): never {
  throw new CurrentRuntimeExternalPackageRegistrationV1Error(code);
}
function plain(raw: unknown) {
  let visits = 0;
  const active = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (++visits > 262144 || depth > 64) fail('LIMIT');
    if (!value || typeof value !== 'object') return;
    if (types.isProxy(value) || active.has(value)) fail('INVALID_INPUT');
    active.add(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      Array.isArray(value)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      fail('INVALID_INPUT');
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
      visit(descriptor.value, depth + 1);
    }
    active.delete(value);
  }
  visit(raw, 0);
  const checked = createBoundedPlainJsonSchema(8388608).safeParse(raw);
  if (!checked.success) fail('INVALID_INPUT');
  return checked.data;
}
/** Structural data only. Parsing never registers a trusted asset or grants admission. */
export function parseCurrentRuntimeExternalPackageRegistrationV1(
  raw: unknown,
): CurrentRuntimeExternalPackageRegistrationV1 {
  try {
    return registrationSchema.parse(plain(raw));
  } catch (error) {
    if (error instanceof CurrentRuntimeExternalPackageRegistrationV1Error) throw error;
    fail('INVALID_INPUT');
  }
}
function read(root: string, member: string): Buffer {
  if (!path.safeParse(member).success) fail('INVALID_INPUT');
  try {
    let cursor = root;
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
      fail('SOURCE_UNAVAILABLE');
    for (const part of member.split('/')) {
      cursor = join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) fail('SOURCE_UNAVAILABLE');
    }
    const fd = openSync(cursor, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > 16777216) fail('LIMIT');
      const bytes = readFileSync(fd),
        after = fstatSync(fd);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        bytes.length !== before.size
      )
        fail('SOURCE_DRIFT');
      return bytes;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof CurrentRuntimeExternalPackageRegistrationV1Error) throw error;
    fail('SOURCE_UNAVAILABLE');
  }
}
function json(bytes: Buffer): unknown {
  try {
    return plain(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error instanceof CurrentRuntimeExternalPackageRegistrationV1Error) throw error;
    fail('INVALID_INPUT');
  }
}
const metadataSchema = z.object({
  name,
  version: z.string(),
  exports: z.unknown().optional(),
  imports: z.unknown().optional(),
  main: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});
type Metadata = z.infer<typeof metadataSchema>;
function canonicalFiles(files: z.infer<typeof file>[]) {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function key(row: z.infer<typeof resolution>) {
  return JSON.stringify([row.issuerPackageId, row.issuerPath, row.specifier, row.mode]);
}
function sortedResolutions(rows: z.infer<typeof resolution>[]) {
  return [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
function compareEdges(
  declared: Record<string, string> | undefined,
  edges: z.infer<typeof edge>[],
  packages: Map<string, z.infer<typeof packageSchema>>,
) {
  if (new Set(edges.map((e) => e.name)).size !== edges.length) fail('INVALID_REGISTRATION');
  const actual = Object.entries(declared ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const expected = edges
    .map((e): [string, string] => [e.name, e.range])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('INVALID_REGISTRATION');
  for (const e of edges)
    if (packages.get(e.targetPackageId)?.name !== e.name) fail('INVALID_REGISTRATION');
}
function selected(metadata: Metadata, row: z.infer<typeof resolution>): string {
  if (row.selection === 'main') {
    if (
      row.specifier !== metadata.name ||
      row.selectedKeys.length ||
      metadata.exports !== undefined
    )
      fail('RESOLUTION_MISMATCH');
    return metadata.main ?? 'index.js';
  }
  if (row.selection === 'imports') fail('RESOLUTION_MISMATCH'); // Private import aliases need an explicit later registration recipe.
  if (row.specifier !== metadata.name && !row.specifier.startsWith(metadata.name + '/'))
    fail('RESOLUTION_MISMATCH');
  const subpath =
    row.specifier === metadata.name ? '.' : './' + row.specifier.slice(metadata.name.length + 1);
  let value: unknown = metadata.exports;
  let at = 0;
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => key.startsWith('.'))
  ) {
    const chosen = row.selectedKeys[at++];
    if (chosen !== subpath) fail('RESOLUTION_MISMATCH'); // Wildcard substitutions are deliberately not guessed.
    value = Object.getOwnPropertyDescriptor(value, chosen)?.value;
  } else if (subpath !== '.') fail('RESOLUTION_MISMATCH');
  const eligible = ['node', row.mode, 'default'];
  while (value && typeof value === 'object' && !Array.isArray(value)) {
    const chosen = row.selectedKeys[at++];
    const actual = Object.keys(value).find((key) => eligible.includes(key));
    if (!chosen || chosen !== actual) fail('RESOLUTION_MISMATCH');
    value = Object.getOwnPropertyDescriptor(value, chosen)?.value;
  }
  if (at !== row.selectedKeys.length || typeof value !== 'string' || !value.startsWith('./'))
    fail('RESOLUTION_MISMATCH');
  return value.slice(2);
}
/** Build-only verification of independently pinned materialized package records.
 * Resolver observations are independently supplied records, not rerun here.
 * It does not attest AST/dynamic-callsite semantics, SRI archives or admission. */
function verifyIn(
  root: string,
  registrationPath: string,
  independentlyPinnedRegistrationSha256: string,
) {
  if (
    typeof root !== 'string' ||
    !root.startsWith('/') ||
    root.length > 4096 ||
    !hash.safeParse(independentlyPinnedRegistrationSha256).success
  )
    fail('INVALID_INPUT');
  root = resolve(root);
  const registrationBytes = read(root, registrationPath);
  if (digest(registrationBytes) !== independentlyPinnedRegistrationSha256) fail('SOURCE_DRIFT');
  const registration = parseCurrentRuntimeExternalPackageRegistrationV1(json(registrationBytes));
  const packages = new Map(registration.packages.map((p) => [p.packageId, p]));
  if (
    packages.size !== registration.packages.length ||
    new Set(registration.packages.map((p) => p.root)).size !== packages.size
  )
    fail('INVALID_REGISTRATION');
  for (const a of registration.packages)
    for (const b of registration.packages)
      if (a !== b && (a.root.startsWith(b.root + '/') || b.root.startsWith(a.root + '/')))
        fail('INVALID_REGISTRATION');
  if (
    JSON.stringify([...registration.roots.map((r) => r.specifier)].sort()) !==
    JSON.stringify([...roots].sort())
  )
    fail('INVALID_REGISTRATION');
  for (const r of registration.roots)
    if (packages.get(r.packageId)?.name !== r.specifier) fail('INVALID_REGISTRATION');
  const reachable = new Set<string>();
  const queue = registration.roots.map((r) => r.packageId);
  while (queue.length) {
    const next = queue.shift();
    if (next === undefined) fail('INVALID_REGISTRATION');
    if (reachable.has(next)) continue;
    reachable.add(next);
    const p = packages.get(next);
    if (!p) fail('INVALID_REGISTRATION');
    queue.push(
      ...[...p.dependencies, ...p.optionalDependencies, ...p.peers].map((e) => e.targetPackageId),
    );
  }
  if (reachable.size !== packages.size) fail('INVALID_REGISTRATION');
  const metadata = new Map<string, Metadata>();
  let totalBytes = registrationBytes.length;
  const snapshots = new Map<string, string>();
  for (const p of registration.packages) {
    const files = canonicalFiles(p.files);
    if (
      new Set(files.map((f) => f.path)).size !== files.length ||
      digest(JSON.stringify(files)) !== p.fileIndexSha256
    )
      fail('INVALID_REGISTRATION');
    const found: string[] = [];
    let visits = 0;
    function walk(member: string, depth = 0) {
      if (++visits > 20000 || depth > 64) fail('LIMIT');
      for (const entry of readdirSync(join(root, member), { withFileTypes: true })) {
        const child = member + '/' + entry.name;
        if (entry.isSymbolicLink()) fail('SOURCE_UNAVAILABLE');
        if (entry.isDirectory()) walk(child, depth + 1);
        else if (entry.isFile()) {
          found.push(relative(join(root, p.root), join(root, child)));
          if (found.length > 10000) fail('LIMIT');
        } else fail('SOURCE_UNAVAILABLE');
      }
    }
    // The first actual read checks every ancestor before walking the materialized tree.
    const packageBytes = read(root, p.root + '/package.json');
    walk(p.root);
    if (JSON.stringify(found.sort()) !== JSON.stringify(files.map((f) => f.path)))
      fail('INVALID_REGISTRATION');
    for (const f of files) {
      const member = p.root + '/' + f.path,
        b = read(root, member);
      totalBytes += b.length;
      if (totalBytes > 134217728) fail('LIMIT');
      if (b.length !== f.byteSize || digest(b) !== f.sha256) fail('SOURCE_DRIFT');
      snapshots.set(member, f.sha256);
    }
    if (digest(packageBytes) !== p.packageJsonSha256) fail('SOURCE_DRIFT');
    let m: Metadata;
    try {
      m = metadataSchema.parse(json(packageBytes));
    } catch {
      fail('INVALID_REGISTRATION');
    }
    if (
      m.name !== p.name ||
      m.version !== p.version ||
      (m.exports === undefined ? null : digest(JSON.stringify(m.exports))) !== p.exportsSha256 ||
      (m.imports === undefined ? null : digest(JSON.stringify(m.imports))) !== p.importsSha256
    )
      fail('INVALID_REGISTRATION');
    metadata.set(p.packageId, m);
    compareEdges(m.dependencies, p.dependencies, packages);
    compareEdges(m.optionalDependencies, p.optionalDependencies, packages);
    compareEdges(m.peerDependencies, p.peers, packages);
  }
  const observationBytes = read(root, registration.observation.path);
  totalBytes += observationBytes.length;
  if (totalBytes > 134217728) fail('LIMIT');
  if (digest(observationBytes) !== registration.observation.sha256) fail('SOURCE_DRIFT');
  let observation: z.infer<typeof observationSchema>;
  try {
    observation = observationSchema.parse(json(observationBytes));
  } catch {
    fail('INVALID_REGISTRATION');
  }
  if (
    new Set(registration.resolutions.map(key)).size !== registration.resolutions.length ||
    new Set(observation.resolutions.map(key)).size !== observation.resolutions.length ||
    JSON.stringify(sortedResolutions(registration.resolutions)) !==
      JSON.stringify(sortedResolutions(observation.resolutions))
  )
    fail('RESOLUTION_MISMATCH');
  for (const row of registration.resolutions) {
    const target = packages.get(row.targetPackageId),
      issuer = row.issuerPackageId === null ? null : packages.get(row.issuerPackageId);
    if (
      !target ||
      (row.issuerPackageId !== null && !issuer) ||
      !target.files.some((f) => f.path === row.targetPath)
    )
      fail('RESOLUTION_MISMATCH');
    if (issuer) {
      if (!row.issuerPath || !issuer.files.some((f) => f.path === row.issuerPath))
        fail('RESOLUTION_MISMATCH');
      const allowed = [...issuer.dependencies, ...issuer.optionalDependencies, ...issuer.peers];
      if (
        issuer.packageId !== target.packageId &&
        !allowed.some(
          (e) =>
            e.targetPackageId === target.packageId &&
            (row.specifier === e.name || row.specifier.startsWith(e.name + '/')),
        )
      )
        fail('RESOLUTION_MISMATCH');
    } else if (
      row.issuerPath !== null ||
      !registration.roots.some(
        (r) => r.specifier === row.specifier && r.packageId === target.packageId,
      )
    )
      fail('RESOLUTION_MISMATCH');
    if (row.selection === 'relative') {
      if (
        !issuer ||
        issuer.packageId !== target.packageId ||
        row.selectedKeys.length ||
        !row.specifier.startsWith('./') ||
        relative(
          join(root, issuer.root),
          resolve(root, issuer.root, dirname(row.issuerPath ?? ''), row.specifier),
        ) !== row.targetPath
      )
        fail('RESOLUTION_MISMATCH');
    } else {
      const targetMetadata = metadata.get(target.packageId);
      if (!targetMetadata || selected(targetMetadata, row) !== row.targetPath)
        fail('RESOLUTION_MISMATCH');
    }
  }
  for (const r of registration.roots)
    for (const mode of ['import', 'require'] as const)
      if (
        !registration.resolutions.some(
          (v) =>
            v.issuerPackageId === null &&
            v.specifier === r.specifier &&
            v.mode === mode &&
            v.targetPackageId === r.packageId,
        )
      )
        fail('RESOLUTION_MISMATCH');
  for (const p of registration.packages)
    for (const e of [...p.dependencies, ...p.optionalDependencies, ...p.peers])
      for (const mode of ['import', 'require'] as const)
        if (
          !registration.resolutions.some(
            (v) =>
              v.issuerPackageId === p.packageId &&
              v.specifier === e.name &&
              v.mode === mode &&
              v.targetPackageId === e.targetPackageId,
          )
        )
          fail('RESOLUTION_MISMATCH');
  for (const [member, expected] of snapshots)
    if (digest(read(root, member)) !== expected) fail('SOURCE_DRIFT');
  if (
    digest(read(root, registrationPath)) !== independentlyPinnedRegistrationSha256 ||
    digest(read(root, registration.observation.path)) !== registration.observation.sha256
  )
    fail('SOURCE_DRIFT');
  return Object.freeze({
    registrationVersion: 1 as const,
    evidenceKind: 'source_build' as const,
    registrationSha256: independentlyPinnedRegistrationSha256,
    packageCount: packages.size,
    totalBytes,
    resolutionEvidence: 'independently_supplied_record_correspondence' as const,
    provenance: registration.provenance.source,
    sriArchiveVerification: 'not_executed' as const,
    astDynamicSemantics: 'not_verified' as const,
    authority: 'none' as const,
    admissionAllowed: false as const,
  });
}

export function verifyCurrentRuntimeExternalPackageRegistrationV1In(
  root: string,
  registrationPath: string,
  independentlyPinnedRegistrationSha256: string,
) {
  try {
    return verifyIn(root, registrationPath, independentlyPinnedRegistrationSha256);
  } catch (error) {
    if (error instanceof CurrentRuntimeExternalPackageRegistrationV1Error) throw error;
    fail('SOURCE_UNAVAILABLE');
  }
}

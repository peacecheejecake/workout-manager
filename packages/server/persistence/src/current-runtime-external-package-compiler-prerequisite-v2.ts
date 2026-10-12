import { createHash } from 'node:crypto';
import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { TextDecoder, types } from 'node:util';
import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import {
  parseCurrentRuntimeSourceBuildProofManifestV1,
  enumerateCurrentRuntimeSourceBuildImportsV1,
} from './current-runtime-source-build-proof-v1-compiler.js';
import {
  parseCurrentRuntimeExternalPackageRegistrationV2,
  verifyCurrentRuntimeExternalPackageRegistrationV2In,
} from './current-runtime-external-package-registration-v2.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const member = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
      value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'),
  );
const root = z.string().min(1).max(4096).startsWith('/');
const configSchema = z.strictObject({
  sourceRoot: root,
  manifestPath: member,
  independentlyPinnedManifestSha256: hash,
  registrationRoot: root,
  registrationPath: member,
  independentlyPinnedRegistrationSha256: hash,
  workspaceResolverObservationPath: member,
  independentlyPinnedWorkspaceResolverObservationSha256: hash,
});
const conditions = z.strictObject({
  import: z.tuple([z.literal('node'), z.literal('import'), z.literal('default')]),
  require: z.tuple([z.literal('node'), z.literal('require'), z.literal('default')]),
});
const recordSchema = z.strictObject({
  sourcePath: member,
  sourceSha256: hash,
  importOrdinal: z.number().int().min(0).max(100000),
  specifier: z.string().min(1).max(512),
  mode: z.enum(['import', 'require']),
  targetPackageId: z.string().min(1).max(512),
  packageRoot: member,
  targetPath: member,
  targetSha256: hash,
  targetByteSize: z.number().int().min(0).max(16777216),
});
const observationSchema = z.strictObject({
  observationVersion: z.literal(2),
  nodeVersion: z.literal('24.12.0'),
  conditions,
  manifestSha256: hash,
  registrationSha256: hash,
  records: z.array(recordSchema).min(2).max(20000),
});
export type CurrentRuntimeExternalPackageCompilerPrerequisiteV2Config = z.infer<
  typeof configSchema
>;
export type CurrentRuntimeWorkspaceResolverObservationV2 = z.infer<typeof observationSchema>;
export class CurrentRuntimeExternalPackageCompilerPrerequisiteV2Error extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'SOURCE_UNAVAILABLE'
      | 'SOURCE_DRIFT'
      | 'INVALID_EVIDENCE'
      | 'RESOLUTION_MISMATCH'
      | 'LIMIT',
  ) {
    super(code);
    this.name = 'CurrentRuntimeExternalPackageCompilerPrerequisiteV2Error';
  }
}
function fail(code: CurrentRuntimeExternalPackageCompilerPrerequisiteV2Error['code']): never {
  throw new CurrentRuntimeExternalPackageCompilerPrerequisiteV2Error(code);
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function plain(raw: unknown): unknown {
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
  const result = createBoundedPlainJsonSchema(8388608).safeParse(raw);
  if (!result.success) fail('INVALID_INPUT');
  return result.data;
}
export function parseCurrentRuntimeExternalPackageCompilerPrerequisiteV2Config(
  raw: unknown,
): CurrentRuntimeExternalPackageCompilerPrerequisiteV2Config {
  const result = configSchema.safeParse(plain(raw));
  if (!result.success) fail('INVALID_INPUT');
  return result.data;
}
export function parseCurrentRuntimeWorkspaceResolverObservationV2(
  raw: unknown,
): CurrentRuntimeWorkspaceResolverObservationV2 {
  const result = observationSchema.safeParse(plain(raw));
  if (!result.success) fail('INVALID_INPUT');
  return result.data;
}
function read(base: string, path: string): Buffer {
  if (!member.safeParse(path).success) fail('INVALID_INPUT');
  try {
    let cursor = base;
    const baseStat = lstatSync(base);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) fail('SOURCE_UNAVAILABLE');
    for (const part of path.split('/')) {
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
    if (error instanceof CurrentRuntimeExternalPackageCompilerPrerequisiteV2Error) throw error;
    fail('SOURCE_UNAVAILABLE');
  }
}
function text(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('INVALID_INPUT');
  }
}
function json(bytes: Buffer): unknown {
  try {
    return plain(JSON.parse(text(bytes)));
  } catch (error) {
    if (error instanceof CurrentRuntimeExternalPackageCompilerPrerequisiteV2Error) throw error;
    fail('INVALID_INPUT');
  }
}
const excludedGeneratedPin =
  'packages/server/persistence/src/current-runtime-source-build-proof-v1-pin.ts';
/** Build-only cut-1 source/package record correspondence. Independent pins are required.
 * Node observations are supplied records, never synthesized or executed by this compiler.
 * This prerequisite cannot grant runtime admission or certify full package callsite closure. */
export function compileCurrentRuntimeExternalPackageCompilerPrerequisiteV2(raw: unknown) {
  const config = parseCurrentRuntimeExternalPackageCompilerPrerequisiteV2Config(raw);
  const sourceRoot = resolve(config.sourceRoot),
    registrationRoot = resolve(config.registrationRoot);
  const manifestBytes = read(sourceRoot, config.manifestPath);
  const registrationBytes = read(registrationRoot, config.registrationPath);
  const observationBytes = read(sourceRoot, config.workspaceResolverObservationPath);
  if (
    digest(manifestBytes) !== config.independentlyPinnedManifestSha256 ||
    digest(registrationBytes) !== config.independentlyPinnedRegistrationSha256 ||
    digest(observationBytes) !== config.independentlyPinnedWorkspaceResolverObservationSha256
  )
    fail('SOURCE_DRIFT');
  const manifest = parseCurrentRuntimeSourceBuildProofManifestV1(json(manifestBytes));
  const registration = parseCurrentRuntimeExternalPackageRegistrationV2(json(registrationBytes));
  const observation = parseCurrentRuntimeWorkspaceResolverObservationV2(json(observationBytes));
  verifyCurrentRuntimeExternalPackageRegistrationV2In(
    registrationRoot,
    config.registrationPath,
    config.independentlyPinnedRegistrationSha256,
  );
  if (
    observation.manifestSha256 !== config.independentlyPinnedManifestSha256 ||
    observation.registrationSha256 !== config.independentlyPinnedRegistrationSha256
  )
    fail('RESOLUTION_MISMATCH');
  if (registration.roots.some((entry) => Object.hasOwn(manifest.workspaceImports, entry.specifier)))
    fail('INVALID_EVIDENCE');
  const sources = new Map<string, { sha256: string; body: string; role: string }>();
  let sourceBytes = 0;
  for (const pin of manifest.files) {
    if (sources.has(pin.path) || pin.path === excludedGeneratedPin) fail('INVALID_EVIDENCE');
    const bytes = read(sourceRoot, pin.path);
    sourceBytes += bytes.length;
    if (sourceBytes > 134217728) fail('LIMIT');
    if (digest(bytes) !== pin.sha256) fail('SOURCE_DRIFT');
    sources.set(pin.path, { sha256: pin.sha256, body: text(bytes), role: pin.role });
  }
  const recordKey = (row: z.infer<typeof recordSchema>) =>
    JSON.stringify([row.sourcePath, row.importOrdinal, row.mode]);
  const records = new Map(observation.records.map((row) => [recordKey(row), row]));
  if (records.size !== observation.records.length) fail('RESOLUTION_MISMATCH');
  const queue = [...manifest.sourceEntrypoints],
    visited = new Set<string>(),
    consumed = new Set<string>();
  let externalImportSites = 0;
  while (queue.length) {
    const path = queue.shift();
    if (!path || visited.has(path)) continue;
    if (visited.size >= 1000) fail('LIMIT');
    visited.add(path);
    const source = sources.get(path);
    if (!source || source.role !== 'source') fail('INVALID_EVIDENCE');
    const imports = enumerateCurrentRuntimeSourceBuildImportsV1(source.body);
    for (const [importOrdinal, specifier] of imports.entries()) {
      if (specifier.startsWith('node:')) {
        if (!isBuiltin(specifier)) fail('INVALID_EVIDENCE');
        continue;
      }
      const destination = specifier.startsWith('.')
        ? relative(
            sourceRoot,
            resolve(sourceRoot, dirname(path), specifier.replace(/\.js$/, '.ts')),
          )
        : manifest.workspaceImports[specifier];
      if (destination !== undefined) {
        if (!member.safeParse(destination).success) fail('INVALID_EVIDENCE');
        if (destination !== excludedGeneratedPin) queue.push(destination);
        continue;
      }
      externalImportSites++;
      for (const mode of ['import', 'require'] as const) {
        const key = JSON.stringify([path, importOrdinal, mode]),
          row = records.get(key);
        if (!row || row.sourceSha256 !== source.sha256 || row.specifier !== specifier)
          fail('RESOLUTION_MISMATCH');
        const registered = registration.resolutions.find(
          (r) =>
            r.state === 'resolved' &&
            r.issuerPackageId === null &&
            r.issuerPath === null &&
            r.specifier === specifier &&
            r.mode === mode,
        );
        if (
          !registered ||
          registered.state !== 'resolved' ||
          registered.targetPackageId !== row.targetPackageId ||
          registered.targetPath !== row.targetPath
        )
          fail('RESOLUTION_MISMATCH');
        const target = registration.packages.find((p) => p.packageId === row.targetPackageId);
        const file = target?.files.find((f) => f.path === row.targetPath);
        if (
          !target ||
          target.root !== row.packageRoot ||
          !file ||
          file.sha256 !== row.targetSha256 ||
          file.byteSize !== row.targetByteSize
        )
          fail('RESOLUTION_MISMATCH');
        const bytes = read(registrationRoot, target.root + '/' + file.path);
        if (digest(bytes) !== row.targetSha256 || bytes.length !== row.targetByteSize)
          fail('SOURCE_DRIFT');
        consumed.add(key);
      }
    }
  }
  if (externalImportSites === 0 || consumed.size !== records.size) fail('RESOLUTION_MISMATCH');
  for (const [path, source] of sources)
    if (digest(read(sourceRoot, path)) !== source.sha256) fail('SOURCE_DRIFT');
  if (
    digest(read(sourceRoot, config.manifestPath)) !== config.independentlyPinnedManifestSha256 ||
    digest(read(sourceRoot, config.workspaceResolverObservationPath)) !==
      config.independentlyPinnedWorkspaceResolverObservationSha256 ||
    digest(read(registrationRoot, config.registrationPath)) !==
      config.independentlyPinnedRegistrationSha256
  )
    fail('SOURCE_DRIFT');
  return Object.freeze({
    prerequisiteVersion: 2 as const,
    state: 'verified_records' as const,
    manifestSha256: config.independentlyPinnedManifestSha256,
    registrationSha256: config.independentlyPinnedRegistrationSha256,
    workspaceResolverObservationSha256:
      config.independentlyPinnedWorkspaceResolverObservationSha256,
    sourceFileCount: visited.size,
    externalImportSites,
    workspaceResolutionRecords: consumed.size,
    fullTransitiveClosureComplete: false as const,
    resolutionEvidence: 'independently_supplied_record_correspondence' as const,
    astDynamicSemantics: 'not_verified' as const,
    sriArchiveVerification: 'not_executed' as const,
    currentFunctionalExecution: 'not_executed' as const,
    authority: 'none' as const,
    admissionAllowed: false as const,
  });
}

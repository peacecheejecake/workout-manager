// Regenerates the EXT-RESTOREa admission roster (SQL147 literal, roster.json, successor expected
// structure and the TS pins) from:
//   1. the pinned v1 native catalog roster (e13dc970...0619) and its v1 classification,
//   2. src/full-restore-admission-roster-v1/successor-relations.json (reviewed additions),
//   3. the live catalog of a CLEAN database that has the final profile installed (no restore
//      data, no loader namespaces), connected as its plain owner.
// The catalog must contain exactly (1)+(2); any other relation fails. FORCE flags come from the
// catalog and must equal relrowsecurity. Usage (from the repository root):
//   pnpm exec tsx scripts/generate-restore-admission-roster.mts --database-url <owner url> [--check]
// --check writes nothing and exits 1 when any committed byte differs.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import {
  compareRestoreAdmissionRelations,
  deriveRestoreAdmissionRosterClasses,
  restoreAdmissionRosterSha256,
  RESTORE_ADMISSION_LOADER_NAMESPACES,
  type RestoreAdmissionRosterRow,
} from '@workout/server-persistence/full-restore-relation-classification-v2';
import { captureFullRestoreStructureV1 } from '@workout/server-persistence/full-restore-expected-structure-v1';
import { canonicalPg17Json } from '@workout/server-persistence/full-restore-pg17-node-decoder-v1';

const root = new URL('../packages/server/persistence/', import.meta.url);
const paths = {
  v1Roster: new URL('src/full-restore-native-catalog-v2/source-owned-roster.json', root),
  successor: new URL('src/full-restore-admission-roster-v1/successor-relations.json', root),
  roster: new URL('src/full-restore-admission-roster-v1/roster.json', root),
  structure: new URL('src/full-restore-admission-roster-v1/expected-structure.json', root),
  migration: new URL('migrations/147_restore_processing_admission.sql', root),
  pins: new URL('src/full-restore-relation-classification-v2.ts', root),
};
const args = process.argv.slice(2);
const check = args.includes('--check');
const rest = args.filter((a) => a !== '--check');
if (rest.length !== 2 || rest[0] !== '--database-url' || !rest[1])
  throw new Error('usage: --database-url <owner url> [--check]');
const databaseUrl = rest[1];
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => {
  throw new Error(`ROSTER_GENERATION_FAILED: ${message}`);
};

const v1RosterBytes = new Uint8Array(readFileSync(paths.v1Roster));
const successorBytes = new Uint8Array(readFileSync(paths.successor));
const classes = deriveRestoreAdmissionRosterClasses(v1RosterBytes, successorBytes);

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
let catalog: {
  schema: string;
  relation: string;
  relkind: string;
  partition: boolean;
  persistence: string;
  rls: boolean;
  force: boolean;
  owned: boolean;
}[];
let structureText: string;
let installedRosterSha: string | null;
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const role = await client.query(
    `SELECT session_user=current_user AND NOT r.rolsuper AND NOT r.rolbypassrls AS plain,
      pg_get_userbyid(c.relowner)=session_user AS owner
     FROM pg_roles r, pg_class c WHERE r.rolname=session_user AND c.oid='public.restore_processing_admission'::regclass`,
  );
  if (role.rows[0]?.['plain'] !== true || role.rows[0]?.['owner'] !== true)
    fail('connect as the plain owner of public.restore_processing_admission');
  const loader = await client.query(
    'SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])',
    [[...RESTORE_ADMISSION_LOADER_NAMESPACES]],
  );
  if (loader.rows.length > 0) fail('loader namespaces present; use a clean install');
  catalog = (
    await client.query(
      `SELECT s.nspname AS schema,c.relname AS relation,c.relkind::text AS relkind,c.relispartition AS partition,
        c.relpersistence::text AS persistence,c.relrowsecurity AS rls,c.relforcerowsecurity AS force,
        c.relowner=(SELECT relowner FROM pg_class WHERE oid='public.restore_processing_admission'::regclass) AS owned
       FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
       WHERE c.relkind IN ('r','p','f','m') AND s.nspname !~ '^pg_' AND s.nspname<>'information_schema'`,
    )
  ).rows as typeof catalog;
  catalog.sort(compareRestoreAdmissionRelations);
  const installed = await client.query(
    "SELECT CASE WHEN to_regprocedure('public.restore_processing_admission_roster_sha256()') IS NULL THEN NULL ELSE public.restore_processing_admission_roster_sha256() END AS sha",
  );
  installedRosterSha = (installed.rows[0]?.['sha'] as string | null) ?? null;
  const structure = await captureFullRestoreStructureV1(client, classes);
  structureText = canonicalPg17Json(structure);
  await client.query('COMMIT');
} finally {
  client.release();
  await pool.end();
}

const key = (v: { schema: string; relation: string }) => `${v.schema}.${v.relation}`;
const byName = new Map(catalog.map((c) => [key(c), c]));
const extra = catalog.filter((c) => !classes.some((r) => key(r) === key(c))).map(key);
const missing = classes.filter((r) => !byName.has(key(r))).map(key);
if (extra.length || missing.length)
  fail(
    `catalog/classification mismatch extra=${JSON.stringify(extra)} missing=${JSON.stringify(missing)}`,
  );
const rows: RestoreAdmissionRosterRow[] = classes.map((r) => {
  const c = byName.get(key(r));
  if (!c) return fail(`${key(r)} missing`);
  if (c.relkind !== 'r' || c.partition || c.persistence !== 'p' || !c.owned)
    fail(`${key(r)} is not an owned permanent plain table`);
  if (c.rls !== c.force) fail(`${key(r)} rls=${c.rls} force=${c.force}`);
  return { schema: r.schema, relation: r.relation, class: r.class, forceRls: c.force };
});
const rosterSha256 = restoreAdmissionRosterSha256(rows);
const rosterText = `${JSON.stringify(
  {
    schemaVersion: 1,
    kind: 'wm-restore-admission-roster-v1',
    baseRosterSha256: sha(v1RosterBytes),
    successorRelationsSha256: sha(successorBytes),
    rosterSha256,
    relations: rows,
  },
  null,
  2,
)}\n`;
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
const values = rows
  .map(
    (r, i) =>
      `  (${lit(r.schema)},${lit(r.relation)},${lit(r.class)},${r.forceRls})${i + 1 < rows.length ? ',' : ''}`,
  )
  .join('\n');
const begin = '-- BEGIN GENERATED ROSTER (scripts/generate-restore-admission-roster.mts)\n';
const end = '-- END GENERATED ROSTER\n';
const migration = readFileSync(paths.migration, 'utf8');
const a = migration.indexOf(begin),
  b = migration.indexOf(end);
if (a < 0 || b < a || migration.indexOf(begin, a + 1) >= 0) fail('147 roster markers');
const migrationText = `${migration.slice(0, a + begin.length)}${values}\n${migration.slice(b)}`;

const t = {
  relations: rows.length,
  retained: rows.filter((r) => r.class === 'retained').length,
  retainedForced: rows.filter((r) => r.class === 'retained' && r.forceRls).length,
  authenticationReset: rows.filter((r) => r.class === 'authentication_reset').length,
  authenticationResetForced: rows.filter((r) => r.class === 'authentication_reset' && r.forceRls)
    .length,
  targetLocal: rows.filter((r) => r.class === 'target_local').length,
  census: rows.filter((r) => r.class !== 'target_local').length,
  censusForced: rows.filter((r) => r.class !== 'target_local' && r.forceRls).length,
};
const pinBegin = '// BEGIN GENERATED PINS (scripts/generate-restore-admission-roster.mts)\n';
const pinEnd = '// END GENERATED PINS\n';
const pinsSource = readFileSync(paths.pins, 'utf8');
const p = pinsSource.indexOf(pinBegin),
  q = pinsSource.indexOf(pinEnd);
if (p < 0 || q < p) fail('TS pin markers');
const pinBlock = [
  'export const RESTORE_ADMISSION_ROSTER_SHA256 =',
  `  '${rosterSha256}';`,
  'export const FULL_RESTORE_ADMISSION_ROSTER_V1_FILE_SHA256 =',
  `  '${sha(rosterText)}';`,
  'export const FULL_RESTORE_ADMISSION_SUCCESSOR_RELATIONS_V1_FILE_SHA256 =',
  `  '${sha(successorBytes)}';`,
  'export const FULL_RESTORE_EXPECTED_STRUCTURE_V2_SHA256 =',
  `  '${sha(structureText)}';`,
  'export const RESTORE_ADMISSION_ROSTER_TALLIES = Object.freeze({',
  ...Object.entries(t).map(([k, v]) => `  ${k}: ${v},`),
  '});',
  '',
].join('\n');
const pinsText = `${pinsSource.slice(0, p + pinBegin.length)}${pinBlock}${pinsSource.slice(q)}`;

const outputs: [URL, string][] = [
  [paths.roster, rosterText],
  [paths.structure, structureText],
  [paths.migration, migrationText],
  [paths.pins, pinsText],
];
const changed = outputs.filter(([path, text]) => {
  try {
    return readFileSync(path, 'utf8') !== text;
  } catch {
    return true;
  }
});
if (!check) for (const [path, text] of changed) writeFileSync(path, text);
console.log(
  JSON.stringify(
    {
      mode: check ? 'check' : 'write',
      changed: changed.map(([path]) => path.pathname.split('/persistence/')[1]),
      rosterSha256,
      installedRosterSha256: installedRosterSha,
      installedRosterMatches: installedRosterSha === rosterSha256,
      tallies: t,
      sha256: {
        roster: sha(rosterText),
        successorRelations: sha(successorBytes),
        expectedStructure: sha(structureText),
        migration147: sha(migrationText),
      },
    },
    null,
    2,
  ),
);
if (check && changed.length > 0) process.exit(1);

import { Pool, type PoolClient } from 'pg';
import { installCurrentRuntimeV10 } from '../src/current-runtime-installation-v10.js';
import { grantCurrentRuntimeV10Profile } from '../src/current-runtime-grants-v10.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import {
  galleryProfile27MembersV1,
  readGalleryMemberSourceV1,
} from '../src/gallery-profile27-members-v1.js';
import {
  galleryNavigationRuntimeFunctionsV1,
  galleryNavigationRuntimeReadTablesV1,
} from '../src/gallery-navigation-pins-v1.js';
import {
  galleryRenditionApiFunctionsV1,
  galleryRenditionWorkerFunctionsV1,
  type GalleryRenditionRoleKindV1,
} from '../src/gallery-rendition-pins-v1.js';

// Test-only stand-in for the profile27 installer and grants (another lane owns those): the
// committed profile26 parent (V10 + its runtime grants), then the pinned 143/144/145 sources
// applied raw in one owner transaction, then the exact gallery runtime/worker rosters. It
// writes no ledger and is never product composition.

async function ownerTransaction<T>(ownerUrl: string, work: (tx: PoolClient) => Promise<T>) {
  const pool = new Pool({ connectionString: ownerUrl, max: 1, statement_timeout: 60000 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/** Applies 143, 144 and 145 raw (pinned bytes) inside the caller's owner transaction. */
export async function applyGalleryProfile27MembersIn(tx: PoolClient) {
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  for (const member of galleryProfile27MembersV1)
    await tx.query(await readGalleryMemberSourceV1(member));
}

/** Committed profile26 parent (installer V10) with the gallery members applied raw on top. */
export async function installProfile26WithGalleryMembers(ownerUrl: string) {
  const installed = await installCurrentRuntimeV10(ownerUrl);
  await ownerTransaction(ownerUrl, applyGalleryProfile27MembersIn);
  return installed;
}

/** The parent runtime grants a profile26 runtime role holds (app core + V10). */
export async function grantProfile26Runtime(ownerUrl: string, role: string) {
  await grantCurrentRuntimeAppBaselineV2(ownerUrl, role, 'core');
  await grantCurrentRuntimeV10Profile(ownerUrl, role);
}

function quoted(role: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error('INVALID_TEST_ROLE');
  return `"${role}"`;
}

/** Runtime role: SELECT on the four navigation read tables and EXECUTE on the seven RPCs. */
export async function grantGalleryNavigationRuntimeForTest(ownerUrl: string, role: string) {
  await ownerTransaction(ownerUrl, async (tx) => {
    await tx.query(
      `GRANT SELECT ON ${galleryNavigationRuntimeReadTablesV1.map((t) => `public.${t}`).join(',')} TO ${quoted(role)}`,
    );
    for (const signature of galleryNavigationRuntimeFunctionsV1)
      await tx.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${quoted(role)}`);
  });
}

/** API runtime role: the two read RPCs. Worker role: the five worker RPCs. Nothing else. */
export async function grantGalleryRenditionForTest(
  ownerUrl: string,
  kind: GalleryRenditionRoleKindV1,
  role: string,
) {
  const functions =
    kind === 'api' ? galleryRenditionApiFunctionsV1 : galleryRenditionWorkerFunctionsV1;
  await ownerTransaction(ownerUrl, async (tx) => {
    for (const signature of functions)
      await tx.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${quoted(role)}`);
  });
}

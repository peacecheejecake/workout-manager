import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkInTemplateExportDataSchema } from '@workout/contracts/check-in-template-export';
import { raceManualPersonalExportFields } from '@workout/contracts/race-manual-personal-export';
import { planDraftSchema } from '@workout/contracts/planning';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { installCurrentRuntime } from '../src/current-runtime-installation.js';
import { grantCurrentRuntimeProfile } from '../src/current-runtime-grants.js';
import { createCheckInTemplateRepository } from '../src/check-in-templates.js';
import { createConsentRepository } from '../src/repositories.js';
import { createPlanningRepository } from '../src/planning.js';
import { createRaceRepository } from '../src/races.js';
import { createRaceManualPublicRepository } from '../src/race-manual-public.js';
import { createOperationsRepository } from '../src/operations.js';
import {
  mapRaceManualPersonalExportV1,
  readCheckInTemplatePersonalExportV1In,
  readRaceManualPersonalExportV1In,
} from '../src/retained-personal-export.js';
import { raceManualPublicPreviewSourceSchema } from '../src/race-manual-public-preview.js';
import {
  migrate,
  grantCorePlanning,
  grantOperations,
  grantRaces,
  grantRoutineCore,
  grantRecoveryCore,
  grantCheckIns,
  grantCourses,
  grantNutritionCore,
  grantSupplementaryCore,
  grantResources,
  grantResourceRetrieval,
  grantGalleryMedia,
  grantGarminUnofficial,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Explicit SQL128 on installed source17/baseline107, not a registered export36.
// No candidate/health owner seeding. Owner writes only identity-FK scaffolding.
// Root runs this canonical integration fixture with explicit synthetic admin env.
// Missing environment is a setup failure, never a conditional skip.
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
describe('SQL128 retained personal export sources', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const name = `personal_export_${suffix}`,
    ownerRole = `personal_export_owner_${suffix}`,
    runtimeRole = `personal_export_app_${suffix}`;
  const roles: string[] = [];
  let admin: Pool,
    db: Database,
    created = false;
  function url(role: string) {
    const u = new URL(z.string().min(1).parse(adminUrl));
    u.pathname = `/${name}`;
    u.username = role;
    u.password = 'isolated';
    return u.toString();
  }
  beforeAll(async () => {
    admin = new Pool({ connectionString: z.string().min(1).parse(adminUrl) });
    for (const role of [ownerRole, runtimeRole]) {
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      roles.push(role);
    }
    await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
    created = true;
    await migrate(url(ownerRole), 107);
    await installCurrentRuntime(url(ownerRole));
    for (const grant of [
      grantCorePlanning,
      grantOperations,
      grantRaces,
      grantRoutineCore,
      grantRecoveryCore,
      grantCheckIns,
      grantCourses,
      grantNutritionCore,
      grantSupplementaryCore,
      grantResources,
      grantResourceRetrieval,
      grantGalleryMedia,
      grantGarminUnofficial,
    ])
      await grant(url(ownerRole), runtimeRole);
    await grantCurrentRuntimeProfile(url(ownerRole), runtimeRole);
    const owner = new Pool({ connectionString: url(ownerRole) });
    try {
      await owner.query(
        await readFile(
          new URL('../migrations/128_personal_export_retained_runtime.sql', import.meta.url),
          'utf8',
        ),
      );
      for (const fn of [
        'read_check_in_template_personal_export_v1',
        'read_race_manual_personal_export_v1',
      ])
        await owner.query(`GRANT EXECUTE ON FUNCTION public.${fn}(integer) TO "${runtimeRole}"`);
      expect(
        (await owner.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0]?.['v'],
      ).toBe(107);
      expect(
        (await owner.query('SELECT count(*)::int AS n FROM wm_runtime_installation.migration'))
          .rows[0]?.['n'],
      ).toBe(17);
    } finally {
      await owner.end();
    }
    db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
  }, 60000);
  afterAll(async () => {
    await db?.close();
    if (created) await dropIsolatedDatabase(admin, name);
    for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
    await admin?.end();
  });
  async function tenant() {
    const athlete = randomUUID(),
      owner = new Pool({ connectionString: url(ownerRole) });
    try {
      await owner.query(
        "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
        [athlete, athlete],
      );
    } finally {
      await owner.end();
    }
    await createConsentRepository(db).setConsent(athlete, {
      kind: 'app',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    return athlete;
  }
  function snapshot<T>(athlete: string, callback: (tx: Transaction) => Promise<T>) {
    if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
    return db.snapshotTenant(athlete, callback);
  }
  const templateEnvelope = z.strictObject({
    schemaVersion: z.literal(1),
    status: z.literal('ready'),
    data: checkInTemplateExportDataSchema,
  });
  const manualEnvelope = z.strictObject({
    schemaVersion: z.literal(1),
    status: z.literal('ready'),
    sources: z.array(raceManualPublicPreviewSourceSchema).max(1000),
    approvalHistory: raceManualPersonalExportFields.manualRaceApprovalHistory,
    commandResults: raceManualPersonalExportFields.manualRaceCommandResults,
  });
  async function templates(athlete: string, limit = 8388608) {
    return snapshot(athlete, async (tx) =>
      templateEnvelope.parse(
        (
          await tx.query('SELECT public.read_check_in_template_personal_export_v1($1) AS value', [
            limit,
          ])
        ).rows[0]?.['value'],
      ),
    );
  }
  async function manual(athlete: string, limit = 8388608) {
    return snapshot(athlete, async (tx) =>
      manualEnvelope.parse(
        (await tx.query('SELECT public.read_race_manual_personal_export_v1($1) AS value', [limit]))
          .rows[0]?.['value'],
      ),
    );
  }
  function mapped(value: z.infer<typeof manualEnvelope>) {
    return mapRaceManualPersonalExportV1(value);
  }
  const content = {
    definitionVersion: 'checkin-v1',
    source: 'user',
    method: 'self_report',
    title: 'Retained prompts',
    instructions: null,
    fields: ['fatigue', 'note'],
  };
  async function reviewFixture() {
    const athlete = await tenant();
    const draft = planDraftSchema.parse({
      title: 'Export planned',
      timezone: 'UTC',
      periods: ['season', 'wave', 'phase', 'block'].map((level, index, ids) => ({
        id: level,
        parentId: index ? ids[index - 1] : null,
        level,
        title: level,
        startDate: '2026-10-01',
        endDateExclusive: '2026-11-01',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
      sessions: [],
    });
    const plan = await createPlanningRepository(db).save(athlete, {
      source: 'manual',
      confirmed: true,
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      draft,
    });
    const races = createRaceRepository(db);
    const event = await races.createRaceEvent(athlete, {
      idempotencyKey: randomUUID(),
      values: {
        title: 'Export race',
        localDate: '2026-10-06',
        localStartTime: '09:00',
        timezone: 'UTC',
        locationName: null,
        distance: { kind: 'standard', class: '10k' },
        priority: null,
        participation: 'registered',
        officialUrl: null,
        course: null,
        targetSeconds: null,
        planVersionId: plan.id,
      },
    });
    const repo = createRaceManualPublicRepository(db);
    const reviewed = await repo.review(athlete, {
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      intent: {
        expectedEvent: { id: event.id, revision: event.revision },
        newLocalDate: '2026-10-08',
        selection: {
          kind: 'move_period',
          expectedCurrentPlanVersionId: plan.id,
          periodId: 'season',
          newStartDate: '2026-10-03',
          scope: 'descendants_and_sessions',
        },
      },
    });
    if (reviewed.status !== 'reviewed') throw Error('PUBLIC_REVIEW_NOT_READY');
    return { athlete, races, event, repo, reviewed };
  }
  it('exports immutable template versions and exact head after app withdrawal', async () => {
    const athlete = await tenant(),
      repo = createCheckInTemplateRepository(db),
      templateId = randomUUID();
    const first = await repo.save(athlete, {
      idempotencyKey: randomUUID(),
      templateId,
      expectedVersion: 0,
      content,
    });
    const second = await repo.save(athlete, {
      idempotencyKey: randomUUID(),
      templateId,
      expectedVersion: 1,
      content: { ...content, title: 'Retained second' },
    });
    await createConsentRepository(db).setConsent(athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    const value = (await templates(athlete)).data;
    expect(await snapshot(athlete, readCheckInTemplatePersonalExportV1In)).toEqual(value);
    expect(value.checkInTemplateVersions.map((v) => v.record_json)).toEqual([first, second]);
    expect(value.checkInTemplateHeads).toEqual([
      { template_id: templateId, version_id: second.versionId, version: 2 },
    ]);
    expect(value.checkInTemplateVersions[0]?.created_at).toMatch(/\.\d{6}Z$/);
  });
  it('normalizes successful alias keys and matches actual approval history without private fields', async () => {
    const f = await reviewFixture();
    const command = {
      schemaVersion: 1,
      candidateId: f.reviewed.reference.candidateId,
      applicationDigest: f.reviewed.reference.applicationDigest,
      confirmed: true,
      idempotencyKey: randomUUID(),
    };
    const committed = await f.repo.approve(f.athlete, command);
    expect(committed.status).toBe('committed');
    expect(await f.repo.approve(f.athlete, { ...command, idempotencyKey: randomUUID() })).toEqual(
      committed,
    );
    const value = mapped(await manual(f.athlete));
    expect(await snapshot(f.athlete, readRaceManualPersonalExportV1In)).toEqual(value);
    expect(value.manualRaceCommandResults).toHaveLength(2);
    expect(value.manualRaceCommandResults.find((r) => r.operation === 'approve')?.result).toEqual(
      committed,
    );
    expect(value.manualRaceApprovalHistory.map((r) => r.domain)).toEqual(['training']);
    const output = JSON.stringify(value);
    expect(output).not.toContain('basis_json');
    expect(output).not.toContain('request_digest');
    expect(output).not.toContain(command.idempotencyKey);
  });
  it('public source deletion purges preview but preserves original successful review result', async () => {
    const f = await reviewFixture();
    const before = mapped(await manual(f.athlete));
    await f.races.deleteRaceEvent(f.athlete, f.event.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: f.event.revision,
    });
    const after = mapped(await manual(f.athlete));
    expect(await snapshot(f.athlete, readRaceManualPersonalExportV1In)).toEqual(after);
    expect(after.manualRaceReviews).toEqual([
      {
        reference: f.reviewed.reference,
        createdAt: f.reviewed.reference.createdAt,
        bodyState: 'purged',
        preview: null,
      },
    ]);
    expect(after.manualRaceCommandResults).toEqual(before.manualRaceCommandResults);
    await createConsentRepository(db).setConsent(f.athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(mapped(await manual(f.athlete))).toEqual(after);
  });
  it('returns genuine empty tenant sets and never a foreign published review', async () => {
    const f = await reviewFixture(),
      other = await tenant();
    expect(mapped(await manual(other))).toEqual({
      manualRaceReviews: [],
      manualRaceApprovalHistory: [],
      manualRaceCommandResults: [],
    });
    expect((await templates(other)).data).toEqual({
      checkInTemplateVersions: [],
      checkInTemplateHeads: [],
    });
    expect((await manual(f.athlete)).sources).toHaveLength(1);
  });
  it('rejects small/invalid budgets and RC readers without returning partial bodies', async () => {
    const f = await reviewFixture();
    await expect(manual(f.athlete, 1)).rejects.toThrow('PERSONAL_EXPORT_TOO_LARGE');
    await expect(templates(f.athlete, 0)).rejects.toThrow('PERSONAL_EXPORT_INVALID_BOUND');
    await expect(
      db.tenant(f.athlete, (tx) =>
        tx.query('SELECT public.read_race_manual_personal_export_v1(8388608)'),
      ),
    ).rejects.toThrow('PERSONAL_EXPORT_SNAPSHOT_REQUIRED');
    expect((await manual(f.athlete)).sources).toHaveLength(1);
  });
  it('retains narrow definer ACL and denies runtime direct private reads', async () => {
    const owner = new Pool({ connectionString: url(ownerRole) });
    try {
      const rows = (
        await owner.query(
          "SELECT p.prosecdef,pg_get_userbyid(p.proowner) AS owner,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_proc p WHERE p.oid IN ('public.read_check_in_template_personal_export_v1(integer)'::regprocedure,'public.read_race_manual_personal_export_v1(integer)'::regprocedure)",
        )
      ).rows;
      expect(rows).toHaveLength(2);
      for (const row of rows)
        expect(row).toEqual({ prosecdef: true, owner: ownerRole, public_execute: false });
    } finally {
      await owner.end();
    }
    const athlete = await tenant();
    for (const table of [
      'check_in_template_version',
      'race_manual_public_receipt_v1',
      'race_manual_application_history_v1',
    ])
      await expect(
        db.tenant(athlete, (tx) => tx.query(`SELECT * FROM public.${table}`)),
      ).rejects.toMatchObject({ code: '42501' });
  });
  it('holds a coherent export while a cooperating public template writer waits', async () => {
    const athlete = await tenant(),
      templateId = randomUUID();
    const first = await createCheckInTemplateRepository(db).save(athlete, {
      idempotencyKey: randomUUID(),
      templateId,
      expectedVersion: 0,
      content,
    });
    let entered: (() => void) | undefined;
    const writerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writerDb: Database = {
      ...db,
      tenant: (id, callback) =>
        db.tenant(id, (tx) =>
          callback({
            athleteId: tx.athleteId,
            query: async (sql, values) => {
              if (sql.includes('public.save_check_in_template_v1')) entered?.();
              return tx.query(sql, values);
            },
          }),
        ),
    };
    let writer: ReturnType<ReturnType<typeof createCheckInTemplateRepository>['save']> | undefined;
    await snapshot(athlete, async (tx) => {
      const read = async () =>
        templateEnvelope.parse(
          (
            await tx.query(
              'SELECT public.read_check_in_template_personal_export_v1(8388608) AS value',
            )
          ).rows[0]?.['value'],
        );
      const before = await read();
      writer = createCheckInTemplateRepository(writerDb).save(athlete, {
        idempotencyKey: randomUUID(),
        templateId,
        expectedVersion: 1,
        content: { ...content, title: 'After snapshot' },
      });
      await writerEntered;
      expect(await read()).toEqual(before);
      expect(before.data.checkInTemplateVersions.map((v) => v.record_json)).toEqual([first]);
    });
    if (!writer) throw Error('WRITER_NOT_STARTED');
    const second = await writer;
    expect((await templates(athlete)).data.checkInTemplateHeads[0]?.version_id).toBe(
      second.versionId,
    );
  });
  it('rejects export after genuine account erasure', async () => {
    const athlete = await tenant();
    await createCheckInTemplateRepository(db).save(athlete, {
      idempotencyKey: randomUUID(),
      templateId: randomUUID(),
      expectedVersion: 0,
      content,
    });
    await createOperationsRepository(db).eraseAccount(athlete);
    await expect(templates(athlete)).rejects.toThrow('ACCOUNT_ERASED');
    await expect(manual(athlete)).rejects.toThrow('ACCOUNT_ERASED');
  });
});

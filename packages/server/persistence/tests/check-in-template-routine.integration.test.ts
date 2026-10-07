import { createCheckInRepository } from '../src/check-ins.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createCheckInTemplateRepository } from '../src/check-in-templates.js';
import { createConsentRepository } from '../src/repositories.js';
import {
  migrate,
  grantCorePlanning,
  grantOperations,
  grantCheckIns,
  grantRoutineCore,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Normal registry107 + explicit unregistered123; public template/routine/actual producers.
// Only identity FK bootstrap uses synthetic owner SQL. No health/approval owner seeds.
// Copied CheckIn inventory/purge/restore acceptance is outside this fixture.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
describe('normal107 + explicit123 public routine CheckIn linking', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
    name = `checkin_template_routine_${suffix}`,
    ownerRole = `checkin_template_routine_owner_${suffix}`,
    runtimeRole = `checkin_template_routine_app_${suffix}`;
  const admin = new Pool({ connectionString: adminUrl }),
    roles: string[] = [];
  let db: Database,
    created = false;
  function url(role: string) {
    const value = new URL(adminUrl);
    value.pathname = `/${name}`;
    value.username = role;
    value.password = 'isolated';
    return value.toString();
  }
  beforeAll(async () => {
    for (const role of [ownerRole, runtimeRole]) {
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      roles.push(role);
    }
    await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
    created = true;
    await migrate(url(ownerRole), 107);
    const owner = new Pool({ connectionString: url(ownerRole) });
    try {
      await owner.query(
        await readFile(
          new URL('../migrations/123_check_in_template_versions.sql', import.meta.url),
          'utf8',
        ),
      );
      for (const signature of [
        'public.save_check_in_template_v1(jsonb)',
        'public.read_check_in_template_version_v1(uuid,uuid)',
        'public.read_check_in_template_head_v1(uuid)',
        'public.list_check_in_template_heads_v1(integer,integer)',
      ])
        await owner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
      expect(
        (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
          'version'
        ],
      ).toBe(107);
    } finally {
      await owner.end();
    }
    await grantCorePlanning(url(ownerRole), runtimeRole);
    await grantOperations(url(ownerRole), runtimeRole);
    await grantCheckIns(url(ownerRole), runtimeRole);
    await grantRoutineCore(url(ownerRole), runtimeRole);
    db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
  });
  afterAll(async () => {
    await db?.close();
    if (created) await dropIsolatedDatabase(admin, name);
    for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
    await admin.end();
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
    const consent = createConsentRepository(db);
    await consent.setConsent(athlete, {
      kind: 'app',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    return { athlete, consent };
  }
  const templates = () => createCheckInTemplateRepository(db);
  const templateCommand = () => ({
    idempotencyKey: randomUUID(),
    templateId: randomUUID(),
    expectedVersion: 0,
    content: {
      definitionVersion: 'checkin-v1' as const,
      source: 'user' as const,
      method: 'self_report' as const,
      title: 'Synthetic self report',
      instructions: null,
      fields: ['fatigue', 'note'] as ('fatigue' | 'note')[],
    },
  });
  async function saveBlueprint(athlete: string, ref: { id: string; versionId: string }) {
    return createRoutineRepository(db).saveBlueprint(athlete, {
      confirmed: true,
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      blueprint: {
        schemaVersion: 4,
        routineId: randomUUID(),
        versionId: randomUUID(),
        title: 'Report routine',
        intent: 'Explicit user observation',
        status: 'published',
        tags: [],
        estimatedDurationSeconds: null,
        createdAt: new Date().toISOString(),
        steps: [
          {
            id: 'report',
            title: 'Report',
            content: { kind: 'checkin_template', ref },
            timing: { kind: 'ordered', afterStepId: null },
            required: true,
            choiceGroupId: null,
          },
        ],
        choiceGroups: [],
      },
    });
  }
  async function setup(planned = false) {
    const f = await tenant(),
      template = await templates().save(f.athlete, templateCommand());
    const blueprint = (
      await saveBlueprint(f.athlete, { id: template.templateId, versionId: template.versionId })
    ).blueprint;
    const routines = createRoutineRepository(db),
      checkins = createCheckInRepository(db);
    let occurrenceId: string | null = null;
    if (planned) {
      const schedule = {
        schemaVersion: 4 as const,
        id: randomUUID(),
        versionId: randomUUID(),
        blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
        window: {
          startDate: '2026-10-08',
          endDateExclusive: '2026-10-09',
          timezone: 'UTC',
          maxOccurrences: 1,
        },
        rule: { kind: 'dates' as const, dates: ['2026-10-08'], localTime: '07:00' },
        state: 'draft' as const,
      };
      const preview = await routines.previewSchedule(f.athlete, {
        schedule,
        sourcePlanVersionId: null,
      });
      const approved = await routines.approveSchedule(f.athlete, {
        schedule,
        sourcePlanVersionId: null,
        previewDigest: preview.previewDigest,
        idempotencyKey: randomUUID(),
        confirmed: true,
      });
      occurrenceId = approved.occurrences[0]?.id ?? null;
      expect(occurrenceId).not.toBeNull();
    }
    const start = {
      runId: randomUUID(),
      blueprintVersionId: blueprint.versionId,
      occurrenceId,
      idempotencyKey: randomUUID(),
      confirmed: true as const,
    };
    const run = await routines.startRun(f.athlete, start);
    const actual = await checkins.createCheckIn(f.athlete, {
      idempotencyKey: randomUUID(),
      values: {
        observedAt: '2026-10-06T00:00:00Z',
        timezone: 'UTC',
        fatigue: 0,
        discomfort: null,
        bodyLocation: null,
        note: null,
      },
    });
    const observation = await checkins.getCheckIn(f.athlete, actual.id);
    if (!observation) throw Error('PUBLIC_CHECKIN_MISSING');
    const record = {
      runId: run.run.id,
      stepId: 'report',
      state: 'performed' as const,
      actualRefs: [
        { kind: 'checkin' as const, id: actual.id, revisionId: String(actual.revision) },
      ],
      occurredAt: null,
      reason: null,
      expectedRevision: run.run.revision,
      idempotencyKey: randomUUID(),
      confirmed: true as const,
    };
    return {
      ...f,
      template,
      blueprint,
      routines,
      checkins,
      run,
      start,
      actual,
      observation,
      record,
    };
  }
  async function actualCount(athlete: string) {
    return db.tenant(
      athlete,
      async (tx) =>
        (
          await tx.query(
            'SELECT count(*)::int AS count FROM check_in WHERE athlete_id=$1 AND NOT deleted',
            [athlete],
          )
        ).rows[0]?.['count'],
    );
  }
  it.each([false, true])(
    'public template→%s planned run→explicit CheckIn link preserves zero/null and frozen historical template',
    async (planned) => {
      const f = await setup(planned);
      expect(await actualCount(f.athlete)).toBe(1);
      const recorded = await f.routines.recordStep(f.athlete, f.record);
      expect(recorded.run.progress[0]?.actualRefs).toEqual(f.record.actualRefs);
      expect(recorded.run.progress[0]?.occurredAt).toBe(f.observation.recordedAt);
      expect(await actualCount(f.athlete)).toBe(1);
      expect((await f.checkins.getCheckIn(f.athlete, f.actual.id))?.values).toMatchObject({
        fatigue: 0,
        discomfort: null,
        note: null,
      });
      await templates().save(f.athlete, {
        idempotencyKey: randomUUID(),
        templateId: f.template.templateId,
        expectedVersion: 1,
        content: { ...f.template.content, title: 'New head', fields: ['note', 'fatigue'] },
      });
      expect(
        await templates().readExact(f.athlete, f.template.templateId, f.template.versionId),
      ).toEqual(f.template);
      expect(await f.routines.readBlueprintVersion(f.athlete, f.blueprint.versionId)).toEqual(
        f.blueprint,
      );
      expect(await f.routines.readRun(f.athlete, f.run.run.id)).toEqual(recorded);
      const historical = await saveBlueprint(f.athlete, {
        id: f.template.templateId,
        versionId: f.template.versionId,
      });
      expect(historical.blueprint.steps[0]?.content).toEqual(f.blueprint.steps[0]?.content);
      expect(await f.routines.recordStep(f.athlete, f.record)).toEqual(recorded);
      expect(await actualCount(f.athlete)).toBe(1);
    },
  );
  it('rejects foreign and missing exact template tuples without creating a blueprint', async () => {
    const own = await tenant(),
      foreign = await tenant();
    const template = await templates().save(foreign.athlete, templateCommand());
    for (const ref of [
      { id: template.templateId, versionId: template.versionId },
      { id: randomUUID(), versionId: randomUUID() },
    ])
      await expect(saveBlueprint(own.athlete, ref)).rejects.toThrow(
        'CONTENT_REFERENCE_UNAVAILABLE',
      );
    expect((await createRoutineRepository(db).listBlueprints(own.athlete, {})).items).toEqual([]);
  });
  it('explicit123 with a missing exact reader capability fails closed', async () => {
    const f = await tenant(),
      saved = await templates().save(f.athlete, templateCommand());
    const owner = new Pool({ connectionString: url(ownerRole) });
    try {
      await owner.query(
        `REVOKE EXECUTE ON FUNCTION public.read_check_in_template_version_v1(uuid,uuid) FROM "${runtimeRole}"`,
      );
      await expect(
        saveBlueprint(f.athlete, { id: saved.templateId, versionId: saved.versionId }),
      ).rejects.toThrow('CONTENT_REFERENCE_UNAVAILABLE');
    } finally {
      await owner.query(
        `GRANT EXECUTE ON FUNCTION public.read_check_in_template_version_v1(uuid,uuid) TO "${runtimeRole}"`,
      );
      await owner.end();
    }
  });
  it('rejects foreign actual, wrong actual kind and stale numeric revision while preserving the run', async () => {
    const f = await setup(),
      foreign = await setup();
    await expect(
      f.routines.recordStep(f.athlete, {
        ...f.record,
        actualRefs: [
          { kind: 'checkin', id: foreign.actual.id, revisionId: String(foreign.actual.revision) },
        ],
      }),
    ).rejects.toThrow('ACTUAL_NOT_FOUND');
    await expect(
      f.routines.recordStep(f.athlete, {
        ...f.record,
        actualRefs: [
          {
            kind: 'activity',
            id: f.actual.id,
            revisionId: '1',
            detailId: null,
            allocationId: null,
          },
        ],
      }),
    ).rejects.toThrow('ACTUAL_KIND_MISMATCH');
    await f.checkins.updateCheckIn(f.athlete, f.actual.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: f.actual.revision,
      reason: 'Explicit synthetic correction',
      values: { ...f.observation.values, fatigue: 1 },
    });
    await expect(f.routines.recordStep(f.athlete, f.record)).rejects.toThrow('ACTUAL_NOT_FOUND');
    expect(await f.routines.readRun(f.athlete, f.run.run.id)).toEqual(f.run);
    expect(await actualCount(f.athlete)).toBe(1);
  });
  it('genuine public CheckIn deletion prevents linking without resurrecting observations', async () => {
    const f = await setup();
    await f.checkins.deleteCheckIn(f.athlete, f.actual.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: f.actual.revision,
    });
    await expect(f.routines.recordStep(f.athlete, f.record)).rejects.toThrow('ACTUAL_NOT_FOUND');
    expect(await f.checkins.getCheckIn(f.athlete, f.actual.id)).toBeNull();
    expect(await actualCount(f.athlete)).toBe(0);
    expect(await f.routines.readRun(f.athlete, f.run.run.id)).toEqual(f.run);
  });
});

import assert from 'node:assert/strict';
import type { Pool } from 'pg';

// Private owner-maintenance helper for the synthetic restore drill. Contains health text;
// never log this ledger or expose it to the runtime role.
function object(value: unknown, keys: string[]): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
  return Object.fromEntries(Object.entries(value));
}
function revision(value: unknown): number {
  assert.ok(
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483646,
  );
  return value;
}
function instant(value: unknown): string {
  assert.ok(
    typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  );
  return value;
}
function identifier(value: unknown): string {
  assert.ok(
    typeof value === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value),
  );
  return value;
}
export function parseConstraintRestoreLedger(value: unknown, backupOwners: readonly string[]) {
  const ledger = object(value, ['schemaVersion', 'capturedAt', 'subjects']);
  assert.equal(ledger['schemaVersion'], 1);
  const capturedAt = instant(ledger['capturedAt']);
  const values: unknown = ledger['subjects'];
  assert.ok(Array.isArray(values) && values.length <= 1000);
  const subjects = values.map((value: unknown) => {
    const subject = object(value, ['athleteId', 'head', 'rows']);
    const athleteId = identifier(subject['athleteId']);
    const h = subject['head'] === null ? null : object(subject['head'], ['revision', 'updatedAt']);
    const head =
      h === null ? null : { revision: revision(h['revision']), updatedAt: instant(h['updatedAt']) };
    const records: unknown = subject['rows'];
    assert.ok(Array.isArray(records) && records.length <= 10000);
    const rows = records.map((value: unknown) => {
      const row = object(value, ['id', 'revision', 'text', 'confirmedAt', 'updatedAt', 'deleted']);
      assert.ok(typeof row['deleted'] === 'boolean');
      const text: unknown = row['text'];
      assert.ok(
        row['deleted']
          ? text === null
          : typeof text === 'string' &&
              text.trim() === text &&
              text.length > 0 &&
              text.length <= 2000 &&
              !text.includes('\0'),
      );
      return {
        id: identifier(row['id']),
        revision: revision(row['revision']),
        text: text as string | null,
        confirmedAt: instant(row['confirmedAt']),
        updatedAt: instant(row['updatedAt']),
        deleted: row['deleted'],
      };
    });
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
    assert.ok(rows.filter((row) => !row.deleted).length <= 50);
    assert.equal(
      rows.reduce((sum, row) => sum + row.revision, 0),
      head?.revision ?? 0,
    );
    return { athleteId, head, rows };
  });
  assert.equal(new Set(subjects.map((row) => row.athleteId)).size, subjects.length);
  for (const owner of backupOwners) assert.ok(subjects.some((row) => row.athleteId === owner));
  return { schemaVersion: 1 as const, capturedAt, subjects };
}
export type ConstraintRestoreLedger = ReturnType<typeof parseConstraintRestoreLedger>;
export async function captureConstraintRestoreLedger(pool: Pool, backupOwners: readonly string[]) {
  const result = await pool.query<{ ledger: unknown }>(
    `WITH owners AS (
    SELECT unnest($1::text[]) AS athlete_id UNION SELECT athlete_id FROM coaching_constraint_head
    UNION SELECT athlete_id FROM coaching_constraint
  ) SELECT jsonb_build_object('schemaVersion',1,
    'capturedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'subjects',COALESCE((SELECT jsonb_agg(jsonb_build_object('athleteId',o.athlete_id,
      'head',CASE WHEN h.athlete_id IS NULL THEN NULL ELSE jsonb_build_object('revision',h.revision,'updatedAt',to_char(h.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END,
      'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'revision',c.revision,'text',c.text,
       'confirmedAt',to_char(c.confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       'updatedAt',to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'deleted',c.deleted) ORDER BY c.id)
       FROM coaching_constraint c WHERE c.athlete_id=o.athlete_id),'[]'::jsonb)) ORDER BY o.athlete_id)
       FROM owners o LEFT JOIN coaching_constraint_head h USING(athlete_id)),'[]'::jsonb)) AS ledger`,
    [backupOwners],
  );
  return parseConstraintRestoreLedger(result.rows[0]?.ledger, backupOwners);
}
// Caller owns a transaction and must replay the independent erasure ledger first.
export async function restoreConstraintLedger(pool: Pool, ledger: ConstraintRestoreLedger) {
  const before = await captureConstraintRestoreLedger(
    pool,
    ledger.subjects.map((row) => row.athleteId),
  );
  parseConstraintRestoreLedger(
    ledger,
    before.subjects.map((row) => row.athleteId),
  );
  for (const subject of ledger.subjects) {
    await pool.query("SELECT set_config('app.athlete_id',$1,true)", [subject.athleteId]);
    if (
      (await pool.query('SELECT 1 FROM tenant_erasure WHERE athlete_id=$1', [subject.athleteId]))
        .rowCount !== 0
    )
      continue;
    const old = before.subjects.find((row) => row.athleteId === subject.athleteId);
    assert.ok((subject.head?.revision ?? 0) >= (old?.head?.revision ?? 0));
    for (const previous of old?.rows ?? []) {
      const current = subject.rows.find((row) => row.id === previous.id);
      assert.ok(current && current.revision >= previous.revision);
      if (current.revision === previous.revision) assert.deepEqual(current, previous);
      if (previous.deleted) assert.deepEqual(current, previous);
    }
    if (!subject.head) continue;
    await pool.query(
      'INSERT INTO coaching_constraint_head(athlete_id,revision,updated_at) VALUES($1,$2,$3) ON CONFLICT(athlete_id) DO UPDATE SET revision=EXCLUDED.revision,updated_at=EXCLUDED.updated_at',
      [subject.athleteId, subject.head.revision, subject.head.updatedAt],
    );
    // Keep unchanged rows: deleting/reinserting them would falsely purge retained evidence.
    // The owner-only migration guard permits validated revision jumps; runtime still increments by one.
    for (const row of subject.rows) {
      const previous = old?.rows.find((item) => item.id === row.id);
      if (previous?.revision === row.revision) continue;
      const values = [
        subject.athleteId,
        row.id,
        row.revision,
        row.text,
        row.confirmedAt,
        row.updatedAt,
        row.deleted,
      ];
      await pool.query(
        previous
          ? 'UPDATE coaching_constraint SET revision=$3,text=$4,confirmed_at=$5,updated_at=$6,deleted=$7 WHERE athlete_id=$1 AND id=$2'
          : 'INSERT INTO coaching_constraint(athlete_id,id,revision,text,confirmed_at,updated_at,deleted) VALUES($1,$2,$3,$4,$5,$6,$7)',
        values,
      );
    }
  }
}

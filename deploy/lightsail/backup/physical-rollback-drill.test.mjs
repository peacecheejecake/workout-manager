import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('./physical-rollback-drill.sh', import.meta.url));
const script = readFileSync(path, 'utf8');
function section(start, end) {
  const a = script.indexOf(`${start}() {`);
  const b = script.indexOf(`\n${end}() {`, a);
  assert.ok(a >= 0 && b > a, `${start} section missing`);
  return script.slice(a, b);
}
function inOrder(...parts) {
  let at = 0;
  for (const part of parts) {
    at = script.indexOf(part, at);
    assert.notEqual(at, -1, `missing or out of order: ${part}`);
    at += part.length;
  }
}

test('requires installed root-only opt-in and pins snapshot, cluster, and images', () => {
  const result = spawnSync('bash', [path, '--execute'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'PHYSICAL_ROLLBACK_GUARD_FAILED\n');
  assert.match(
    script,
    /realpath -e "\$0"\) == \/srv\/workout-manager\/admin\/physical-rollback-drill\.sh/,
  );
  assert.match(
    script,
    /snapshot=\/srv\/workout-manager\/backups\/cold-postgres\/15eff9a95c86d1ca6f5e237d\/postgres/,
  );
  assert.match(script, /system_id=7690725883185365030/);
  assert.match(
    script,
    /pg_image=sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3/,
  );
  assert.match(
    script,
    /old_image=sha256:902466cf07ac4814f5a2672e2458516aa0fe5a7e4ec682d608f19d2afaee245c/,
  );
  assert.match(
    script,
    /staged_image=sha256:e117f1042c3d7d9eed24ef830f3611260c0738bb5a595234589b1468d4399977/,
  );
  assert.match(script, /exec 3>&2 2>\/dev\/null/);
  inOrder(
    'exec 8<"$lock_root/backup.lock"',
    'flock -n 8',
    'exec 9<"$lock_root/maintenance.lock"',
    'flock -n 9',
  );
});

test('copies into one bind source, migrates to 93, stops, restores in place, restarts exact ID and checks 65', () => {
  inOrder(
    'snapshot_intact || fail',
    'scratch=$(mktemp -d',
    'bind_identity=$(stat',
    'cp -a --reflink=never -- "$snapshot/." "$scratch/pg/"',
    'docker_short network create --internal',
    '--mount "type=bind,src=$scratch/pg,dst=/var/lib/postgresql/data"',
    'schema_is 65 || fail',
    'phase=STAGED_SETUP',
    'schema_is 93',
    'phase=RESTORE',
    'restore_clone || fail',
    'phase=OLD_SETUP',
    'phase=OLD_HEALTH',
  );
  const restore = section('restore_clone', 'remove_container');
  assert.match(restore, /quiesce_setup \|\| return 1[\s\S]*stop_clone/);
  assert.match(restore, /find "\$scratch\/pg" -mindepth 1 -maxdepth 1 -exec rm -rf -- \{\} \+/);
  assert.match(restore, /stat -c '%d:%i' "\$scratch\/pg"\) == "\$bind_identity"/);
  assert.match(restore, /docker_short start "\$db_id"/);
  assert.match(restore, /sync -f "\$scratch\/pg"/);
  assert.match(restore, /wait_db && schema_is 65/);
  assert.doesNotMatch(script, /docker_short (stop|update|rm|start) "\$(app_id|pg_id|graph_id)"/);
});

test('setup success marker cannot hide a nonzero Docker exit', () => {
  const definition = section('setup_complete', 'rotate_clone_roles');
  const prelude = 'docker_long() { echo DATABASE_SETUP_COMPLETE; return "$SETUP_EXIT"; }';
  const execute = (status) =>
    spawnSync('bash', ['-c', `${prelude}\n${definition}\nsetup_complete image`], {
      env: { ...process.env, SETUP_EXIT: String(status) },
    }).status;
  assert.equal(execute(0), 0);
  assert.equal(execute(42), 1);
});

test('tree comparison rejects changed bytes, metadata and file set', () => {
  const temp = mkdtempSync(join(tmpdir(), 'wm-physical-tree-'));
  try {
    const left = join(temp, 'left');
    const right = join(temp, 'right');
    mkdirSync(left);
    writeFileSync(join(left, 'PG_VERSION'), '17\n');
    const definition = section('tree_compare', 'snapshot_intact');
    const compare = () =>
      spawnSync('bash', ['-c', `${definition}\ntree_compare "$1" "$2"`, '_', left, right]).status;
    assert.equal(spawnSync('cp', ['-a', left, right]).status, 0);
    assert.equal(compare(), 0);
    writeFileSync(join(right, 'PG_VERSION'), '18\n');
    assert.equal(compare(), 1);
    rmSync(right, { recursive: true });
    assert.equal(spawnSync('cp', ['-a', left, right]).status, 0);
    chmodSync(join(right, 'PG_VERSION'), 0o600);
    assert.equal(compare(), 1);
    rmSync(join(right, 'PG_VERSION'));
    assert.equal(compare(), 1);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('local restore refills same directory inode and refuses a wrong bind identity', () => {
  const temp = mkdtempSync(join(tmpdir(), 'wm-physical-restore-'));
  try {
    const snapshot = join(temp, 'snapshot');
    const scratch = join(temp, 'scratch');
    mkdirSync(snapshot);
    mkdirSync(scratch, { mode: 0o700 });
    mkdirSync(join(scratch, 'pg'), { mode: 0o700 });
    writeFileSync(join(snapshot, 'PG_VERSION'), '17\n');
    writeFileSync(join(scratch, 'pg', 'PG_VERSION'), '93\n');
    writeFileSync(join(scratch, 'pg', 'new-only'), 'remove me');
    const inode = statSync(join(scratch, 'pg')).ino;
    const definitions = section('restore_clone', 'remove_container').replace(
      '/usr/bin/cp -a --reflink=never',
      'cp -a',
    );
    const run = (identity, writerActive = false) =>
      spawnSync(
        'bash',
        [
          '-c',
          `${definitions}
restore_needed=1; restored=0; db_stopped=1; db_id=clone-id
snapshot="$1"; scratch="$2"; bind_identity="$3"; scratch_identity="$MOCK_SCRATCH_ID"
stat() {
  if [[ $1 == -c && $2 == '%d:%i' && $3 == "$scratch" ]]; then
    printf '%s\n' "$MOCK_SCRATCH_ID"
  elif [[ $1 == -c && $2 == '%d:%i' && $3 == "$scratch/pg" ]]; then
    printf '%s\n' "$MOCK_BIND_ID"
  else
    return 1
  fi
}
clone_identity() { return 0; }
root_directory() { [[ -d $1 && ! -L $1 ]]; }
snapshot_intact() { return 0; }
tree_compare() { return 0; }
control_clean() { return 0; }
sync() { return 0; }
quiesce_setup() { [[ "$WRITER_ACTIVE" != active ]]; }
docker_short() { if [[ $1 == inspect ]]; then echo false; elif [[ $1 == start && $2 == clone-id ]]; then touch "$scratch/started"; else return 1; fi; }
quiet() { "$@" >/dev/null 2>&1; }
wait_db() { return 0; }
schema_is() { [[ $1 == 65 ]]; }
restore_clone`,
          '_',
          snapshot,
          scratch,
          identity,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            WRITER_ACTIVE: writerActive ? 'active' : 'quiet',
            MOCK_SCRATCH_ID: `${statSync(scratch).dev}:${statSync(scratch).ino}`,
            MOCK_BIND_ID: `${statSync(join(scratch, 'pg')).dev}:${inode}`,
          },
        },
      );
    const wrong = run('0:0');
    assert.equal(wrong.status, 1);
    assert.equal(readFileSync(join(scratch, 'pg', 'PG_VERSION'), 'utf8'), '93\n');
    const activeWriter = run(`${statSync(join(scratch, 'pg')).dev}:${inode}`, true);
    assert.equal(activeWriter.status, 1);
    assert.equal(readFileSync(join(scratch, 'pg', 'PG_VERSION'), 'utf8'), '93\n');
    const correct = run(`${statSync(join(scratch, 'pg')).dev}:${inode}`);
    assert.equal(correct.status, 0, correct.stderr);
    assert.equal(statSync(join(scratch, 'pg')).ino, inode);
    assert.equal(readFileSync(join(scratch, 'pg', 'PG_VERSION'), 'utf8'), '17\n');
    assert.throws(() => readFileSync(join(scratch, 'pg', 'new-only')));
    assert.equal(statSync(join(scratch, 'started')).isFile(), true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('failed disposable container removal preserves its private bind source', () => {
  const temp = mkdtempSync(join(tmpdir(), 'wm-physical-cleanup-'));
  try {
    const definition = script.slice(
      script.indexOf('cleanup() {'),
      script.indexOf('\ntrap cleanup EXIT'),
    );
    assert.ok(definition.startsWith('cleanup() {'));
    const result = spawnSync(
      'bash',
      [
        '-c',
        `${definition}
exec 3>&2
scratch="$1"; phase=CLONE; run_id=mock; db=mock-db
app_created=0; setup_created=0; db_created=1; net_created=0
restore_needed=0; restored=0; cleanup_failed=0
remove_container() { cleanup_failed=1; }
cleanup`,
        '_',
        temp,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PHYSICAL_ROLLBACK_SCRATCH_RETAINED=/);
    assert.equal(statSync(temp).isDirectory(), true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

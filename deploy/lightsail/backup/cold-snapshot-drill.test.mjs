import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('./cold-snapshot-drill.sh', import.meta.url));
const script = readFileSync(path, 'utf8');

function appearsInOrder(...parts) {
  let offset = 0;
  for (const part of parts) {
    const at = script.indexOf(part, offset);
    assert.notEqual(at, -1, `missing or out of order: ${part}`);
    offset = at + part.length;
  }
}

test('cannot be run locally or without explicit installed root entry point', () => {
  const result = spawnSync('bash', [path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'COLD_SNAPSHOT_GUARD_FAILED\n');
  assert.match(script, /\$# == 1 && \$1 == --execute && \$EUID == 0/);
  assert.match(script, /realpath -e "\$0"\) == "\$root\/admin\/cold-snapshot-drill\.sh"/);
  assert.match(script, /exec 3>&2 2>\/dev\/null/);
});

test('pins exact physical source, old images, configuration, and two uninterrupted locks', () => {
  assert.match(script, /source_dir=\$root\/data\/postgres/);
  assert.match(script, /system_id=7690725883185365030/);
  assert.match(
    script,
    /pg_image=sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3/,
  );
  assert.match(
    script,
    /app_image=sha256:902466cf07ac4814f5a2672e2458516aa0fe5a7e4ec682d608f19d2afaee245c/,
  );
  appearsInOrder(
    'exec 8<"$lock_root/backup.lock"',
    'flock -n 8',
    'exec 9<"$lock_root/maintenance.lock"',
    'flock -n 9',
  );
  assert.match(
    script,
    /config_intact\(\)[\s\S]*config_identity[\s\S]*config_hash[\s\S]*compose_hash/,
  );
  assert.match(
    script,
    /private_empty && source_mount_only && no_unsafe_entries "\$source_dir" && no_tablespaces && timers_quiet && check_503/,
  );
  assert.match(
    script,
    /\[\[ \$\(docker_short ps --all --no-trunc --quiet \| sort\) == "\$docker_ids_before" \]\]/,
  );
});

test('quiesces and copies only after checker; checks clean control and copies exact metadata and bytes', () => {
  appearsInOrder(
    'update --restart no "$id"',
    'graph_stopped=1',
    'stop --time 30 "$graph_id"',
    'app_stopped=1',
    'stop --time 30 "$app_id"',
    '"$node_bin" "$checker"',
    'pg_stopped=1',
    'stop --time 60 "$pg_id"',
    'control_clean "$source_dir"',
    'root_directory "$snapshot" 700',
    'cp -a --reflink=never -- "$source_dir/." "$snapshot_data/"',
    'tree_compare "$source_dir" "$snapshot_data" sync',
    'control_clean "$snapshot_data"',
  );
  assert.match(script, /Database cluster state: +shut down/);
  assert.match(script, /Database system identifier: +\$system_id/);
  assert.match(script, /stat\.S_ISDIR[\s\S]*stat\.S_ISREG[\s\S]*sha256\(\)/);
  assert.match(script, /st\.st_uid, st\.st_gid,[\s\S]*st\.st_mtime_ns, digest/);
  assert.match(script, /os\.fsync\(f\.fileno\(\)\)/);
  assert.match(script, /os\.fsync\(fd\)/);
  appearsInOrder('sync -f "$snapshot"', 'sync -f "$snapshot_root"', 'sync -f "$root/backups"');
});

test('comparison rejects content, mode, and file-set drift', () => {
  const begin = script.indexOf('tree_compare() {');
  const end = script.indexOf('\noriginal_verified() {', begin);
  assert.ok(begin >= 0 && end > begin);
  const definition = script.slice(begin, end);
  const temp = mkdtempSync(join(tmpdir(), 'wm-cold-test-'));
  try {
    const left = join(temp, 'left');
    const right = join(temp, 'right');
    mkdirSync(left);
    mkdirSync(right);
    writeFileSync(join(left, 'PG_VERSION'), '17\n');
    assert.equal(spawnSync('cp', ['-a', `${left}/.`, `${right}/`]).status, 0);
    const compare = () =>
      spawnSync('bash', ['-c', `${definition}\ntree_compare "$1" "$2" verify`, '_', left, right], {
        timeout: 5000,
      }).status;
    assert.equal(compare(), 0);
    writeFileSync(join(right, 'PG_VERSION'), '18\n');
    assert.equal(compare(), 1);
    assert.equal(spawnSync('cp', ['-a', `${left}/.`, `${right}/`]).status, 0);
    assert.equal(compare(), 0);
    chmodSync(join(right, 'PG_VERSION'), 0o600);
    assert.equal(compare(), 1);
    rmSync(join(right, 'PG_VERSION'));
    assert.equal(compare(), 1);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('accepts the ext4-backed bind source without requiring it to be a mount point', () => {
  const begin = script.indexOf('source_mount_only() {');
  const end = script.indexOf('\nno_symlink_parents() {', begin);
  assert.ok(begin >= 0 && end > begin);
  const definition = script.slice(begin, end);
  const temp = mkdtempSync(join(tmpdir(), 'wm-mount-test-'));
  try {
    const fakeFindmnt = join(temp, 'findmnt');
    writeFileSync(
      fakeFindmnt,
      '#!/bin/sh\ncase "$*" in\n  *FSTYPE*) echo "${FAKE_FSTYPE}";;\n  *"-T "*TARGET*) echo /;;\n  *) printf "%s\\n" "$FAKE_MOUNTS";;\nesac\n',
      { mode: 0o700 },
    );
    const check = (mounts, fstype = 'ext4') =>
      spawnSync(
        'bash',
        ['-c', `${definition}\nsource_dir=/srv/workout-manager/data/postgres\nsource_mount_only`],
        {
          env: {
            ...process.env,
            PATH: `${temp}:${process.env.PATH}`,
            FAKE_MOUNTS: mounts,
            FAKE_FSTYPE: fstype,
          },
        },
      ).status;
    assert.equal(check('/\n/proc\n/sys'), 0);
    assert.equal(check('/\n/srv/workout-manager/data/postgres/nested'), 1);
    assert.equal(check('/\n/proc', 'xfs'), 1);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('clone has an isolated internal network and a second mutable copy, with no published port', () => {
  appearsInOrder(
    'cp -a --reflink=never -- "$snapshot_data/." "$scratch/pg/"',
    'tree_compare "$snapshot_data" "$scratch/pg" sync',
    'network create --internal',
    '--mount "type=bind,src=$scratch/pg,dst=/var/lib/postgresql/data"',
    'ALTER ROLE postgres PASSWORD',
    'clone_setup_created=1',
    'bootstrap-db.mjs',
    'count(*)=65',
    'clone_app_created=1',
    'State.Health.Status',
  );
  assert.doesNotMatch(
    script,
    /docker_short (?:compose|volume create|run[^\n]*--publish|run[^\n]*-p 5432)/,
  );
  assert.doesNotMatch(script, /pg_restore|pg_dump|docker_short logs|docker_long logs/);
});

test('failure cleanup gates original app restart on the verified original DB and then restores policies', () => {
  appearsInOrder(
    'cleanup_container "$clone_app"',
    'cleanup_container "$clone_setup"',
    'cleanup_container "$clone_db"',
    'network rm "$clone_net"',
    'original_verified && identity postgres',
    'docker_short start "$pg_id"',
    'schema_migrations',
    'docker_short start "$app_id"',
    'State.Health.Status',
    'docker_short start "$graph_id"',
    'update --restart unless-stopped',
  );
  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /trap 'phase=INTERRUPTED; exit 1' INT TERM HUP/);
  assert.match(script, /if \(\( !cleanup_failed \)\) && \[\[ \$sql == t \]\]/);
  assert.match(script, /COLD_SNAPSHOT_CLEANUP_FAILED/);
  assert.match(script, /COLD_SNAPSHOT_RETAINED=/);
  assert.doesNotMatch(script, /docker_short (?:start|update)[^\n]*\binfra\b/);
});

test('cleanup preserves a colliding snapshot and clone bind source after failed removal', () => {
  const begin = script.indexOf('cleanup() {');
  const end = script.indexOf('\ntrap cleanup EXIT', begin);
  assert.ok(begin >= 0 && end > begin);
  const cleanup = script.slice(begin, end);
  const temp = mkdtempSync(join(tmpdir(), 'wm-cleanup-test-'));
  const snapshot = join(temp, 'existing-snapshot');
  const scratch = join(temp, 'clone-scratch');
  try {
    mkdirSync(snapshot);
    mkdirSync(scratch);
    writeFileSync(join(snapshot, 'keep'), 'backup');
    writeFileSync(join(scratch, 'keep'), 'clone');
    const base = `snapshot_root=${temp}\nsnapshot=${snapshot}\nsnapshot_complete=0\nsnapshot_created=0\nphase=TEST\npg_stopped=0\napp_stopped=0\ngraph_stopped=0\nclone_app_created=0\nclone_setup_created=0\nclone_net_created=0\npolicies_touched=0\ncleanup_failed=0\n`;
    const collision = spawnSync(
      'bash',
      [
        '-c',
        `${base}scratch=\nclone_db_created=0\ncleanup_container() { :; }\n${cleanup}\ncleanup`,
        '_',
      ],
      { timeout: 5000 },
    );
    assert.equal(collision.status, 0);
    assert.equal(readFileSync(join(snapshot, 'keep'), 'utf8'), 'backup');
    const failedClone = spawnSync(
      'bash',
      [
        '-c',
        `${base}snapshot=\nscratch=${scratch}\nclone_db_created=1\ncleanup_container() { cleanup_failed=1; }\n${cleanup}\ncleanup`,
        '_',
      ],
      { timeout: 5000 },
    );
    assert.equal(failedClone.status, 1);
    assert.equal(readFileSync(join(scratch, 'keep'), 'utf8'), 'clone');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const path = fileURLToPath(new URL('./rollback-rehearsal.sh', import.meta.url));
const script = readFileSync(path, 'utf8');

test('requires an explicit host installation and opt-in', () => {
  const result = spawnSync('bash', [path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'ROLLBACK_REHEARSAL_GUARD_FAILED\n');
  assert.match(script, /\$# == 1 && \$1 == --execute && \$EUID == 0/);
  assert.match(
    script,
    /realpath -e "\$0"\) == \/srv\/workout-manager\/admin\/rollback-rehearsal\.sh/,
  );
});

test('pins the immutable source and exact old images', () => {
  assert.match(
    script,
    /archive=\/srv\/workout-manager\/backups\/pre-migration\/792017f9cac82695fb69e6c8\.dump/,
  );
  assert.match(
    script,
    /archive_sha=04870962d6fbe147d49856ea507885b0735ecf9a08f87d0f8d1e99f67c555517/,
  );
  assert.match(
    script,
    /app_image=sha256:902466cf07ac4814f5a2672e2458516aa0fe5a7e4ec682d608f19d2afaee245c/,
  );
  assert.match(
    script,
    /pg_image=sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3/,
  );
  assert.match(script, /root_directory \/srv\/workout-manager\/backups\/pre-migration 700/);
  assert.match(script, /root_file "\$archive" 600/);
  assert.match(script, /stat -c '%d:%i:%s' "\$archive"/);
  assert.match(script, /sha256sum "\$archive"/);
  assert.match(script, /archive_intact \|\| fail[\s\S]*pg_restore[\s\S]*archive_intact \|\| fail/);
  assert.match(script, /docker_short image inspect -f '\{\{\.Id\}\}' "\$app_image"/);
  assert.match(script, /docker_short image inspect -f '\{\{\.Id\}\}' "\$pg_image"/);
});

test('restores only into an internal disposable clone and proves old app health', () => {
  assert.match(script, /flock -n 8[\s\S]*flock -n 9/);
  assert.match(
    script,
    /network create --internal --label "workout\.rollback-rehearsal=\$run_id" "\$clone_net"/,
  );
  assert.match(
    script,
    /volume create --label "workout\.rollback-rehearsal=\$run_id" "\$clone_volume"/,
  );
  assert.match(script, /--name "\$clone_db" --network "\$clone_net" --network-alias wm-postgres/);
  assert.match(
    script,
    /pg_restore --exit-on-error --no-owner --no-acl[\s\S]*-U workout_owner -d workout < "\$archive"/,
  );
  assert.match(
    script,
    /--name "\$clone_setup" --network "\$clone_net"[\s\S]*node --import tsx \/app\/deploy\/lightsail\/bootstrap-db\.mjs/,
  );
  assert.match(script, /count\(\*\)=65 AND min\(version\)=1 AND max\(version\)=65/);
  assert.match(script, /has_table_privilege\('workout_runtime','public\.consent','SELECT'\)/);
  assert.match(
    script,
    /--name "\$clone_app" --network "\$clone_net"[\s\S]*inspect -f '\{\{\.State\.Health\.Status\}\}' "\$clone_app"/,
  );
  assert.doesNotMatch(
    script,
    /docker compose|docker_short stop|docker_long stop|caddy|--publish|-p 5432|\/srv\/workout-manager\/secrets/,
  );
});

test('cleans all disposable resources and hides command diagnostics', () => {
  assert.match(script, /exec 3>&2 2>\/dev\/null/);
  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /trap 'phase=INTERRUPTED; exit 1' INT TERM HUP/);
  assert.match(
    script,
    /cleanup_container "\$clone_app"[\s\S]*cleanup_container "\$clone_setup"[\s\S]*cleanup_container "\$clone_db"[\s\S]*cleanup_object network "\$clone_net"[\s\S]*cleanup_object volume "\$clone_volume"[\s\S]*rm -rf -- "\$scratch"/,
  );
  assert.match(script, /\$label == "\$expected"[\s\S]*docker_short rm -f "\$name"/);
  assert.match(script, /--signal=TERM --kill-after=30s 35m/);
  assert.doesNotMatch(
    script,
    /docker_short logs|docker_long logs|cat "\$archive"|echo "\$.*password"/,
  );
});

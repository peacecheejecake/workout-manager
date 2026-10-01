import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const path = fileURLToPath(new URL('./pre-migration-drill.sh', import.meta.url));
const script = readFileSync(path, 'utf8');
const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');

test('rejects a non-opt-in invocation before host operations', () => {
  const result = spawnSync('bash', [path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^PRE_MIGRATION_GUARD_FAILED\n$/);
  assert.equal(result.stdout, '');
});

test('rehearsal has pinned and isolated boundaries', () => {
  assert.match(script, /umask 077/);
  assert.match(script, /pg_dump[^\n]* > "\$partial"/);
  assert.match(script, /sync -f "\$partial"[\s\S]*root_file "\$archive" 600/);
  assert.match(script, /staged_image_id=sha256:[a-f0-9]{64}/);
  assert.match(script, /flock -n 8[\s\S]*flock -n 9/);
  assert.match(script, /com\.docker\.compose\.project\.config_files[\s\S]*phase=QUIESCE/);
  assert.match(
    script,
    /stop --time 30 "\$graph_id"[\s\S]*stop --time 30 "\$app_id"[\s\S]*check_fence/,
  );
  assert.match(script, /private_empty[\s\S]*pg_dump --format=custom/);
  assert.match(script, /network create --internal/);
  assert.match(script, /--network "\$clone_net" --network-alias wm-postgres/);
  assert.match(script, /--name "\$clone_setup" --network "\$clone_net"/);
  assert.match(script, /--name "\$clone_app" --network "\$clone_net"/);
  assert.match(script, /pg_restore --exit-on-error --no-owner --no-acl[\s\S]*-U workout_owner/);
  assert.match(script, /check_fence && private_empty[\s\S]*MIGRATE_CLONE/);
  assert.match(script, /rm -f -- "\$partial"/);
  assert.match(script, /start "\$app_id"[\s\S]*start "\$graph_id"/);
  assert.match(script, /rm -f "\$clone_app"[\s\S]*rm -f "\$clone_db"/);
  assert.match(script, /node --import tsx \/app\/deploy\/lightsail\/bootstrap-db\.mjs/);
  assert.match(dockerfile, /CMD \["node", "\/app\/deploy\/entrypoint\.mjs"\]/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/app\/deploy\/healthcheck\.mjs/);
  assert.doesNotMatch(script, /docker compose|caddy|--publish|-p 5432/);
});

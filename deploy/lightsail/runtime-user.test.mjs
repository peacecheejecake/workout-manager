import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appImage = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const routingImage = readFileSync(new URL('./graphhopper.Dockerfile', import.meta.url), 'utf8');
const compose = readFileSync(new URL('./compose.yml', import.meta.url), 'utf8');

function service(name) {
  const match = new RegExp(`^  ${name}:\\n(?<body>(?:^    .*\\n|^\\n)*)`, 'm').exec(compose);
  assert.ok(match, `missing ${name} service`);
  return match.groups.body;
}

test('runtime images define separate non-login users and keep application code read-only', () => {
  assert.match(appImage, /groupadd --gid 20001 workout/);
  assert.match(
    appImage,
    /useradd --uid 20001 --gid workout[\s\S]*--shell \/usr\/sbin\/nologin[\s\S]*workout/,
  );
  assert.match(appImage, /HOME=\/home\/workout/);
  assert.match(appImage, /chown -R workout:workout \/app\/apps\/web\/\.next\/cache/);
  assert.match(appImage, /^USER workout:workout$/m);
  assert.doesNotMatch(appImage, /COPY --from=build --chown=/);

  assert.match(routingImage, /groupadd --gid 20002 graphhopper/);
  assert.match(
    routingImage,
    /useradd --uid 20002 --gid graphhopper[\s\S]*--shell \/usr\/sbin\/nologin[\s\S]*graphhopper/,
  );
  assert.match(routingImage, /HOME=\/home\/graphhopper/);
  assert.match(routingImage, /^USER graphhopper:graphhopper$/m);
});

test('private writers use the application identity and routing uses a separate identity', () => {
  for (const name of ['app', 'resource_cleanup', 'course_thumbnails', 'url_ingestion']) {
    assert.match(service(name), /^ {4}user: '20001:20001'$/m, name);
    assert.match(service(name), /target: \/var\/lib\/workout\/private/, name);
  }
  assert.match(service('graphhopper'), /^ {4}user: '20002:20002'$/m);
  assert.match(service('graphhopper'), /network_mode: service:app/);
  assert.match(service('graphhopper'), /target: \/opt\/workout\/routing\n(?! {8}read_only: true)/);

  // Setup keeps its image user and DB-only duties; the ledger's explicit root exception stays scoped.
  assert.doesNotMatch(service('db_setup'), /^ {4}user:/m);
  assert.doesNotMatch(service('db_setup'), /target: \/var\/lib\/workout\/private/);
  assert.match(service('ledger_export'), /^ {4}user: '0:0'$/m);
  assert.match(service('ledger_export'), /^ {4}read_only: true$/m);
});

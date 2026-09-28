import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWebEnvironment } from './entrypoint.mjs';
import { checkReadiness } from './healthcheck.mjs';

test('web child receives only its explicit environment allowlist', () => {
  const environment = buildWebEnvironment({
    NODE_ENV: 'production',
    API_ORIGIN: 'http://127.0.0.1:4300',
    BASEMAP_DIST_DIR: '/map',
    DATABASE_URL: 'postgres://private',
    OIDC_CLIENT_SECRET: 'private',
    PRIVATE_RESOURCE_STORAGE_ROOT: '/private',
  });
  assert.deepEqual(environment, {
    NODE_ENV: 'production',
    API_ORIGIN: 'http://127.0.0.1:4300',
    BASEMAP_DIST_DIR: '/map',
  });
});

function readinessOptions({ databaseReady = true, webStatus = 302, apiStatus = 200 } = {}) {
  class FakeClient {
    async connect() {}
    async query(query) {
      assert.equal(query, 'SELECT 1 AS ready');
      if (!databaseReady) throw new Error('database down: sensitive detail');
      return { rows: [{ ready: 1 }] };
    }
    async end() {}
  }
  return {
    databaseUrl: 'postgres://private',
    ClientImpl: FakeClient,
    fetchImpl: async (url) => ({
      status: url.includes(':4300') ? apiStatus : webStatus,
      body: { cancel: async () => {} },
    }),
  };
}

test('readiness requires API, web and database', async () => {
  await assert.doesNotReject(checkReadiness(readinessOptions()));
  await assert.rejects(checkReadiness(readinessOptions({ apiStatus: 404 })));
  await assert.rejects(checkReadiness(readinessOptions({ webStatus: 500 })));
  await assert.rejects(checkReadiness(readinessOptions({ databaseReady: false })));
  await assert.rejects(checkReadiness({ ...readinessOptions(), databaseUrl: '' }));
});

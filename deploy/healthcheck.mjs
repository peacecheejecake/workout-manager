import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Client } = requireApi('pg');

export async function checkReadiness({
  fetchImpl = fetch,
  ClientImpl = Client,
  databaseUrl = process.env.DATABASE_URL,
} = {}) {
  if (!databaseUrl) throw new Error('database unavailable');
  const client = new ClientImpl({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1500,
    query_timeout: 1500,
  });
  const probes = [
    { url: 'http://127.0.0.1:4300/health', accepts: (status) => status === 200 },
    { url: 'http://127.0.0.1:3100/', accepts: (status) => status >= 200 && status < 400 },
  ];
  try {
    const results = await Promise.allSettled([
      ...probes.map(async ({ url, accepts }) => {
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(3000),
          redirect: 'manual',
        });
        try {
          if (!accepts(response.status)) throw new Error('unhealthy');
        } finally {
          await response.body?.cancel();
        }
      }),
      (async () => {
        await client.connect();
        const result = await client.query('SELECT 1 AS ready');
        if (result.rows[0]?.ready !== 1) throw new Error('database unavailable');
      })(),
    ]);
    if (results.some((result) => result.status === 'rejected')) throw new Error('unhealthy');
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkReadiness();
  } catch {
    process.exitCode = 1;
  }
}

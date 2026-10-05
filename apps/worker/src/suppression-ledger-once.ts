import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { S3Client } from '@aws-sdk/client-s3';
import { coordinateSuppressionExport } from '@workout/server-persistence/restore-suppression-coordinator';
import { Pool } from 'pg';

import { createSuppressionRemoteStore } from '../../../deploy/lightsail/backup/ledger-remote-store.mjs';
import {
  parseSuppressionLedgerOnceConfig,
  readSuppressionLedgerKey,
} from './suppression-ledger-config.js';
import { createSuppressionLedgerS3Client } from './suppression-ledger-s3-client.js';

export interface SuppressionLedgerOnceDependencies {
  createS3(region: 'ap-northeast-2'): S3Client;
  createPool(connectionString: string): Pool;
  coordinate: typeof coordinateSuppressionExport;
  readKey(path: string): Buffer;
}

const defaults: SuppressionLedgerOnceDependencies = {
  createS3: (region) => new S3Client({ region, maxAttempts: 2 }),
  createPool: (connectionString) =>
    new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 1_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    }),
  coordinate: coordinateSuppressionExport,
  readKey: readSuppressionLedgerKey,
};

/** One opt-in invocation. The coordinator requires a pre-provisioned signed head. */
export async function runSuppressionLedgerOnce(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  dependencies: SuppressionLedgerOnceDependencies = defaults,
): Promise<void> {
  const config = parseSuppressionLedgerOnceConfig(args, env);
  const encryptionKey = dependencies.readKey(config.encryptionKeyPath);
  let headAuthenticationKey: Buffer;
  try {
    headAuthenticationKey = dependencies.readKey(config.headAuthenticationKeyPath);
  } catch (error) {
    encryptionKey.fill(0);
    throw error;
  }
  if (
    encryptionKey.length !== 32 ||
    headAuthenticationKey.length !== 32 ||
    encryptionKey.equals(headAuthenticationKey)
  ) {
    encryptionKey.fill(0);
    headAuthenticationKey.fill(0);
    throw new Error('SUPPRESSION_LEDGER_CONFIG_FAILED');
  }

  let s3: S3Client | undefined;
  let pool: Pool | undefined;
  try {
    s3 = dependencies.createS3(config.remote.region);
    pool = dependencies.createPool(config.connectionString);
    const client = createSuppressionLedgerS3Client(config.remote, s3);
    const store = createSuppressionRemoteStore({ config: config.remote, client });
    await dependencies.coordinate({
      pool,
      store,
      slotName: config.slotName,
      expectedClusterId: config.expectedClusterId,
      encryptionKey,
      encryptionKeyId: config.encryptionKeyId,
      headAuthenticationKey,
    });
  } finally {
    try {
      await pool?.end();
    } finally {
      s3?.destroy();
      encryptionKey.fill(0);
      headAuthenticationKey.fill(0);
    }
  }
}

export async function runSuppressionLedgerCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  dependencies: SuppressionLedgerOnceDependencies = defaults,
): Promise<void> {
  const runId = randomUUID();
  const configuredRelease = env['WORKOUT_RELEASE'];
  const version =
    configuredRelease && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(configuredRelease)
      ? configuredRelease
      : 'unreleased';
  try {
    await runSuppressionLedgerOnce(args, env, dependencies);
    process.stdout.write(
      `${JSON.stringify({ kind: 'suppression_ledger_export_attempt_completed', runId, version })}\n`,
    );
  } catch {
    process.stderr.write(
      `${JSON.stringify({ kind: 'suppression_ledger_export_failed', runId, version })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSuppressionLedgerCli(process.argv.slice(2), process.env);
}

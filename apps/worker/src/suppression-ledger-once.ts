import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { S3Client } from '@aws-sdk/client-s3';
import type { SuppressionRemoteStore } from '@workout/server-persistence/restore-suppression-coordinator';
import { exportAuthenticatedSuppressionSegmentForInstalledDomain } from '@workout/server-persistence/restore-suppression-exporter';
import { Pool } from 'pg';

import {
  createSuppressionRemoteStore,
  type SuppressionRemoteConfig,
  type SuppressionVersionedObjectClient,
} from '../../../deploy/lightsail/backup/ledger-remote-store.mjs';
import {
  parseSuppressionLedgerOnceConfig,
  readSuppressionLedgerKey,
} from './suppression-ledger-config.js';
import {
  bootstrapSuppressionLedgerHead,
  inspectSuppressionSource,
  runSuppressionLedgerExport,
  SuppressionLedgerFailure,
  type SuppressionLedgerRunResult,
  type SuppressionLedgerRunInput,
} from './suppression-ledger-export.js';
import { createSuppressionLedgerS3Client } from './suppression-ledger-s3-client.js';

export interface SuppressionLedgerOnceDependencies {
  createS3(region: 'ap-northeast-2'): S3Client;
  createPool(connectionString: string): Pool;
  createRemote(
    config: SuppressionRemoteConfig,
    s3: S3Client,
  ): { client: SuppressionVersionedObjectClient; store: SuppressionRemoteStore };
  inspectSource: SuppressionLedgerRunInput['inspectSource'];
  exportForInstalledDomain: SuppressionLedgerRunInput['exportForInstalledDomain'];
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
  createRemote: (config, s3) => {
    const client = createSuppressionLedgerS3Client(config, s3);
    return { client, store: createSuppressionRemoteStore({ config, client }) };
  },
  inspectSource: inspectSuppressionSource,
  exportForInstalledDomain: exportAuthenticatedSuppressionSegmentForInstalledDomain,
  readKey: readSuppressionLedgerKey,
};

function configFailure(): never {
  throw new SuppressionLedgerFailure('SUPPRESSION_LEDGER_CONFIG_FAILED');
}

/**
 * One opt-in invocation: `--run-once` exports through the authenticated installed-domain
 * exporter (V7 or V8, as configured and installed); `--bootstrap-head` creates the initial
 * signed head. The legacy v1 coordinator is never used here.
 */
export async function runSuppressionLedgerOnce(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  dependencies: SuppressionLedgerOnceDependencies = defaults,
): Promise<SuppressionLedgerRunResult> {
  let config: ReturnType<typeof parseSuppressionLedgerOnceConfig>;
  let encryptionKey: Buffer;
  try {
    config = parseSuppressionLedgerOnceConfig(args, env);
    encryptionKey = dependencies.readKey(config.encryptionKeyPath);
  } catch {
    return configFailure();
  }
  let headAuthenticationKey: Buffer;
  try {
    headAuthenticationKey = dependencies.readKey(config.headAuthenticationKeyPath);
  } catch {
    encryptionKey.fill(0);
    return configFailure();
  }
  if (
    encryptionKey.length !== 32 ||
    headAuthenticationKey.length !== 32 ||
    encryptionKey.equals(headAuthenticationKey)
  ) {
    encryptionKey.fill(0);
    headAuthenticationKey.fill(0);
    return configFailure();
  }

  let s3: S3Client | undefined;
  let pool: Pool | undefined;
  try {
    s3 = dependencies.createS3(config.remote.region);
    pool = dependencies.createPool(config.connectionString);
    const { client, store } = dependencies.createRemote(config.remote, s3);
    const input: SuppressionLedgerRunInput = {
      config,
      pool,
      store,
      client,
      encryptionKey,
      headAuthenticationKey,
      inspectSource: dependencies.inspectSource,
      exportForInstalledDomain: dependencies.exportForInstalledDomain,
    };
    return config.command === 'bootstrap-head'
      ? await bootstrapSuppressionLedgerHead(input)
      : await runSuppressionLedgerExport(input);
  } catch (error) {
    if (error instanceof SuppressionLedgerFailure) throw error;
    throw new SuppressionLedgerFailure(
      config.command === 'bootstrap-head'
        ? 'SUPPRESSION_LEDGER_BOOTSTRAP_FAILED'
        : 'SUPPRESSION_LEDGER_EXPORT_FAILED',
    );
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
    const result = await runSuppressionLedgerOnce(args, env, dependencies);
    process.stdout.write(
      `${JSON.stringify({
        kind: 'suppression_ledger_export_attempt_completed',
        runId,
        version,
        outcome: result.outcome,
        relationProfile: result.relationProfile,
      })}\n`,
    );
  } catch (error) {
    const reason =
      error instanceof SuppressionLedgerFailure ? error.code : 'SUPPRESSION_LEDGER_UNEXPECTED';
    process.stderr.write(
      `${JSON.stringify({ kind: 'suppression_ledger_export_failed', runId, version, reason })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSuppressionLedgerCli(process.argv.slice(2), process.env);
}

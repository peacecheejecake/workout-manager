#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const OWNER = '681892421656';
const REGION = 'ap-northeast-2';
const BUCKETS = Object.freeze({
  backup: 'workout-manager-backups-681892421656-apne2',
  ledger: 'workout-manager-ledger-681892421656-apne2',
});
const CONFIG_KEYS = ['bucket', 'expectedBucketOwner', 'prefix', 'region', 'schemaVersion'];

function fail() {
  throw new Error('IAM_POLICY_CONFIG_INVALID');
}

function validPrefix(prefix, kind) {
  if (typeof prefix !== 'string' || prefix.length < 1 || prefix.length > 128) return false;
  const parts = prefix.split('/');
  if (
    parts.length > 6 ||
    parts.some(
      (part) =>
        part.length < 1 || part.length > 32 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part),
    )
  )
    return false;
  if (kind === 'ledger') return /^(?:[a-z0-9-]+\/)*deletion-ledger\/v1$/.test(prefix);
  return true;
}

function validate(kind, config) {
  if (kind !== 'backup' && kind !== 'ledger') fail();
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).sort().join(',') !== CONFIG_KEYS.join(',') ||
    config.schemaVersion !== 1 ||
    config.bucket !== BUCKETS[kind] ||
    config.expectedBucketOwner !== OWNER ||
    config.region !== REGION ||
    !validPrefix(config.prefix, kind)
  )
    fail();
}

/** Reviewable identity policy for the existing versioned S3 transports. */
export function createIamPolicy(kind, config) {
  validate(kind, config);
  const bucketArn = `arn:aws:s3:::${config.bucket}`;
  const rootArn = `${bucketArn}/${config.prefix}`;
  const statement = [
    {
      Sid: 'ReadBucketProperties',
      Effect: 'Allow',
      Action: ['s3:GetBucketLocation', 's3:GetBucketVersioning'],
      Resource: bucketArn,
    },
    {
      Sid: 'DetectMissingObjects',
      Effect: 'Allow',
      Action: 's3:ListBucket',
      Resource: bucketArn,
    },
  ];
  if (kind === 'ledger') {
    statement.push({
      Sid: 'ListLedgerObjectVersions',
      Effect: 'Allow',
      Action: 's3:ListBucketVersions',
      Resource: bucketArn,
      Condition: {
        StringLike: {
          's3:prefix': [`${config.prefix}/head.bin`, `${config.prefix}/segments/*`],
        },
      },
    });
  }
  statement.push({
    Sid: kind === 'backup' ? 'ReadWriteBackupObjects' : 'ReadWriteLedgerObjects',
    Effect: 'Allow',
    Action: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion'],
    Resource: kind === 'backup' ? `${rootArn}/*` : [`${rootArn}/head.bin`, `${rootArn}/segments/*`],
  });
  return { Version: '2012-10-17', Statement: statement };
}

function main(args) {
  if (args.length !== 2) fail();
  const [kind, path] = args;
  if (kind !== 'backup' && kind !== 'ledger') fail();
  const config = JSON.parse(readFileSync(path, 'utf8'));
  process.stdout.write(`${JSON.stringify(createIamPolicy(kind, config), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch {
    process.stderr.write('IAM_POLICY_CONFIG_INVALID\n');
    process.exitCode = 1;
  }
}

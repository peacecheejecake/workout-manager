import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createIamPolicy } from './iam-policy.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const backup = JSON.parse(readFileSync(join(directory, 'iam-backup-config.example.json'), 'utf8'));
const ledger = JSON.parse(readFileSync(join(directory, 'iam-ledger-config.example.json'), 'utf8'));

function policyActions(policy) {
  return policy.Statement.flatMap((entry) => entry.Action);
}

test('backup identity policy has exact bucket and bounded object actions', () => {
  const policy = createIamPolicy('backup', backup);
  assert.deepEqual(policy, {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ReadBucketProperties',
        Effect: 'Allow',
        Action: ['s3:GetBucketLocation', 's3:GetBucketVersioning'],
        Resource: 'arn:aws:s3:::workout-manager-backups-681892421656-apne2',
      },
      {
        Sid: 'DetectMissingObjects',
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: 'arn:aws:s3:::workout-manager-backups-681892421656-apne2',
      },
      {
        Sid: 'ReadWriteBackupObjects',
        Effect: 'Allow',
        Action: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion'],
        Resource: 'arn:aws:s3:::workout-manager-backups-681892421656-apne2/backup/v1/*',
      },
    ],
  });
  assert.equal(JSON.stringify(policy), JSON.stringify(createIamPolicy('backup', backup)));
});

test('ledger policy limits listing and object actions to its two key forms', () => {
  const policy = createIamPolicy('ledger', ledger);
  assert.deepEqual(policy, {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ReadBucketProperties',
        Effect: 'Allow',
        Action: ['s3:GetBucketLocation', 's3:GetBucketVersioning'],
        Resource: 'arn:aws:s3:::workout-manager-ledger-681892421656-apne2',
      },
      {
        Sid: 'DetectMissingObjects',
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: 'arn:aws:s3:::workout-manager-ledger-681892421656-apne2',
      },
      {
        Sid: 'ListLedgerObjectVersions',
        Effect: 'Allow',
        Action: 's3:ListBucketVersions',
        Resource: 'arn:aws:s3:::workout-manager-ledger-681892421656-apne2',
        Condition: {
          StringLike: {
            's3:prefix': ['deletion-ledger/v1/head.bin', 'deletion-ledger/v1/segments/*'],
          },
        },
      },
      {
        Sid: 'ReadWriteLedgerObjects',
        Effect: 'Allow',
        Action: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion'],
        Resource: [
          'arn:aws:s3:::workout-manager-ledger-681892421656-apne2/deletion-ledger/v1/head.bin',
          'arn:aws:s3:::workout-manager-ledger-681892421656-apne2/deletion-ledger/v1/segments/*',
        ],
      },
    ],
  });
  assert.equal(JSON.stringify(policy), JSON.stringify(createIamPolicy('ledger', ledger)));
});

test('unknown targets, owner, region, prefixes, and extra config are rejected', () => {
  const mutations = [
    { kind: 'other', config: backup },
    { kind: 'backup', config: { ...backup, bucket: ledger.bucket } },
    { kind: 'ledger', config: { ...ledger, bucket: backup.bucket } },
    { kind: 'backup', config: { ...backup, expectedBucketOwner: '000000000000' } },
    { kind: 'backup', config: { ...backup, region: 'us-east-1' } },
    { kind: 'backup', config: { ...backup, schemaVersion: 2 } },
    { kind: 'backup', config: { ...backup, accessKey: 'not-allowed' } },
    ...[
      '',
      '/',
      'backup/',
      '/backup',
      'backup//v1',
      '../backup',
      'backup/../v1',
      'backup/*',
      'backup/?',
      'backup/%2a',
      'backup/space here',
      'backup/ü',
      'backup\\v1',
      'a'.repeat(33),
      'a/'.repeat(6) + 'b',
    ].map((prefix) => ({ kind: 'backup', config: { ...backup, prefix } })),
    { kind: 'ledger', config: { ...ledger, prefix: 'backup/v1' } },
    { kind: 'ledger', config: { ...ledger, prefix: 'deletion-ledger/v2' } },
    { kind: 'ledger', config: { ...ledger, prefix: 'deletion-ledger/v1/*' } },
  ];
  for (const { kind, config } of mutations) {
    assert.throws(() => createIamPolicy(kind, config), /IAM_POLICY_CONFIG_INVALID/);
  }
});

test('only missing-key detection can list each dedicated bucket without a prefix', () => {
  for (const [kind, config] of [
    ['backup', backup],
    ['ledger', ledger],
  ]) {
    const policy = createIamPolicy(kind, config);
    assert.deepEqual(
      policyActions(policy).sort(),
      [
        's3:GetBucketLocation',
        's3:GetBucketVersioning',
        's3:ListBucket',
        's3:PutObject',
        's3:GetObject',
        's3:GetObjectVersion',
        ...(kind === 'ledger' ? ['s3:ListBucketVersions'] : []),
      ].sort(),
    );
    assert.ok(policy.Statement.every((entry) => entry.Effect === 'Allow'));
    assert.ok(policy.Statement.every((entry) => !JSON.stringify(entry.Resource).includes(':::*')));
    const bucketArn = `arn:aws:s3:::${config.bucket}`;
    assert.deepEqual(
      policy.Statement.filter((entry) => entry.Action === 's3:ListBucket'),
      [
        {
          Sid: 'DetectMissingObjects',
          Effect: 'Allow',
          Action: 's3:ListBucket',
          Resource: bucketArn,
        },
      ],
    );
    assert.ok(
      policy.Statement.filter((entry) => entry.Action.includes('s3:PutObject')).every((entry) =>
        JSON.stringify(entry.Resource).includes(`${bucketArn}/${config.prefix}/`),
      ),
    );
  }
});

test('policy actions correspond to current backup, ledger CLI, and worker S3 calls', () => {
  const backupSource = readFileSync(join(directory, 'remote-store.mjs'), 'utf8');
  const ledgerCliSource = readFileSync(join(directory, 'ledger-aws-cli-client.mjs'), 'utf8');
  const workerSource = readFileSync(
    join(directory, '../../../apps/worker/src/suppression-ledger-s3-client.ts'),
    'utf8',
  );
  const backupCalls = [...backupSource.matchAll(/this\.call\(\[\s*'([^']+)'/g)].map(
    (match) => match[1],
  );
  const ledgerCalls = [...ledgerCliSource.matchAll(/\bcall\(\s*'([^']+)'/g)].map(
    (match) => match[1],
  );
  const workerCalls = [...workerSource.matchAll(/new (\w+Command)\(/g)].map((match) => match[1]);
  assert.match(backupSource, /async getLatestOrNull\(key, target\)/);
  assert.match(backupSource, /NoSuchKey/);
  assert.match(ledgerCliSource, /async getLatestOrNull\(key\)/);
  assert.match(ledgerCliSource, /NoSuchKey/);
  assert.match(workerSource, /async getLatestOrNull\(key: string\)/);
  assert.match(workerSource, /record\.name === 'NoSuchKey'/);
  assert.deepEqual([...new Set(backupCalls)].sort(), [
    'get-bucket-location',
    'get-bucket-versioning',
    'get-object',
    'head-object',
    'put-object',
  ]);
  assert.deepEqual([...new Set(ledgerCalls)].sort(), [
    'get-bucket-location',
    'get-bucket-versioning',
    'get-object',
    'head-object',
    'list-object-versions',
    'put-object',
  ]);
  assert.deepEqual([...new Set(workerCalls)].sort(), [
    'GetBucketLocationCommand',
    'GetBucketVersioningCommand',
    'GetObjectCommand',
    'HeadObjectCommand',
    'ListObjectVersionsCommand',
    'PutObjectCommand',
  ]);
  assert.deepEqual(policyActions(createIamPolicy('backup', backup)).sort(), [
    's3:GetBucketLocation',
    's3:GetBucketVersioning',
    's3:GetObject',
    's3:GetObjectVersion',
    's3:ListBucket',
    's3:PutObject',
  ]);
  assert.deepEqual(policyActions(createIamPolicy('ledger', ledger)).sort(), [
    's3:GetBucketLocation',
    's3:GetBucketVersioning',
    's3:GetObject',
    's3:GetObjectVersion',
    's3:ListBucket',
    's3:ListBucketVersions',
    's3:PutObject',
  ]);
});

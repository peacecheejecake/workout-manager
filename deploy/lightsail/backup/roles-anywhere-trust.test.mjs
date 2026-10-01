import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRolesAnywhereTrustPolicy } from './roles-anywhere-trust.mjs';

const trustAnchorArn =
  'arn:aws:rolesanywhere:ap-northeast-2:681892421656:trust-anchor/12345678-1234-1234-1234-123456789abc';
const script = fileURLToPath(new URL('./roles-anywhere-trust.mjs', import.meta.url));

test('backup and ledger have separate exact-CN role trust documents', () => {
  for (const [kind, cn] of [
    ['backup', 'workout-manager-backup-v1'],
    ['ledger', 'workout-manager-ledger-v1'],
  ]) {
    const policy = createRolesAnywhereTrustPolicy(kind, trustAnchorArn);
    assert.deepEqual(policy, {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'rolesanywhere.amazonaws.com' },
          Action: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'],
          Condition: {
            StringEquals: {
              'aws:SourceAccount': '681892421656',
              'aws:PrincipalTag/x509Subject/CN': cn,
            },
            ArnEquals: { 'aws:SourceArn': trustAnchorArn },
          },
        },
      ],
    });
    assert.equal(
      JSON.stringify(policy),
      JSON.stringify(createRolesAnywhereTrustPolicy(kind, trustAnchorArn)),
    );
    assert.doesNotMatch(JSON.stringify(policy), /"(?:Principal|Resource)":"\*"/);
  }
});

test('unknown role kind and malformed or cross-account trust anchors are rejected', () => {
  const invalidArns = [
    undefined,
    null,
    '',
    '*',
    ' arn:aws:rolesanywhere:ap-northeast-2:681892421656:trust-anchor/12345678-1234-1234-1234-123456789abc',
    trustAnchorArn + ' ',
    trustAnchorArn + '/other',
    trustAnchorArn.replace('arn:aws:', 'arn:aws-cn:'),
    trustAnchorArn.replace('rolesanywhere', 'iam'),
    trustAnchorArn.replace('ap-northeast-2', 'us-east-1'),
    trustAnchorArn.replace('681892421656', '000000000000'),
    trustAnchorArn.replace('trust-anchor', 'profile'),
    trustAnchorArn.replace('12345678-1234-1234-1234-123456789abc', '*'),
    trustAnchorArn.replace('12345678-1234-1234-1234-123456789abc', 'not-an-id'),
    trustAnchorArn.replace(
      '12345678-1234-1234-1234-123456789abc',
      '12345678-1234-1234-1234-123456789abC',
    ),
    [trustAnchorArn, trustAnchorArn],
  ];
  for (const arn of invalidArns) {
    assert.throws(
      () => createRolesAnywhereTrustPolicy('backup', arn),
      /ROLES_ANYWHERE_TRUST_INPUT_INVALID/,
    );
  }
  for (const kind of ['', 'both', 'Backup', null, ['backup', 'ledger']]) {
    assert.throws(
      () => createRolesAnywhereTrustPolicy(kind, trustAnchorArn),
      /ROLES_ANYWHERE_TRUST_INPUT_INVALID/,
    );
  }
});

test('CLI emits exactly one policy and rejects missing or ambiguous arguments', () => {
  for (const kind of ['backup', 'ledger']) {
    const result = spawnSync(process.execPath, [script, kind, trustAnchorArn], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(
      JSON.parse(result.stdout),
      createRolesAnywhereTrustPolicy(kind, trustAnchorArn),
    );
    assert.equal(
      result.stdout,
      `${JSON.stringify(createRolesAnywhereTrustPolicy(kind, trustAnchorArn), null, 2)}\n`,
    );
  }
  for (const args of [
    [],
    ['backup'],
    ['backup', trustAnchorArn, 'ledger'],
    ['both', trustAnchorArn],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ROLES_ANYWHERE_TRUST_INPUT_INVALID\n');
  }
});

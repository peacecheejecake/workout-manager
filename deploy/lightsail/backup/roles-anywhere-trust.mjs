#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const ACCOUNT = '681892421656';
const REGION = 'ap-northeast-2';
const SUBJECT_CN = Object.freeze({
  backup: 'workout-manager-backup-v1',
  ledger: 'workout-manager-ledger-v1',
});
const TRUST_ANCHOR_ARN = new RegExp(
  `^arn:aws:rolesanywhere:${REGION}:${ACCOUNT}:trust-anchor/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$`,
);

function invalidInput() {
  throw new Error('ROLES_ANYWHERE_TRUST_INPUT_INVALID');
}

/** Generate the trust document for exactly one workload role and one trust anchor. */
export function createRolesAnywhereTrustPolicy(kind, trustAnchorArn) {
  if (
    (kind !== 'backup' && kind !== 'ledger') ||
    typeof trustAnchorArn !== 'string' ||
    !TRUST_ANCHOR_ARN.test(trustAnchorArn)
  ) {
    invalidInput();
  }

  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'rolesanywhere.amazonaws.com' },
        Action: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'],
        Condition: {
          StringEquals: {
            'aws:SourceAccount': ACCOUNT,
            'aws:PrincipalTag/x509Subject/CN': SUBJECT_CN[kind],
          },
          ArnEquals: { 'aws:SourceArn': trustAnchorArn },
        },
      },
    ],
  };
}

function main(args) {
  if (args.length !== 2) invalidInput();
  const [kind, trustAnchorArn] = args;
  process.stdout.write(
    `${JSON.stringify(createRolesAnywhereTrustPolicy(kind, trustAnchorArn), null, 2)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch {
    process.stderr.write('ROLES_ANYWHERE_TRUST_INPUT_INVALID\n');
    process.exitCode = 1;
  }
}

# S3 transport identity policies (review template)

The two example configs identify the **currently empty** Seoul S3 buckets and the
expected AWS account (`681892421656`). They contain no credentials. Before any
deployment, choose the exact prefix used by each transport and review the
generated JSON. The generator accepts only those two bucket names, that owner,
`ap-northeast-2`, schema version 1, and bounded ASCII path segments. The ledger
prefix must end in `deletion-ledger/v1` to match the current clients. Use these
policies only with these two dedicated-purpose buckets.

```sh
node deploy/lightsail/backup/iam-policy.mjs backup \
  deploy/lightsail/backup/iam-backup-config.example.json
node deploy/lightsail/backup/iam-policy.mjs ledger \
  deploy/lightsail/backup/iam-ledger-config.example.json
```

Each command prints one deterministic IAM **identity policy** to standard output.
It does not create an IAM principal, attach a policy, write to S3, or configure
the server. Keep the backup and ledger identities separate; do not combine the
two generated documents into one principal. The example prefixes are
`backup/v1` and `deletion-ledger/v1`. The actual transport config must use the
same bucket, prefix, region, and expected bucket owner as its reviewed policy.

| Existing operation                                            | Identity permission                                                                                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `get-bucket-location`, `get-bucket-versioning`                | `s3:GetBucketLocation`, `s3:GetBucketVersioning` on its concrete bucket                                                            |
| absent-key detection during `get-object`                      | `s3:ListBucket` on its concrete dedicated bucket, without a prefix condition                                                       |
| `put-object`                                                  | `s3:PutObject` on the selected keys                                                                                                |
| `get-object` (latest or by version), `head-object` by version | `s3:GetObject`, `s3:GetObjectVersion` on the selected keys                                                                         |
| ledger `list-object-versions`                                 | `s3:ListBucketVersions` on the ledger bucket, with `s3:prefix` limited to exact `head.bin` or `segments/*` under the ledger prefix |

The backup object scope is `<prefix>/*`; the ledger object scope is exactly
`<prefix>/head.bin` and `<prefix>/segments/*`. There is no `DeleteObject`,
bucket mutation, public ACL, unrelated AWS permission, or wildcard bucket ARN.
`s3:prefix` limits the **requested listing prefix**, not the
contents of an S3 object. The existing ledger clients request the exact object
key for version listings and filter returned entries to that key. Bucket policy,
organization controls, and any other attached IAM policies must be reviewed
separately because IAM permissions combine across applicable policies.

**Why bucket-level listing is present:** Both current transports probe the latest
completion or ledger head with `GetObject` and treat `NoSuchKey` as an empty key.
[AWS documents](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)
that an absent key can return `AccessDenied` when the identity lacks
`s3:ListBucket`. The unconditional `ListBucket` grant on each exact dedicated
bucket lets that missing-key response work; it also permits listing other key
names in that same bucket. That is why the bucket identity is fixed and must not
be reused for unrelated data. The ledger's separate `ListBucketVersions` grant
remains prefix constrained. A real least-privilege S3 first-write test is still
required before operational use.

The bucket creation and empty-state check are recorded in
`docs/implementation/progress/EXT-HOSTING.md`. Generating these policies is
local preparation only. Identity creation/attachment, credentials or workload
identity, real upload/version re-read, retention/deletion controls, independent
ledger replay, and operational restore remain **not_executed**.

## Short-lived workload identity preparation

The two S3 identity policies above can be attached to separate IAM roles for
[IAM Roles Anywhere](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/introduction.html).
This avoids a long-lived AWS access key on the Lightsail host. The service's
[credential helper](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/credential-helper.html)
can supply short-lived credentials to an AWS CLI `credential_process`. A
self-managed certificate authority requires protected issuance, renewal, and
revocation; do not place its signing key on the application server. AWS Private
CA is a separately priced service and is not assumed by this plan.

`roles-anywhere-trust.mjs` prints one role trust policy at a time after a real
Seoul trust anchor ARN exists:

```sh
node deploy/lightsail/backup/roles-anywhere-trust.mjs backup <trust-anchor-arn>
node deploy/lightsail/backup/roles-anywhere-trust.mjs ledger <trust-anchor-arn>
```

The documents bind the exact account and trust anchor, and use distinct
`x509Subject/CN` principal tags (`workout-manager-backup-v1` and
`workout-manager-ledger-v1`). The profile must map the certificate subject CN
as described by the [AWS trust model](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/trust-model.html)
and [attribute mapping guide](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/attribute-mapping-and-trust-policy.html).
Review the generated policies and actual roles separately before attachment.
The role's identity policy must remain the corresponding narrow S3 policy
above. Two roles on one root-controlled host do not by themselves make deletion
records independent of a host compromise.

As recorded in `docs/implementation/progress/EXT-HOSTING.md`, the Seoul trust
anchor, separate roles and profiles, CA, host-generated leaf keys, verified
credential helper, and root-only `credential_process` configuration now exist.
Both roles obtained short-lived sessions on the host. Each role could write
and read back a synthetic version in its own bucket and was denied a versioning
read in the other bucket; an administrator removed the exact test versions. These
probes do not establish retention, independent ledger durability, operational
backup upload, restore, certificate renewal/revocation, or a complete host write
fence. Keep production backup and ledger objects out of these buckets until
those gates are verified.

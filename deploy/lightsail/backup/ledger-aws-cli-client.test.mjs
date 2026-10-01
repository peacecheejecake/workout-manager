import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { createLedgerAwsCliClient } from './ledger-aws-cli-client.mjs';

const config = {
  schemaVersion: 1,
  bucket: 'wm-private-ledger',
  prefix: 'workout/deletion-ledger/v1',
  region: 'ap-northeast-2',
  expectedBucketOwner: '681892421656',
};
const key = `${config.prefix}/head.bin`;
const segmentKey = `${config.prefix}/segments/${'a'.repeat(64)}.bin`;
const etag = `"${'a'.repeat(32)}"`;

function success(value) {
  return { status: 0, signal: null, error: null, stderr: '', stdout: JSON.stringify(value) };
}

function fixture(respond) {
  const calls = [];
  const runner = (program, args, options) => {
    calls.push({ program, args, options });
    return respond(args[1], args);
  };
  return { client: createLedgerAwsCliClient({ config, runner, synthetic: true }), calls };
}

function option(args, name) {
  const index = args.indexOf(name);
  assert.notEqual(index, -1);
  return args[index + 1];
}

test('all commands pin bucket owner and region and keep bytes off argv', async () => {
  const bytes = Buffer.from('opaque bytes');
  const tempPaths = [];
  const { client, calls } = fixture((command, args) => {
    if (command === 'get-bucket-versioning') return success({ Status: 'Enabled' });
    if (command === 'get-bucket-location') return success({ LocationConstraint: config.region });
    if (command === 'put-object') {
      const path = option(args, '--body');
      tempPaths.push(path);
      assert.deepEqual(readFileSync(path), bytes);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(path.slice(0, path.lastIndexOf('/'))).mode & 0o777, 0o700);
      return success({ VersionId: 'v1', ServerSideEncryption: 'AES256', ETag: etag });
    }
    if (command === 'head-object') {
      return success({
        VersionId: 'v1',
        ServerSideEncryption: 'AES256',
        ContentLength: bytes.length,
        ETag: etag,
      });
    }
    if (command === 'get-object') {
      const path = args[args.indexOf('--key') + (args.includes('--version-id') ? 4 : 2)];
      tempPaths.push(path);
      writeFileSync(path, bytes);
      return success({
        VersionId: 'v1',
        ServerSideEncryption: 'AES256',
        ContentLength: bytes.length,
        ETag: etag,
      });
    }
    if (command === 'list-object-versions') {
      return success({ IsTruncated: false, Versions: [{ Key: key, VersionId: 'v1' }] });
    }
    throw Error(command);
  });
  assert.equal(await client.versioning(), 'Enabled');
  assert.equal(await client.location(), config.region);
  assert.deepEqual(await client.putIfAbsent(key, bytes), {
    versionId: 'v1',
    deleted: false,
    encryption: 'AES256',
    owner: config.expectedBucketOwner,
    region: config.region,
  });
  assert.deepEqual(await client.head(key, 'v1'), {
    versionId: 'v1',
    deleted: false,
    encryption: 'AES256',
    owner: config.expectedBucketOwner,
    region: config.region,
  });
  assert.deepEqual((await client.get(key, 'v1')).bytes, bytes);
  assert.deepEqual((await client.getLatestOrNull(key)).bytes, bytes);
  assert.deepEqual(await client.versions(key), ['v1']);
  assert.equal((await client.putIfMatch(key, etag, bytes)).versionId, 'v1');
  for (const call of calls) {
    assert.equal(call.program, 'aws');
    assert.equal(option(call.args, '--bucket'), config.bucket);
    assert.equal(option(call.args, '--region'), config.region);
    assert.equal(option(call.args, '--expected-bucket-owner'), config.expectedBucketOwner);
    assert.equal(call.options.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS, 'true');
    assert.ok(!call.args.includes('--endpoint-url'));
    if (call.args[1] === 'list-object-versions') {
      assert.ok(!call.args.includes('--no-paginate'));
      assert.equal(option(call.args, '--page-size'), '100');
      assert.equal(option(call.args, '--max-items'), '100');
      assert.ok(!call.args.includes('--max-keys'));
      assert.ok(!call.args.includes('--key-marker'));
      assert.ok(!call.args.includes('--version-id-marker'));
    } else {
      assert.ok(call.args.includes('--no-paginate'));
    }
    assert.ok(!call.args.includes(bytes.toString()));
    assert.equal(call.options.timeout, 30_000);
  }
  assert.ok(calls.some((call) => call.args.includes('--if-none-match')));
  assert.ok(calls.some((call) => call.args.includes('--if-match')));
  assert.ok(tempPaths.every((path) => !existsSync(path)));
});

test('exact-key listing includes delete markers across bounded pages', async () => {
  const { client, calls } = fixture((command, args) => {
    assert.equal(command, 'list-object-versions');
    if (!args.includes('--starting-token'))
      return success({
        IsTruncated: true,
        Versions: [
          { Key: key, VersionId: 'v1' },
          { Key: `${key}.other`, VersionId: 'other' },
        ],
        NextToken: 'eyJjdXJzb3IiOiJ2MSJ9',
      });
    assert.equal(option(args, '--starting-token'), 'eyJjdXJzb3IiOiJ2MSJ9');
    return success({ IsTruncated: false, DeleteMarkers: [{ Key: key, VersionId: 'marker' }] });
  });
  assert.deepEqual(await client.versions(key), ['v1', 'marker']);
  assert.equal(calls.length, 2);
});

test('only exact NoSuchKey from latest get becomes null', async () => {
  const { client } = fixture(() => ({
    status: 255,
    signal: null,
    error: null,
    stdout: '',
    stderr:
      'An error occurred (NoSuchKey) when calling the GetObject operation: The specified key does not exist.\n',
  }));
  assert.equal(await client.getLatestOrNull(key), null);
  await assert.rejects(client.get(key, 'v1'), /LEDGER_AWS_CLI_FAILED/);
});

test('ambiguous CLI and metadata failures fail closed', async () => {
  const cases = [
    { status: 255, signal: null, stdout: '', stderr: '404 Not Found' },
    { status: null, signal: 'SIGTERM', stdout: '', stderr: '' },
    { status: 0, signal: null, stdout: '{', stderr: '' },
    success({ VersionId: 'null', ServerSideEncryption: 'AES256', ETag: etag }),
    success({ VersionId: 'v1', ServerSideEncryption: 'aws:kms', ETag: etag }),
  ];
  for (const output of cases) {
    const { client } = fixture(() => output);
    await assert.rejects(client.putIfAbsent(key, Buffer.from('x')), /LEDGER_AWS_CLI_FAILED/);
  }
});

test('rejects malformed pagination and duplicate versions', async () => {
  const cases = [
    { IsTruncated: true, Versions: [{ Key: key, VersionId: 'v1' }] },
    {
      IsTruncated: false,
      Versions: [
        { Key: key, VersionId: 'v1' },
        { Key: key, VersionId: 'v1' },
      ],
    },
    { IsTruncated: 'false', Versions: [] },
    { IsTruncated: true, NextToken: 'bad token', Versions: [] },
    { IsTruncated: false, NextToken: '\n', Versions: [] },
    { IsTruncated: false, Versions: '' },
  ];
  for (const value of cases) {
    const { client } = fixture(() => success(value));
    await assert.rejects(client.versions(key), /LEDGER_AWS_CLI_FAILED/);
  }
  const { client } = fixture(() =>
    success({ IsTruncated: true, NextToken: 'repeat', Versions: [] }),
  );
  await assert.rejects(client.versions(key), /LEDGER_AWS_CLI_FAILED/);
});

test('invalid config, keys, version IDs, ETags and body bounds fail before AWS call', async () => {
  assert.throws(
    () => createLedgerAwsCliClient({ config: { ...config, region: 'us-east-1' }, synthetic: true }),
    /LEDGER_AWS_CLI_FAILED/,
  );
  const { client, calls } = fixture(() => success({}));
  await assert.rejects(client.versions(`${segmentKey}.other`), /LEDGER_AWS_CLI_FAILED/);
  await assert.rejects(client.head(key, 'null'), /LEDGER_AWS_CLI_FAILED/);
  await assert.rejects(client.putIfMatch(key, 'bad', Buffer.from('x')), /LEDGER_AWS_CLI_FAILED/);
  await assert.rejects(client.putIfAbsent(key, Buffer.alloc(0)), /LEDGER_AWS_CLI_FAILED/);
  await assert.rejects(
    client.putIfAbsent(key, Buffer.alloc(1024 * 1024 + 1)),
    /LEDGER_AWS_CLI_FAILED/,
  );
  assert.equal(calls.length, 0);
});

import { createHash } from 'node:crypto';

import {
  createSuppressionRemoteStore,
  type SuppressionRemoteConfig,
  type SuppressionVersionedObjectClient,
} from '../../../deploy/lightsail/backup/ledger-remote-store.mjs';

/** In-memory versioned, owner-bound bucket double for the ledger client boundary. Test only. */
export function memoryVersionedBucket(config: SuppressionRemoteConfig) {
  const objects = new Map<string, { versionId: string; bytes: Buffer; etag: string }[]>();
  let sequence = 0;
  const meta = (versionId: string) => ({
    versionId,
    deleted: false as const,
    encryption: 'AES256' as const,
    owner: config.expectedBucketOwner,
    region: config.region,
  });
  const put = (key: string, bytes: Buffer) => {
    const versionId = `v${++sequence}`;
    const etag = `"${createHash('md5').update(bytes).digest('hex')}"`;
    objects.set(key, [...(objects.get(key) ?? []), { versionId, bytes: Buffer.from(bytes), etag }]);
    return { ...meta(versionId), etag };
  };
  const find = (key: string, versionId: string) => {
    const found = objects.get(key)?.find((item) => item.versionId === versionId);
    if (!found) throw new Error('NoSuchVersion');
    return found;
  };
  const client: SuppressionVersionedObjectClient = {
    config,
    versioning: async () => 'Enabled',
    location: async () => config.region,
    head: async (key, versionId) => meta(find(key, versionId).versionId),
    get: async (key, versionId) => {
      const found = find(key, versionId);
      return { ...meta(found.versionId), bytes: Buffer.from(found.bytes), etag: found.etag };
    },
    getLatestOrNull: async (key) => {
      const found = objects.get(key)?.at(-1);
      return found
        ? { ...meta(found.versionId), bytes: Buffer.from(found.bytes), etag: found.etag }
        : null;
    },
    versions: async (key) => (objects.get(key) ?? []).map((item) => item.versionId),
    putIfAbsent: async (key, bytes) => {
      if (objects.get(key)?.length) throw new Error('PreconditionFailed');
      return put(key, bytes);
    },
    putIfMatch: async (key, etag, bytes) => {
      if (objects.get(key)?.at(-1)?.etag !== etag) throw new Error('PreconditionFailed');
      return put(key, bytes);
    },
  };
  const store = createSuppressionRemoteStore({ config, client });
  return {
    client,
    store,
    headKey: `${config.prefix}/head.bin`,
    latest: (key: string) => objects.get(key)?.at(-1) ?? null,
    segmentCount: () =>
      [...objects.keys()].filter((key) => key.startsWith(`${config.prefix}/segments/`)).length,
    /** Simulates a foreign writer (test only). */
    forcePut: put,
  };
}

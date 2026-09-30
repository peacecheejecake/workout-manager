import type { SuppressionRemoteStore } from '@workout/server-persistence/restore-suppression-coordinator';

export type SuppressionRemoteConfig = {
  schemaVersion: 1;
  bucket: string;
  prefix: string;
  region: 'ap-northeast-2';
  expectedBucketOwner: string;
};

export type VersionedObjectMetadata = {
  versionId: string;
  deleted: false;
  encryption: 'AES256';
  owner: string;
  region: string;
};

export type VersionedObject = VersionedObjectMetadata & {
  bytes: Buffer;
  etag: string;
};

export interface SuppressionVersionedObjectClient {
  readonly config: SuppressionRemoteConfig;
  versioning(): Promise<string>;
  location(): Promise<string>;
  head(key: string, versionId: string): Promise<VersionedObjectMetadata>;
  get(key: string, versionId: string): Promise<VersionedObject>;
  getLatestOrNull(key: string): Promise<VersionedObject | null>;
  versions(key: string): Promise<readonly string[]>;
  putIfAbsent(key: string, bytes: Buffer): Promise<VersionedObjectMetadata>;
  putIfMatch(key: string, etag: string, bytes: Buffer): Promise<VersionedObjectMetadata>;
}

export function createSuppressionRemoteStore(input: {
  config: SuppressionRemoteConfig;
  client: SuppressionVersionedObjectClient;
}): SuppressionRemoteStore;

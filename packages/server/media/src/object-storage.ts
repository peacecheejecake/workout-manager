import type { FinalObjectKey, ObjectKey, TemporaryObjectKey } from './keys.js';

export interface StoredObjectStat {
  readonly key: ObjectKey;
  readonly sizeBytes: number;
  readonly modifiedAt: Date;
}

export interface OpenedStoredObject extends StoredObjectStat {
  readonly body: AsyncIterable<Uint8Array>;
}

export interface PublishExpectation {
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface PublishResult {
  readonly key: FinalObjectKey;
  readonly outcome: 'published' | 'already_present';
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ObjectStorage {
  writeTemporary(
    key: TemporaryObjectKey,
    body: AsyncIterable<Uint8Array>,
  ): Promise<StoredObjectStat>;
  /** Implementations must not reject after making the final key visible. */
  publishTemporary(
    temporaryKey: TemporaryObjectKey,
    finalKey: FinalObjectKey,
    expectation: PublishExpectation,
  ): Promise<PublishResult>;
  open(key: ObjectKey): Promise<OpenedStoredObject | null>;
  stat(key: ObjectKey): Promise<StoredObjectStat | null>;
  delete(key: ObjectKey): Promise<void>;
}

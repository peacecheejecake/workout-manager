import { describe, expect, it, vi } from 'vitest';
import type { Database, Transaction } from '../src/database.js';
import { TenantErasedError } from '../src/database.js';
import {
  createGalleryAlbumIn,
  renameGalleryAlbumIn,
  deleteGalleryAlbumIn,
  createGalleryAlbumCommandRepository,
  GalleryAlbumCommandError,
} from '../src/gallery-album-commands.js';
const owner = 'synthetic-owner';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const key = 'synthetic-key-001';
const title = '합성 앨범';
function album(revision = 1) {
  return {
    schemaVersion: 1,
    id,
    title,
    revision,
    createdAt: '2026-10-09T00:00:00.000001Z',
    updatedAt: '2026-10-09T00:00:00.000002Z',
  };
}
function fixture(result: unknown = album(), athleteId = owner) {
  const query = vi
    .fn<Transaction['query']>()
    .mockResolvedValue({ rows: [{ result }], rowCount: 1 });
  return { tx: { athleteId, query } satisfies Transaction, query };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
// Boundary transport stubs are not PostgreSQL, RLS, consent, installation or restore acceptance.
describe('Gallery album command transaction adapter', () => {
  it('binds create JSON and the original key to one fixed RPC and returns the original receipt DTO', async () => {
    const { tx, query } = fixture();
    expect(await createGalleryAlbumIn(tx, { title }, key)).toEqual(album());
    expect(query).toHaveBeenCalledExactlyOnceWith(
      'SELECT public.create_gallery_album_v1($1::jsonb,$2::text) AS result',
      [JSON.stringify({ title }), key],
    );
  });
  it('keeps title values out of SQL and snapshots caller data before an asynchronous response', async () => {
    const command = { title: "x'); DROP TABLE gallery_album; --" };
    const { tx, query } = fixture();
    const pending = deferred<Awaited<ReturnType<Transaction['query']>>>();
    query.mockReturnValue(pending.promise);
    const call = createGalleryAlbumIn(tx, command, key);
    const original = command.title;
    command.title = '다른 값';
    pending.resolve({ rows: [{ result: { ...album(), title: original } }], rowCount: 1 });
    expect((await call).title).toBe(original);
    expect(query.mock.calls[0]?.[0]).not.toContain('DROP');
    expect(query.mock.calls[0]?.[1]).toEqual([JSON.stringify({ title: original }), key]);
  });
  it('rejects malformed input, forged ownership, unsafe getters and keys without a command query', async () => {
    const { tx, query } = fixture();
    const getter = vi.fn(() => title);
    const hostile = Object.defineProperty({}, 'title', { get: getter, enumerable: true });
    for (const raw of [{ title, athleteId: owner }, { title: '' }, hostile, null])
      await expect(createGalleryAlbumIn(tx, raw, key)).rejects.toMatchObject({
        code: 'INVALID_GALLERY_ALBUM_COMMAND',
      });
    for (const rawKey of ['', "x');SELECT", 'x'.repeat(129)])
      await expect(createGalleryAlbumIn(tx, { title }, rawKey)).rejects.toMatchObject({
        code: 'INVALID_GALLERY_ALBUM_COMMAND',
      });
    expect(getter).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects missing or accessor tenant context before SQL', async () => {
    const { tx, query } = fixture(album(), ' ');
    await expect(createGalleryAlbumIn(tx, { title }, key)).rejects.toMatchObject({
      code: 'INVALID_GALLERY_ALBUM_CONTEXT',
    });
    const getter = vi.fn(() => owner);
    const context = { athleteId: owner, query };
    Object.defineProperty(context, 'athleteId', { get: getter });
    await expect(createGalleryAlbumIn(context, { title }, key)).rejects.toMatchObject({
      code: 'INVALID_GALLERY_ALBUM_CONTEXT',
    });
    expect(getter).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it('validates rename correlation while allowing an original receipt older than the current head', async () => {
    const { tx, query } = fixture(album(2));
    const command = { albumId: id, expectedRevision: 1, title };
    const first = await renameGalleryAlbumIn(tx, command, key);
    const replay = await renameGalleryAlbumIn(tx, command, key);
    expect(first).toEqual(album(2));
    expect(replay).toEqual(first);
    expect(query.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [
        'SELECT public.rename_gallery_album_v1($1::jsonb,$2::text) AS result',
        [JSON.stringify(command), key],
      ]),
    );
  });
  it('returns deletion receipt and detached count without live media or album reads', async () => {
    const receipt = {
      schemaVersion: 1,
      status: 'deleted',
      albumId: id,
      revision: 4,
      detachedMediaCount: 2,
    };
    const { tx, query } = fixture(receipt);
    expect(await deleteGalleryAlbumIn(tx, { albumId: id, expectedRevision: 3 }, key)).toEqual(
      receipt,
    );
    expect(query).toHaveBeenCalledExactlyOnceWith(
      'SELECT public.delete_gallery_album_v1($1::jsonb,$2::text) AS result',
      [JSON.stringify({ albumId: id, expectedRevision: 3 }), key],
    );
  });
  it('rejects mismatched identity, revision, title and invalid timestamps instead of manufacturing replies', async () => {
    for (const result of [
      { ...album(2), id: other },
      album(3),
      { ...album(2), title: '다른 제목' },
      { ...album(2), createdAt: '2026-10-10T00:00:00Z' },
      { ...album(2), storageRef: 'private' },
    ]) {
      const { tx } = fixture(result);
      await expect(
        renameGalleryAlbumIn(tx, { albumId: id, expectedRevision: 1, title }, key),
      ).rejects.toMatchObject({ code: 'INVALID_GALLERY_ALBUM_REPLY' });
    }
    const { tx } = fixture({
      schemaVersion: 1,
      status: 'deleted',
      albumId: other,
      revision: 2,
      detachedMediaCount: 0,
    });
    await expect(
      deleteGalleryAlbumIn(tx, { albumId: id, expectedRevision: 1 }, key),
    ).rejects.toMatchObject({ code: 'INVALID_GALLERY_ALBUM_REPLY' });
  });
  it('accepts driver QueryResult metadata/prototype without reading metadata accessors', async () => {
    class DriverResult {
      rows = [{ result: album() }];
      rowCount = 1;
      command = 'SELECT';
      oid = null;
      fields = [{ name: 'result', dataTypeID: 3802 }];
      rowAsArray = false;
      _parsers = [
        () => {
          throw Error('metadata parser must not run');
        },
      ];
    }
    const envelope = new DriverResult();
    const getter = vi.fn(() => {
      throw Error('metadata accessor must not run');
    });
    Object.defineProperty(envelope, '_types', { get: getter, enumerable: true });
    const { tx, query } = fixture();
    query.mockResolvedValue(envelope);
    expect(await createGalleryAlbumIn(tx, { title }, key)).toEqual(album());
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects row extra columns and result getters inside an otherwise valid driver envelope', async () => {
    const { tx, query } = fixture();
    query.mockResolvedValue({
      rows: [{ result: album(), privateColumn: 'not a DTO' }],
      rowCount: 1,
    });
    await expect(createGalleryAlbumIn(tx, { title }, key)).rejects.toMatchObject({
      code: 'INVALID_GALLERY_ALBUM_REPLY',
    });
    const getter = vi.fn(() => album());
    const row = Object.defineProperty({}, 'result', { get: getter, enumerable: true });
    query.mockResolvedValue({ rows: [row], rowCount: 1 });
    await expect(createGalleryAlbumIn(tx, { title }, key)).rejects.toMatchObject({
      code: 'INVALID_GALLERY_ALBUM_REPLY',
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects zero/multiple/nonselect/accessor result envelopes without invoking getters', async () => {
    const getter = vi.fn(() => album());
    const hostile = Object.defineProperty({}, 'result', { get: getter, enumerable: true });
    for (const envelope of [
      { rows: [], rowCount: 0 },
      { rows: [{ result: album() }, { result: album() }], rowCount: 2 },
      { rows: [{ result: album() }], rowCount: null },
      { rows: [hostile], rowCount: 1 },
    ]) {
      const { tx, query } = fixture();
      query.mockResolvedValue(envelope);
      await expect(createGalleryAlbumIn(tx, { title }, key)).rejects.toMatchObject({
        code: 'INVALID_GALLERY_ALBUM_REPLY',
      });
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    'ALBUM_NOT_FOUND',
    'ALBUM_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'MEDIA_ACCESS_CONFLICT',
    'GALLERY_ALBUM_DETACH_LIMIT',
    'ACCOUNT_ERASED',
  ])('preserves finite database domain error %s without retries', async (code) => {
    const { tx, query } = fixture();
    query.mockRejectedValue(Object.assign(new Error(code), { code: 'P0001' }));
    await expect(createGalleryAlbumIn(tx, { title }, key)).rejects.toMatchObject({
      code,
      message: code,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each(['42883', '42P01', '42501'])(
    'makes missing draft capability %s unavailable with no fallback',
    async (code) => {
      const { tx, query } = fixture();
      query.mockRejectedValue(Object.assign(new Error('private URL/raw query secret'), { code }));
      const error = await createGalleryAlbumIn(tx, { title }, key).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(GalleryAlbumCommandError);
      expect(error).toMatchObject({
        code: 'GALLERY_ALBUM_COMMAND_UNAVAILABLE',
        message: 'GALLERY_ALBUM_COMMAND_UNAVAILABLE',
      });
      expect(error).not.toHaveProperty('cause');
      expect(query).toHaveBeenCalledTimes(1);
    },
  );
  it('sanitizes arbitrary error text and ignores hostile error getters', async () => {
    const getter = vi.fn(() => 'P0001');
    const error = Object.defineProperty({}, 'code', { get: getter });
    const { tx, query } = fixture();
    query.mockRejectedValue(error);
    await expect(createGalleryAlbumIn(tx, { title }, key)).rejects.toMatchObject({
      code: 'GALLERY_ALBUM_COMMAND_FAILED',
    });
    expect(getter).not.toHaveBeenCalled();
    query.mockRejectedValue(
      Object.assign(new Error('ALBUM_CONFLICT raw secret'), { code: 'P0001' }),
    );
    await expect(createGalleryAlbumIn(tx, { title }, key)).rejects.toMatchObject({
      message: 'GALLERY_ALBUM_COMMAND_FAILED',
    });
  });
  it('delegates only the authenticated owner and waits for the owning transaction commit', async () => {
    const { tx } = fixture();
    const commit = deferred<boolean>();
    let scope = '';
    let done = false;
    const database: Pick<Database, 'tenant'> = {
      async tenant<T>(athleteId: string, action: (transaction: Transaction) => Promise<T>) {
        scope = athleteId;
        const value = await action(tx);
        await commit.promise;
        return value;
      },
    };
    const repository = createGalleryAlbumCommandRepository(database);
    const pending = repository.createAlbum(owner, { title }, key).then((result) => {
      done = true;
      return result;
    });
    await Promise.resolve();
    expect(scope).toBe(owner);
    expect(done).toBe(false);
    commit.resolve(true);
    expect(await pending).toEqual(album());
  });
  it('rejects transaction owner mismatch and rolls malformed reply through the tenant boundary', async () => {
    const { tx, query } = fixture(album(), 'foreign-owner');
    let callbacks = 0;
    const database: Pick<Database, 'tenant'> = {
      async tenant<T>(_owner: string, action: (transaction: Transaction) => Promise<T>) {
        callbacks++;
        return action(tx);
      },
    };
    const repository = createGalleryAlbumCommandRepository(database);
    await expect(
      repository.renameAlbum(owner, { albumId: id, expectedRevision: 1, title }, key),
    ).rejects.toMatchObject({ code: 'INVALID_GALLERY_ALBUM_CONTEXT' });
    expect(query).not.toHaveBeenCalled();
    expect(callbacks).toBe(1);
    const correct = fixture({ ...album(), title: 'mismatched' });
    let rejected = false;
    const failed: Pick<Database, 'tenant'> = {
      async tenant<T>(_owner: string, action: (transaction: Transaction) => Promise<T>) {
        try {
          return await action(correct.tx);
        } catch (error) {
          rejected = true;
          throw error;
        }
      },
    };
    await expect(
      createGalleryAlbumCommandRepository(failed).createAlbum(owner, { title }, key),
    ).rejects.toMatchObject({ code: 'INVALID_GALLERY_ALBUM_REPLY' });
    expect(rejected).toBe(true);
  });
  it('preserves tenant erasure while discarding outer transaction failures', async () => {
    let failure: Error = new TenantErasedError();
    const database: Pick<Database, 'tenant'> = {
      async tenant<T>(): Promise<T> {
        throw failure;
      },
    };
    const repository = createGalleryAlbumCommandRepository(database);
    await expect(
      repository.deleteAlbum(owner, { albumId: id, expectedRevision: 1 }, key),
    ).rejects.toMatchObject({ code: 'ACCOUNT_ERASED' });
    failure = new Error('raw transport address');
    await expect(
      repository.deleteAlbum(owner, { albumId: id, expectedRevision: 1 }, key),
    ).rejects.toMatchObject({ code: 'GALLERY_ALBUM_COMMAND_FAILED' });
  });
});

// QueryResult fixtures validate the adapter boundary, not real PostgreSQL grants or deletion.
describe('Gallery deletion command larger scalar count reply', () => {
  it.each([1001, 2147483647])(
    'returns count %i with original command/key and no follow-up media reads',
    async (count) => {
      const receipt = {
        schemaVersion: 1,
        status: 'deleted',
        albumId: id,
        revision: 4,
        detachedMediaCount: count,
      };
      const { tx, query } = fixture(receipt);
      expect(await deleteGalleryAlbumIn(tx, { albumId: id, expectedRevision: 3 }, key)).toEqual(
        receipt,
      );
      expect(query).toHaveBeenCalledExactlyOnceWith(
        'SELECT public.delete_gallery_album_v1($1::jsonb,$2::text) AS result',
        [JSON.stringify({ albumId: id, expectedRevision: 3 }), key],
      );
    },
  );
  it('rejects overflowing or non-integral count and stale identity/revision instead of returning a receipt', async () => {
    const receipt = {
      schemaVersion: 1,
      status: 'deleted',
      albumId: id,
      revision: 4,
      detachedMediaCount: 1001,
    };
    for (const result of [
      { ...receipt, detachedMediaCount: 2147483648 },
      { ...receipt, detachedMediaCount: -1 },
      { ...receipt, detachedMediaCount: 0.5 },
      { ...receipt, albumId: other },
      { ...receipt, revision: 5 },
      { ...receipt, items: [] },
    ]) {
      const { tx, query } = fixture(result);
      await expect(
        deleteGalleryAlbumIn(tx, { albumId: id, expectedRevision: 3 }, key),
      ).rejects.toMatchObject({ code: 'INVALID_GALLERY_ALBUM_REPLY' });
      expect(query).toHaveBeenCalledTimes(1);
    }
  });
});

import { useId } from 'react';
import {
  galleryAlbumCreateCommandV1Schema,
  galleryAlbumDeleteCommandV1Schema,
  galleryAlbumRenameCommandV1Schema,
  type GalleryAlbumCreateCommandV1,
  type GalleryAlbumDeleteCommandV1,
  type GalleryAlbumListPageV1,
  type GalleryAlbumListQueryV1,
  type GalleryAlbumRenameCommandV1,
  type GalleryAlbumV1,
} from '@workout/contracts/gallery-navigation-v2';
import styles from './gallery-albums.module.css';

export type GalleryAlbumsResult =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'conflict' }
  | { state: 'unavailable' }
  | { state: 'ready'; page: GalleryAlbumListPageV1 };
export type GalleryAlbumOperation =
  | { state: 'idle' }
  | {
      state: 'submitting' | 'uncertain' | 'error' | 'conflict';
      kind: 'create' | 'rename' | 'delete';
    };
export interface GalleryAlbumDeleteTarget {
  /** Frozen selection snapshot; the parent owns freshness and receipt verification. */
  album: GalleryAlbumV1;
  detachedMediaCount: number | null;
}
export interface GalleryAlbumsActions {
  changeCreateTitle: (title: string) => void;
  changeRenameTitle: (title: string) => void;
  beginRename: (album: GalleryAlbumV1) => void;
  cancelRename: () => void;
  requestDelete: (album: GalleryAlbumV1) => void;
  cancelDelete: () => void;
  create: (command: GalleryAlbumCreateCommandV1) => void;
  rename: (command: GalleryAlbumRenameCommandV1) => void;
  delete: (command: GalleryAlbumDeleteCommandV1) => void;
  navigate: (query: GalleryAlbumListQueryV1) => void;
  /** Read/reconcile through the owning controller; never an automatic mutation retry. */
  reload: () => void;
}
export interface GalleryAlbumsProps {
  createTitle: string;
  renameDraft: GalleryAlbumRenameCommandV1 | null;
  deleteTarget: GalleryAlbumDeleteTarget | null;
  result: GalleryAlbumsResult;
  operation: GalleryAlbumOperation;
  actions: GalleryAlbumsActions | null;
}
const operationLabels = { create: '앨범 만들기', rename: '앨범 이름 변경', delete: '앨범 삭제' };

/** Controlled album presentation; it neither requests data nor owns mutation receipts. */
export function GalleryAlbums({
  createTitle,
  renameDraft,
  deleteTarget,
  result,
  operation,
  actions,
}: GalleryAlbumsProps) {
  const id = useId();
  const unavailable = actions === null || result.state === 'unavailable';
  const pending = operation.state === 'submitting' || operation.state === 'uncertain';
  const locked = unavailable || pending;
  const writesBlocked =
    locked ||
    operation.state === 'conflict' ||
    result.state === 'loading' ||
    result.state === 'conflict';
  const page = result.state === 'ready' ? result.page : null;
  const create = galleryAlbumCreateCommandV1Schema.safeParse({ title: createTitle });
  const rename = galleryAlbumRenameCommandV1Schema.safeParse(renameDraft);
  const deletion = galleryAlbumDeleteCommandV1Schema.safeParse(
    deleteTarget === null
      ? null
      : {
          albumId: deleteTarget.album.id,
          expectedRevision: deleteTarget.album.revision,
        },
  );
  const count = deleteTarget?.detachedMediaCount;
  const countKnown = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  return (
    <section
      className={styles.albums}
      aria-label="앨범 관리"
      aria-busy={result.state === 'loading' || operation.state === 'submitting'}
    >
      <form
        className={styles.panel}
        onSubmit={(event) => {
          event.preventDefault();
          if (!writesBlocked && create.success) actions?.create(create.data);
        }}
      >
        <h2>앨범 만들기</h2>
        <label htmlFor={`${id}-create`}>새 앨범 제목</label>
        <input
          id={`${id}-create`}
          value={createTitle}
          disabled={locked}
          onChange={(event) => {
            if (!locked) actions?.changeCreateTitle(event.currentTarget.value);
          }}
        />
        <p>제목을 입력한 뒤 만들기를 눌러 저장하세요.</p>
        <button type="submit" disabled={writesBlocked || !create.success}>
          앨범 만들기
        </button>
      </form>
      {unavailable ? (
        <p role="status">
          이 환경에서는 앨범 관리 연결을 사용할 수 없습니다. 작성한 제목은 유지됩니다.
        </p>
      ) : null}
      {result.state === 'loading' ? <p role="status">앨범 페이지를 불러오는 중입니다.</p> : null}
      {result.state === 'error' || result.state === 'conflict' ? (
        <div role="alert" className={styles.panel}>
          <p>
            {result.state === 'conflict'
              ? '앨범 목록이 변경되어 이 페이지를 계속 탐색할 수 없습니다.'
              : '앨범 페이지를 불러오지 못했습니다.'}{' '}
            작성한 제목은 유지됩니다.
          </p>
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              if (!locked) actions?.reload();
            }}
          >
            앨범 목록 다시 불러오기
          </button>
        </div>
      ) : null}
      {operation.state !== 'idle' ? (
        <div className={styles.panel} role={operation.state === 'submitting' ? 'status' : 'alert'}>
          {operation.state === 'submitting' ? (
            <p>{operationLabels[operation.kind]} 요청을 처리하는 중입니다.</p>
          ) : null}
          {operation.state === 'error' ? (
            <p>
              {operationLabels[operation.kind]} 요청에 실패했습니다. 작성한 제목과 대상은
              유지됩니다.
            </p>
          ) : null}
          {operation.state === 'conflict' ? (
            <>
              <p>
                선택한 앨범이 변경되었습니다. 제목은 유지됩니다. 목록을 다시 불러오고 대상을 다시
                선택해 최신 상태를 확인하세요.
              </p>
              <p>
                조회된 리비전만으로 현재 저장 상태를 확정하지 않습니다. 확인 전에는 이전 요청을 다시
                보내지 않습니다.
              </p>
              <button
                type="button"
                disabled={unavailable}
                onClick={() => {
                  if (!unavailable) actions?.reload();
                }}
              >
                변경된 앨범 다시 확인하기
              </button>
            </>
          ) : null}
          {operation.state === 'uncertain' ? (
            <>
              <p>
                서버 처리 결과를 아직 확인하지 못했습니다. 제목과 대상은 유지됩니다. 결과를 확인하기
                전에는 편집하거나 다시 보내지 않습니다.
              </p>
              <button
                type="button"
                disabled={unavailable}
                onClick={() => {
                  if (!unavailable) actions?.reload();
                }}
              >
                처리 결과 확인
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {page !== null ? (
        <div className={styles.panel}>
          <h2>현재 앨범 페이지</h2>
          <p>이 페이지에 {page.items.length}개 · 전체 앨범 수는 알 수 없습니다.</p>
          <p>{page.hasMore ? '다음 페이지가 있습니다.' : '이 조회의 마지막 페이지입니다.'}</p>
          {page.items.length === 0 ? (
            <p>현재 페이지에 앨범이 없습니다.</p>
          ) : (
            <ul className={styles.list}>
              {page.items.map((album) => (
                <li key={album.id}>
                  <h3>{album.title}</h3>
                  <p>조회된 리비전 {album.revision}</p>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      disabled={locked}
                      aria-label={`${album.title} 이름 변경`}
                      onClick={() => {
                        if (!locked) actions?.beginRename(album);
                      }}
                    >
                      이름 변경
                    </button>
                    <button
                      type="button"
                      disabled={locked}
                      aria-label={`${album.title} 삭제 대상 선택`}
                      onClick={() => {
                        if (!locked) actions?.requestDelete(album);
                      }}
                    >
                      삭제 대상 선택
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            disabled={locked || page.nextCursor === null}
            onClick={() => {
              if (!locked && page.nextCursor !== null)
                actions?.navigate({ ...page.query, cursor: page.nextCursor });
            }}
          >
            다음 앨범 페이지
          </button>
        </div>
      ) : null}
      {renameDraft !== null ? (
        <form
          className={styles.panel}
          aria-label="앨범 이름 변경"
          onSubmit={(event) => {
            event.preventDefault();
            if (!writesBlocked && rename.success) actions?.rename(rename.data);
          }}
        >
          <h2>선택한 앨범 이름 변경</h2>
          <p>
            앨범 ID {renameDraft.albumId} · 선택한 리비전 {renameDraft.expectedRevision}
          </p>
          <label htmlFor={`${id}-rename`}>변경할 앨범 제목</label>
          <input
            id={`${id}-rename`}
            value={renameDraft.title}
            disabled={locked}
            onChange={(event) => {
              if (!locked) actions?.changeRenameTitle(event.currentTarget.value);
            }}
          />
          {!rename.success ? (
            <p role="alert">변경할 제목과 선택한 앨범 정보를 확인하세요.</p>
          ) : null}
          <div className={styles.actions}>
            <button type="submit" disabled={writesBlocked || !rename.success}>
              앨범 이름 저장
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                if (!locked) actions?.cancelRename();
              }}
            >
              이름 변경 취소
            </button>
          </div>
        </form>
      ) : null}
      {deleteTarget !== null ? (
        <section className={styles.panel} aria-label="앨범 삭제 확인">
          <h2>앨범 삭제 확인</h2>
          <p>삭제 대상: {deleteTarget.album.title}</p>
          <p>
            앨범 ID {deleteTarget.album.id} · 선택한 리비전 {deleteTarget.album.revision}
          </p>
          <p>이 앨범과의 미디어 연결이 해제됩니다. 미디어 원본 파일은 삭제하지 않습니다.</p>
          <p>{countKnown ? `연결 해제 대상 ${count}개` : '연결 해제 대상 수는 알 수 없습니다.'}</p>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={writesBlocked || !deletion.success}
              onClick={() => {
                if (!writesBlocked && deletion.success) actions?.delete(deletion.data);
              }}
            >
              이 앨범 삭제 확인
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                if (!locked) actions?.cancelDelete();
              }}
            >
              앨범 삭제 취소
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}

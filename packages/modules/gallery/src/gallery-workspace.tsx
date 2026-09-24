'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  GALLERY_IMAGE_MAX_BYTES,
  GALLERY_VIDEO_MAX_BYTES,
  galleryMediaKindOf,
  galleryMediaTypeSchema,
  type GalleryMediaItem,
  type GalleryMediaKind,
  type GalleryMediaType,
} from '@workout/contracts/gallery';
import { createGalleryApi, GalleryRequestError } from './gallery-api';
import { readableGalleryError } from './gallery-errors';
import { deduplicateById, nextGalleryOffset } from './gallery-paging';
import { MediaPreview } from './media-preview';
import type { GalleryMediaTransfer } from './media-transfer';
import styles from './gallery.module.css';

export type {
  GalleryMediaOpenInput,
  GalleryMediaTransfer,
  GalleryMediaUploadInput,
} from './media-transfer';

export interface GalleryWorkspaceProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  mediaTransfer?: GalleryMediaTransfer;
  mediaItemId?: string | null;
  mediaKind?: GalleryMediaKind | null;
  album?: string | null;
}

type UploadStage = 'idle' | 'reserving' | 'uploading' | 'finalizing';

const FILE_ACCEPT =
  '.jpg,.jpeg,.png,.webp,.mp4,.webm,image/jpeg,image/png,image/webp,video/mp4,video/webm';
const byteFormatter = new Intl.NumberFormat('ko-KR');
const PAGE_SIZE = 50;

export function GalleryWorkspace(props: GalleryWorkspaceProps) {
  return <Lifetime key={`${props.athleteId}:${props.sessionId}`} {...props} />;
}

function Lifetime(props: GalleryWorkspaceProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <Workspace {...props} />
    </QueryClientProvider>
  );
}

function resolveMediaType(file: File): GalleryMediaType | null {
  const parsed = galleryMediaTypeSchema.safeParse(file.type.trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}

function Workspace({
  athleteId,
  sessionId,
  transport,
  mediaTransfer,
  mediaItemId = null,
  mediaKind = null,
  album = null,
}: GalleryWorkspaceProps) {
  const api = useMemo(() => createGalleryApi(transport), [transport]);
  const queryClient = useQueryClient();
  const scope = useMemo(
    () => ['users', athleteId, 'sessions', sessionId, 'gallery'] as const,
    [athleteId, sessionId],
  );
  const listQueryKey = useMemo(
    () => [...scope, 'list', mediaKind, album] as const,
    [scope, mediaKind, album],
  );
  const list = useInfiniteQuery({
    queryKey: listQueryKey,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api.list(
        {
          limit: PAGE_SIZE,
          offset: pageParam,
          ...(mediaKind ? { mediaKind } : {}),
          ...(album ? { album } : {}),
        },
        signal,
      ),
    getNextPageParam: nextGalleryOffset,
  });
  // A deleted item is removed from the cache rather than refetched: a refetch
  // would 404 while TanStack Query keeps the previous payload, leaving deleted
  // media and its blob URL on screen behind an error message.
  const [deletedMediaIds, setDeletedMediaIds] = useState<ReadonlySet<string>>(() => new Set());
  const detailDeleted = mediaItemId !== null && deletedMediaIds.has(mediaItemId);
  const detail = useQuery({
    queryKey: [...scope, 'detail', mediaItemId],
    queryFn: ({ signal }) => api.read(mediaItemId ?? '', signal),
    enabled: mediaItemId !== null && !detailDeleted,
  });

  const [stage, setStage] = useState<UploadStage>('idle');
  const [progress, setProgress] = useState<{ uploaded: number; total: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const submitButton = useRef<HTMLButtonElement | null>(null);
  const [retryFocusToken, setRetryFocusToken] = useState(0);
  const pendingRetryFocus = useRef(false);
  const captionInput = useRef<HTMLInputElement | null>(null);
  const albumInput = useRef<HTMLInputElement | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  // Runs after the idle stage is committed, so the control is enabled and can
  // actually take focus.
  useEffect(() => {
    if (!pendingRetryFocus.current || stage !== 'idle') return;
    // Consume the request: a later successful upload must not pull focus back
    // from wherever the user moved while it ran.
    pendingRetryFocus.current = false;
    submitButton.current?.focus();
  }, [retryFocusToken, stage]);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!mediaTransfer) throw new Error('MEDIA_TRANSFER_UNAVAILABLE');
      const mediaType = resolveMediaType(file);
      if (mediaType === null) throw new GalleryRequestError(415, 'UNSUPPORTED_FILE_TYPE');
      const kind = galleryMediaKindOf(mediaType);
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setStage('reserving');
      setProgress(null);
      const reservation = await api.reserveUpload({
        mediaKind: kind,
        album: albumInput.current?.value.trim() ? albumInput.current.value.trim() : null,
        caption: captionInput.current?.value.trim() ? captionInput.current.value.trim() : null,
        activityId: null,
        capturedAt: null,
        capturedLocalDate: null,
        idempotencyKey: crypto.randomUUID(),
      });
      setStage('uploading');
      await mediaTransfer.upload({
        uploadId: reservation.uploadId,
        file,
        mediaType,
        signal: controller.signal,
        onProgress: (uploaded, total) => setProgress({ uploaded, total }),
      });
      setStage('finalizing');
      return api.finalizeUpload(reservation.uploadId);
    },
    onSuccess: async () => {
      setStage('idle');
      setProgress(null);
      setUploadError(null);
      if (fileInput.current) fileInput.current.value = '';
      await queryClient.invalidateQueries({ queryKey: listQueryKey });
    },
    onError: (error) => {
      setStage('idle');
      setProgress(null);
      setUploadError(readableGalleryError(error));
      // The submit control is disabled while the upload runs, so focus is lost
      // on failure. Request a return instead of focusing here: React has not
      // committed the enabled control yet and a disabled element cannot take
      // focus in a real browser.
      pendingRetryFocus.current = true;
      setRetryFocusToken((token) => token + 1);
    },
  });

  const remove = useMutation({
    mutationFn: (item: GalleryMediaItem) =>
      api.delete(item.id, {
        expectedAccessRevision: item.accessRevision,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async (result) => {
      setDeletedMediaIds((current) => new Set(current).add(result.mediaItemId));
      queryClient.removeQueries({
        queryKey: [...scope, 'detail', result.mediaItemId],
        exact: true,
      });
      await queryClient.invalidateQueries({ queryKey: listQueryKey });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFileError(null);
    const file = fileInput.current?.files?.[0];
    if (!file) {
      setFileError('업로드할 사진 또는 동영상을 선택하세요.');
      fileInput.current?.focus();
      return;
    }
    upload.mutate(file);
  }

  // Offset pages can shift when another device inserts or deletes while pages
  // are being appended. Identity, not position, decides what is shown: the
  // first copy of an id wins and any mutation invalidates the whole list so
  // every loaded page is refetched together. First-wins means a later page
  // carrying a newer revision of the same id is ignored until that refetch.
  // A stable cursor contract remains the follow-up and is recorded in
  // docs/implementation/progress/M2-03.md.
  // A failed list refetch keeps the previous pages in the query cache. Showing
  // them would keep a deleted item's thumbnail and blob URL on screen, so only
  // a successful read may be rendered, the same rule the detail panel follows.
  // A confirmed unreadable detail hides the matching card at once. Waiting for
  // the list refetch would keep a deleted item's thumbnail and blob URL on
  // screen for the whole in-flight window.
  const detailUnreadable =
    mediaItemId !== null &&
    (detailDeleted ||
      (detail.isError &&
        detail.error instanceof GalleryRequestError &&
        detail.error.status === 404) ||
      (detail.isSuccess && detail.data.status === 'unavailable'));
  const hidden = (id: string) =>
    deletedMediaIds.has(id) || (detailUnreadable && id === mediaItemId);
  const items = list.isSuccess
    ? deduplicateById(list.data.pages.flatMap((page) => page.items)).filter(
        (item) => !hidden(item.id),
      )
    : [];
  const total = list.isSuccess ? (list.data.pages.at(-1)?.total ?? 0) : 0;
  const pending = stage !== 'idle';

  return (
    <section className={styles.workspace} aria-label="갤러리 작업 공간">
      <header className={styles.header}>
        <p className={styles.eyebrow}>비공개 갤러리</p>
        <h1>사진 · 동영상</h1>
        <p className={styles.meta}>
          모든 미디어는 본인만 볼 수 있습니다. 갤러리 열람은 AI 전송 동의와 별개이며, 이 화면은
          원본만 저장하고 자동 변환이나 썸네일 생성을 하지 않습니다.
        </p>
        <nav className={styles.filters} aria-label="미디어 종류 필터">
          <a href="/gallery" aria-current={mediaKind === null ? 'page' : undefined}>
            전체
          </a>
          <a
            href="/gallery?mediaKind=image"
            aria-current={mediaKind === 'image' ? 'page' : undefined}
          >
            사진
          </a>
          <a
            href="/gallery?mediaKind=video"
            aria-current={mediaKind === 'video' ? 'page' : undefined}
          >
            동영상
          </a>
        </nav>
      </header>

      <section className={styles.panel} aria-labelledby="gallery-upload-heading">
        <h2 id="gallery-upload-heading">미디어 올리기</h2>
        <form className={styles.form} onSubmit={submit}>
          <label htmlFor="gallery-file">파일</label>
          <input
            id="gallery-file"
            ref={fileInput}
            type="file"
            accept={FILE_ACCEPT}
            disabled={pending}
          />
          <label htmlFor="gallery-album">앨범 (선택)</label>
          <input
            id="gallery-album"
            ref={albumInput}
            type="text"
            maxLength={100}
            disabled={pending}
          />
          <label htmlFor="gallery-caption">설명 (선택)</label>
          <input
            id="gallery-caption"
            ref={captionInput}
            type="text"
            maxLength={500}
            disabled={pending}
          />
          <p className={styles.hint}>
            JPEG · PNG · WebP 사진은 {byteFormatter.format(GALLERY_IMAGE_MAX_BYTES)} 바이트, MP4 ·
            WebM 동영상은 {byteFormatter.format(GALLERY_VIDEO_MAX_BYTES)} 바이트까지 허용합니다.
          </p>
          <div className={styles.actions}>
            <button ref={submitButton} type="submit" disabled={pending || !mediaTransfer}>
              올리기
            </button>
            {pending ? (
              <span role="status" className={styles.status}>
                {stage === 'reserving'
                  ? '업로드 준비 중'
                  : stage === 'uploading'
                    ? '업로드 중'
                    : '저장 확정 중'}
              </span>
            ) : null}
          </div>
          {progress ? (
            <progress
              aria-label="업로드 진행률"
              value={progress.uploaded}
              max={progress.total || 1}
            />
          ) : null}
          {mediaTransfer ? null : (
            <p role="status" className={styles.hint}>
              이 환경에서는 파일 전송을 사용할 수 없습니다.
            </p>
          )}
          {fileError ? <p role="alert">{fileError}</p> : null}
          {uploadError ? <p role="alert">{uploadError}</p> : null}
        </form>
      </section>

      <section className={styles.panel} aria-labelledby="gallery-list-heading">
        <h2 id="gallery-list-heading">보관한 미디어</h2>
        {list.isPending ? <p role="status">갤러리를 불러오는 중입니다.</p> : null}
        {list.isError ? (
          <p role="alert">
            갤러리를 불러오지 못했습니다.{' '}
            <button onClick={() => void list.refetch()}>다시 시도</button>
          </p>
        ) : null}
        {list.isSuccess && items.length === 0 ? (
          <p role="status">아직 저장한 사진이나 동영상이 없습니다.</p>
        ) : null}
        {list.isSuccess && items.length > 0 && total > items.length ? (
          <p role="status" className={styles.status}>
            전체 {total}개 중 {items.length}개를 표시했습니다.
          </p>
        ) : null}
        <ul className={styles.grid}>
          {items.map((item) => (
            <li key={item.id}>
              <article
                className={styles.card}
                aria-current={item.id === mediaItemId ? 'page' : undefined}
              >
                <h3>
                  <a href={`/gallery/${item.id}`}>{item.caption ?? item.file.originalFileName}</a>
                </h3>
                <MediaPreview item={item} transfer={mediaTransfer} />
                <dl className={styles.factList}>
                  <div>
                    <dt>종류</dt>
                    <dd>{item.mediaKind === 'image' ? '사진' : '동영상'}</dd>
                  </div>
                  <div>
                    <dt>앨범</dt>
                    <dd>{item.album ?? '지정 안 됨'}</dd>
                  </div>
                  <div>
                    <dt>촬영 시각</dt>
                    <dd>{item.capturedAt ?? '알 수 없음'}</dd>
                  </div>
                  <div>
                    <dt>크기</dt>
                    <dd>{byteFormatter.format(item.file.byteSize)} 바이트</dd>
                  </div>
                </dl>
                <div className={styles.actions}>
                  <button
                    type="button"
                    onClick={() => remove.mutate(item)}
                    disabled={remove.isPending}
                  >
                    삭제
                  </button>
                </div>
              </article>
            </li>
          ))}
        </ul>
        {list.isSuccess && list.hasNextPage ? (
          <div className={styles.actions}>
            <button
              type="button"
              onClick={() => void list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
            >
              더 보기
            </button>
            {list.isFetchingNextPage ? (
              <span role="status" className={styles.status}>
                다음 미디어를 불러오는 중
              </span>
            ) : null}
          </div>
        ) : null}
        {remove.isError ? <p role="alert">{readableGalleryError(remove.error)}</p> : null}
      </section>

      {mediaItemId !== null ? (
        <section className={styles.panel} aria-labelledby="gallery-detail-heading">
          <h2 id="gallery-detail-heading">선택한 미디어</h2>
          {detailDeleted ? (
            <p role="status">이 미디어는 삭제되어 더 이상 열람할 수 없습니다.</p>
          ) : (
            <>
              {detail.isPending ? <p role="status">미디어를 불러오는 중입니다.</p> : null}
              {/* A failed refetch keeps the previous payload in the query cache.
                  Rendering it would leave private media and its blob URL on
                  screen after the item became unreadable elsewhere, so only a
                  successful read may be displayed. */}
              {detail.isError ? <p role="alert">{readableGalleryError(detail.error)}</p> : null}
              {detail.isSuccess && detail.data.status === 'unavailable' ? (
                <p role="status">이 미디어는 더 이상 열람할 수 없습니다.</p>
              ) : null}
              {detail.isSuccess && detail.data.status === 'available' ? (
                <MediaPreview item={detail.data.item} transfer={mediaTransfer} variant="original" />
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </section>
  );
}

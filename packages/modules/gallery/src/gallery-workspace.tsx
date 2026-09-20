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
import styles from './gallery.module.css';

export interface GalleryMediaUploadInput {
  uploadId: string;
  file: File;
  mediaType: GalleryMediaType;
  signal: AbortSignal;
  onProgress: (uploadedBytes: number, totalBytes: number) => void;
}

export interface GalleryMediaOpenInput {
  mediaItemId: string;
  variant: 'original' | 'preview';
  signal: AbortSignal;
}

export interface GalleryMediaTransfer {
  upload(input: GalleryMediaUploadInput): Promise<void>;
  /** Resolves to a blob URL the caller owns and revokes. */
  open(input: GalleryMediaOpenInput): Promise<string>;
}

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

// The content PUT runs through the Host file transfer, not the JSON API, so its
// failures arrive as a plain Error carrying the server error code.
const TRANSFER_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_MEDIA_SIGNATURE: '파일 내용이 선언한 형식과 일치하지 않습니다.',
  FILE_TOO_LARGE: '파일이 허용된 크기를 넘었습니다. 사진은 15 MiB, 동영상은 64 MiB까지 저장합니다.',
  UNSUPPORTED_FILE_TYPE: '지원하지 않는 파일 형식입니다.',
  EMPTY_UPLOAD: '빈 파일은 저장할 수 없습니다.',
  CONTENT_LENGTH_MISMATCH: '전송된 크기가 선언한 크기와 다릅니다.',
  UPLOAD_FAILED: '이 업로드는 종료됐습니다. 파일을 다시 선택해 올리세요.',
  UPLOAD_RETRY_REQUIRED: '업로드를 처음부터 다시 시도하세요.',
  UPLOAD_RESUME_REQUIRED: '업로드가 중단됐습니다. 같은 파일로 다시 시도하세요.',
  MEDIA_TRANSFER_UNAVAILABLE: '이 환경에서는 파일 전송을 사용할 수 없습니다.',
};

function readableError(error: unknown) {
  if (error instanceof Error && !(error instanceof GalleryRequestError)) {
    // Exact allowlist membership only: an inherited key such as `constructor`
    // must fall through to the generic message, never reach the render.
    const known = Object.hasOwn(TRANSFER_MESSAGES, error.message)
      ? TRANSFER_MESSAGES[error.message]
      : undefined;
    if (known !== undefined) return known;
  }
  if (!(error instanceof GalleryRequestError)) return '요청을 완료하지 못했습니다.';
  // The same curated allowlist also covers codes the JSON API returns.
  const knownCode = Object.hasOwn(TRANSFER_MESSAGES, error.code)
    ? TRANSFER_MESSAGES[error.code]
    : undefined;
  if (knownCode !== undefined) return knownCode;
  if (error.status === 409) return '다른 변경이 먼저 저장되었습니다. 최신 상태를 다시 확인하세요.';
  if (error.status === 413)
    return `파일이 허용된 크기를 넘었습니다. 사진은 ${byteFormatter.format(
      GALLERY_IMAGE_MAX_BYTES,
    )} 바이트, 동영상은 ${byteFormatter.format(GALLERY_VIDEO_MAX_BYTES)} 바이트까지 저장합니다.`;
  if (error.status === 415) return TRANSFER_MESSAGES['UNSUPPORTED_FILE_TYPE'] ?? '';
  if (error.status === 422) return TRANSFER_MESSAGES['INVALID_MEDIA_SIGNATURE'] ?? '';
  if (error.status === 404) return '미디어를 찾을 수 없거나 열람 권한이 없습니다.';
  return '입력을 확인한 뒤 다시 시도하세요.';
}

function deduplicateById(items: readonly GalleryMediaItem[]): GalleryMediaItem[] {
  const seen = new Set<string>();
  const unique: GalleryMediaItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
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
    getNextPageParam: (lastPage, pages, lastPageParam) => {
      // An insertion or deletion at the head shifts the window, so a page can
      // repeat identities that are already loaded. Advancing by the raw page
      // length would step past identities that were never shown, so the next
      // offset is the number of DISTINCT identities held. This recovers an
      // overlap SMALLER than one page; a whole repeated page adds no new
      // identity and ends the listing, which a stable cursor contract would
      // fix. A page that adds nothing ends the listing rather than re-reading
      // the same window forever.
      if (lastPage.items.length === 0) return undefined;
      const distinct = new Set(pages.flatMap((page) => page.items.map((item) => item.id))).size;
      if (distinct >= lastPage.total || distinct <= lastPageParam) return undefined;
      return distinct;
    },
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
      setUploadError(readableError(error));
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
        {remove.isError ? <p role="alert">{readableError(remove.error)}</p> : null}
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
              {detail.isError ? <p role="alert">{readableError(detail.error)}</p> : null}
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

/**
 * Media bytes load only when the tile enters the viewport, and each blob URL is
 * revoked when the tile unmounts so private media never outlives the session.
 */
function MediaPreview({
  item,
  transfer,
  variant = 'preview',
}: {
  item: GalleryMediaItem;
  transfer: GalleryMediaTransfer | undefined;
  variant?: 'original' | 'preview';
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver !== 'function');
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const resolvedVariant = variant === 'preview' && item.preview === null ? 'original' : variant;

  useEffect(() => {
    const element = container.current;
    if (!element || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !transfer) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let cancelled = false;
    transfer
      .open({ mediaItemId: item.id, variant: resolvedVariant, signal: controller.signal })
      .then((url) => {
        objectUrl = url;
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        setSource(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
      setSource(null);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visible, transfer, item.id, resolvedVariant]);

  const label = item.caption ?? item.file.originalFileName;
  return (
    <div className={styles.media} ref={container}>
      {!transfer ? (
        <p className={styles.hint}>이 환경에서는 미디어를 표시할 수 없습니다.</p>
      ) : failed ? (
        <p role="alert">미디어를 불러오지 못했습니다.</p>
      ) : source === null ? (
        <p role="status">미디어 불러오는 중</p>
      ) : item.mediaKind === 'image' ? (
        <img src={source} alt={label} loading="lazy" decoding="async" />
      ) : (
        <>
          {/* No caption track is generated for user uploaded video in this
              milestone, so the absence is stated below instead of implied by an
              empty track element. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={source} controls preload="none" aria-label={label} />
          <p className={styles.hint}>자막 없음 · 이 화면은 자막을 생성하지 않습니다.</p>
        </>
      )}
    </div>
  );
}

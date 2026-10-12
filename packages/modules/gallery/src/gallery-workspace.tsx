'use client';

import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
import {
  GalleryCourseChoicesRequestError,
  type GalleryCourseChoicesApi,
} from './gallery-course-choices-api';
import type { GalleryCourseChoicesState } from './gallery-navigation';
import { readableGalleryError } from './gallery-errors';
import { deduplicateById, nextGalleryOffset } from './gallery-paging';
import { MediaPreview } from './media-preview';
import { GalleryAlbums } from './gallery-albums';
import { GalleryMediaOrganizer } from './gallery-media-organizer';
import { useGalleryMediaOrganizer } from './use-gallery-media-organizer';
import { GalleryNavigationControls, GalleryNavigationResultFrame } from './gallery-navigation';
import {
  useGalleryNavigationWorkspace,
  type GalleryWorkspaceNavigation,
} from './use-gallery-navigation-workspace';
const MediaViewer = lazy(() =>
  import('./media-viewer').then((module) => ({ default: module.MediaViewer })),
);
import type { GallerySubtitlesReader } from './video-viewer';
export type { GallerySubtitlesReader } from './video-viewer';
import type { GalleryRenditionsReader } from './rendition-status';
export type { GalleryRenditionsReader } from './rendition-status';
export type { GalleryWorkspaceNavigation } from './use-gallery-navigation-workspace';
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
  subtitlesReader?: GallerySubtitlesReader;
  /** Derived-rendition state reader; absent unless the deployment enabled SQL144. */
  renditionsReader?: GalleryRenditionsReader;
  navigation?: GalleryWorkspaceNavigation;
  courseChoicesApi?: GalleryCourseChoicesApi;
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
  subtitlesReader,
  renditionsReader,
  navigation,
  courseChoicesApi,
  mediaItemId = null,
  mediaKind = null,
  album = null,
}: GalleryWorkspaceProps) {
  const [viewerId, setViewerId] = useState<string | null>(null);
  const api = useMemo(() => createGalleryApi(transport), [transport]);
  const queryClient = useQueryClient();
  const scope = useMemo(
    () => ['users', athleteId, 'sessions', sessionId, 'gallery'] as const,
    [athleteId, sessionId],
  );
  const navigationWorkspace = useGalleryNavigationWorkspace(scope, navigation, mediaKind);
  const organizer = useGalleryMediaOrganizer(scope, navigation?.api);
  const courseChoices = useQuery({
    queryKey: [...scope, 'course-choices'],
    enabled: courseChoicesApi !== undefined,
    structuralSharing: false,
    queryFn: async ({ signal }) => {
      if (!courseChoicesApi) throw new GalleryCourseChoicesRequestError('INVALID_INPUT');
      const value = await courseChoicesApi.list(signal);
      if (signal.aborted) throw new GalleryCourseChoicesRequestError('ABORTED');
      return { api: courseChoicesApi, value };
    },
  });
  const previousCourseApi = useRef(courseChoicesApi);
  useEffect(() => {
    if (previousCourseApi.current === courseChoicesApi) return;
    const previous = previousCourseApi.current;
    previousCourseApi.current = courseChoicesApi;
    // Enabling a previously absent capability already starts this observer's
    // query. Do not cancel that first request and start a duplicate read.
    if (previous === undefined) return;
    void queryClient
      .cancelQueries({ queryKey: [...scope, 'course-choices'] })
      .then(() => queryClient.invalidateQueries({ queryKey: [...scope, 'course-choices'] }));
  }, [courseChoicesApi, queryClient, scope]);
  const currentChoices =
    courseChoices.data?.api === courseChoicesApi ? courseChoices.data?.value : undefined;
  const reloadCourses = () => {
    void courseChoices.refetch();
  };
  const courseChoicesState: GalleryCourseChoicesState =
    courseChoicesApi === undefined
      ? { state: 'unavailable' }
      : courseChoices.isError
        ? { state: 'error', reload: reloadCourses }
        : currentChoices === undefined || courseChoices.isFetching
          ? { state: 'loading' }
          : {
              state: 'ready',
              unavailableCount: currentChoices.unavailableCount,
              reload: reloadCourses,
            };

  const listQueryKey = useMemo(
    () => [...scope, 'list', mediaKind, album] as const,
    [scope, mediaKind, album],
  );
  const list = useInfiniteQuery({
    queryKey: listQueryKey,
    enabled: navigation === undefined,
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
      await queryClient.invalidateQueries({ queryKey: [...scope, 'navigation'] });
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
      await queryClient.invalidateQueries({ queryKey: [...scope, 'navigation'] });
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
  const items =
    navigation !== undefined
      ? navigationWorkspace.items.filter((item) => !hidden(item.id))
      : list.isSuccess
        ? deduplicateById(list.data.pages.flatMap((page) => page.items)).filter(
            (item) => !hidden(item.id),
          )
        : [];
  const detailItem =
    !detailDeleted && detail.isSuccess && detail.data.status === 'available'
      ? detail.data.item
      : null;
  const viewerItems = detailItem
    ? [detailItem, ...items.filter((item) => item.id !== detailItem.id)]
    : items;
  const total = list.isSuccess ? (list.data.pages.at(-1)?.total ?? 0) : 0;
  const pending = stage !== 'idle';

  const navigationRows =
    navigationWorkspace.result.state === 'ready' ? navigationWorkspace.result.page.items : [];
  function albumLabel(item: GalleryMediaItem) {
    if (!navigation) return item.album ?? '지정 안 됨';
    const membership = navigationRows.find((row) => row.item.id === item.id)?.albumMembership;
    if (!membership) return '앨범 미지정';
    const result = navigationWorkspace.albumProps.result;
    return result.state === 'ready'
      ? (result.page.items.find((entry) => entry.id === membership.albumId)?.title ??
          '앨범 정보 없음')
      : '앨범 정보 없음';
  }
  const grid = (
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
            <button type="button" onClick={() => setViewerId(item.id)}>
              미디어 크게 보기
            </button>
            <dl className={styles.factList}>
              <div>
                <dt>종류</dt>
                <dd>{item.mediaKind === 'image' ? '사진' : '동영상'}</dd>
              </div>
              <div>
                <dt>앨범</dt>
                <dd>{albumLabel(item)}</dd>
              </div>
              <div>
                <dt>촬영 시각</dt>
                <dd>{item.capturedAt ?? '알 수 없음'}</dd>
              </div>
              {navigation ? (
                <>
                  {item.album !== null ? (
                    <div>
                      <dt>기존 앨범 이름</dt>
                      <dd>{item.album}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>저장된 촬영일</dt>
                    <dd>{item.capturedLocalDate ?? '알 수 없음'}</dd>
                  </div>
                  <div>
                    <dt>저장된 코스 연결</dt>
                    <dd>
                      {navigationRows.find((row) => row.item.id === item.id)?.courseLink
                        ? `리비전 ${navigationRows.find((row) => row.item.id === item.id)?.courseLink?.courseRevision}`
                        : '코스 연결 없음'}
                      {navigationRows.find((row) => row.item.id === item.id)?.courseAvailability
                        ?.state === 'unavailable'
                        ? ' · 사용 불가'
                        : null}
                    </dd>
                  </div>
                </>
              ) : null}
              <div>
                <dt>크기</dt>
                <dd>{byteFormatter.format(item.file.byteSize)} 바이트</dd>
              </div>
            </dl>
            <div className={styles.actions}>
              {organizer.actions && navigationRows.some((row) => row.item.id === item.id) ? (
                <button
                  type="button"
                  onClick={() => {
                    const row = navigationRows.find((entry) => entry.item.id === item.id);
                    if (row) organizer.actions?.begin(row);
                  }}
                >
                  앨범·코스 지정
                </button>
              ) : null}
              <button type="button" onClick={() => remove.mutate(item)} disabled={remove.isPending}>
                삭제
              </button>
            </div>
          </article>
        </li>
      ))}
    </ul>
  );

  return (
    <section className={styles.workspace} aria-label="갤러리 작업 공간">
      <header className={styles.header}>
        <p className={styles.eyebrow}>비공개 갤러리</p>
        <h1>사진 · 동영상</h1>
        <p className={styles.meta}>
          모든 미디어는 본인만 볼 수 있습니다. 갤러리 열람은 AI 전송 동의와 별개이며,{' '}
          {renditionsReader
            ? '원본은 올린 그대로(위치 등 촬영 정보 포함) 비공개로 보관하고, 미리보기·썸네일·재생용 변환본은 촬영 메타데이터 없이 따로 만듭니다.'
            : '이 화면은 원본만 저장하고 자동 변환이나 썸네일 생성을 하지 않습니다.'}
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

      {navigation && navigationWorkspace.filterNavigationConflict.state === 'draft_conflict' ? (
        <div className={styles.panel}>
          <p role="status">
            화면 이동으로 목록 필터가 바뀌었습니다. 편집 중인 필터는 보존했습니다.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              onClick={() => navigationWorkspace.controls.resolveFilterNavigation('use_external')}
            >
              이동한 화면의 필터 사용
            </button>
            <button
              type="button"
              onClick={() => navigationWorkspace.controls.resolveFilterNavigation('keep_draft')}
            >
              편집 중인 필터 유지
            </button>
          </div>
        </div>
      ) : null}

      <GalleryNavigationControls
        filters={navigationWorkspace.filters}
        limit={navigationWorkspace.limit}
        albums={
          navigationWorkspace.albumProps.result.state === 'ready'
            ? navigationWorkspace.albumProps.result.page.items
            : []
        }
        courses={currentChoices?.choices ?? []}
        courseChoices={courseChoicesState}
        result={navigationWorkspace.result}
        actions={navigation ? { ...navigationWorkspace.controls, openMedia: setViewerId } : null}
      />
      {!navigation ? (
        <p role="status">이 환경에서는 갤러리 탐색 연결을 사용할 수 없습니다.</p>
      ) : null}
      <GalleryAlbums {...navigationWorkspace.albumProps} />
      <GalleryMediaOrganizer
        label={(() => {
          const row = navigationRows.find(
            (entry) => entry.item.id === organizer.draft?.mediaItemId,
          );
          return row ? (row.item.caption ?? row.item.file.originalFileName) : null;
        })()}
        draft={organizer.draft}
        albums={
          navigationWorkspace.albumProps.result.state === 'ready'
            ? navigationWorkspace.albumProps.result.page.items
            : []
        }
        courses={currentChoices?.choices ?? []}
        operation={organizer.operation}
        actions={organizer.actions}
      />
      <section className={styles.panel} aria-labelledby="gallery-list-heading">
        <h2 id="gallery-list-heading">보관한 미디어</h2>
        {navigation === undefined && list.isPending ? (
          <p role="status">갤러리를 불러오는 중입니다.</p>
        ) : null}
        {navigation === undefined && list.isError ? (
          <p role="alert">
            갤러리를 불러오지 못했습니다.{' '}
            <button onClick={() => void list.refetch()}>다시 시도</button>
          </p>
        ) : null}
        {navigation === undefined && list.isSuccess && items.length === 0 ? (
          <p role="status">아직 저장한 사진이나 동영상이 없습니다.</p>
        ) : null}
        {navigation === undefined && list.isSuccess && items.length > 0 && total > items.length ? (
          <p role="status" className={styles.status}>
            전체 {total}개 중 {items.length}개를 표시했습니다.
          </p>
        ) : null}
        {navigation ? (
          <GalleryNavigationResultFrame
            filters={navigationWorkspace.filters}
            limit={navigationWorkspace.limit}
            result={navigationWorkspace.result}
            actions={{ ...navigationWorkspace.controls, openMedia: setViewerId }}
          >
            {grid}
          </GalleryNavigationResultFrame>
        ) : (
          grid
        )}
        {navigation === undefined && list.isSuccess && list.hasNextPage ? (
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
                <>
                  <MediaPreview
                    item={detail.data.item}
                    transfer={mediaTransfer}
                    variant="original"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (detailItem) setViewerId(detailItem.id);
                    }}
                  >
                    선택한 미디어 크게 보기
                  </button>
                </>
              ) : null}
            </>
          )}
        </section>
      ) : null}
      {viewerId !== null ? (
        <Suspense fallback={<p role="status">미디어 보기 준비 중</p>}>
          <MediaViewer
            items={viewerItems}
            selectedId={viewerId}
            transfer={mediaTransfer}
            subtitlesReader={subtitlesReader}
            renditionsReader={renditionsReader}
            onSelect={setViewerId}
            onClose={() => setViewerId(null)}
          />
        </Suspense>
      ) : null}
    </section>
  );
}

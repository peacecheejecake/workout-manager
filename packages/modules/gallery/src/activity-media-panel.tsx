'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import type { GalleryMediaItem } from '@workout/contracts/gallery';
import { createGalleryApi } from './gallery-api';
import { readableGalleryError } from './gallery-errors';
import { deduplicateById, nextGalleryOffset } from './gallery-paging';
import { MediaPreview } from './media-preview';
import type { GalleryMediaTransfer } from './media-transfer';
import styles from './gallery.module.css';

export type { GalleryMediaTransfer } from './media-transfer';

/**
 * S09 media tab (M2-01k-l): the owner's existing gallery media linked to one activity.
 *
 * The link is the gallery item's own `activityId`. It is therefore owned, revisioned,
 * deleted, erased and exported exactly as the media item is: this panel adds no second
 * record of it and no access path of its own. Everything shown here comes from the gallery
 * API, so a media item deleted anywhere leaves this tab and its content addresses at once.
 */
export interface ActivityMediaPanelProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  activityId: string;
  mediaTransfer?: GalleryMediaTransfer;
  /** Where the owner uploads new media; linking only uses media that already exists. */
  galleryHref?: string;
}

const PAGE_SIZE = 50;
const byteFormatter = new Intl.NumberFormat('ko-KR');

export function ActivityMediaPanel(props: ActivityMediaPanelProps) {
  return <Lifetime key={`${props.athleteId}:${props.sessionId}:${props.activityId}`} {...props} />;
}

function Lifetime(props: ActivityMediaPanelProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  // Media descriptors are private: nothing of this activity's media outlives the panel.
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <Panel {...props} />
    </QueryClientProvider>
  );
}

type LinkChange = { item: GalleryMediaItem; activityId: string | null };
type CardList = 'linked' | 'picker';

function Panel({
  athleteId,
  sessionId,
  transport,
  activityId,
  mediaTransfer,
  galleryHref = '/gallery',
}: ActivityMediaPanelProps) {
  const api = useMemo(() => createGalleryApi(transport), [transport]);
  const queryClient = useQueryClient();
  const headingId = useId();
  const pickerHeadingId = useId();
  const cardIdPrefix = useId();
  const cardHeadingId = (list: CardList, mediaItemId: string) =>
    `${cardIdPrefix}-${list}-${mediaItemId}`;
  const scope = useMemo(
    () => ['users', athleteId, 'sessions', sessionId, 'activity-media', activityId] as const,
    [athleteId, sessionId, activityId],
  );
  const linked = useInfiniteQuery({
    queryKey: [...scope, 'linked'],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api.list({ activityId, limit: PAGE_SIZE, offset: pageParam }, signal),
    getNextPageParam: nextGalleryOffset,
  });
  const gallery = useInfiniteQuery({
    queryKey: [...scope, 'gallery'],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.list({ limit: PAGE_SIZE, offset: pageParam }, signal),
    getNextPageParam: nextGalleryOffset,
  });
  const [announcement, setAnnouncement] = useState<string | null>(null);
  // Linking or unlinking moves the card to the other list, which unmounts the button that
  // was pressed. Focus follows the card once the lists hold the server's answer, or falls
  // back to the heading of the list it moved to.
  const pendingFocus = useRef<{ list: CardList; mediaItemId: string } | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const change = useMutation({
    mutationFn: ({ item, activityId: target }: LinkChange) =>
      api.update(item.id, {
        album: item.album,
        caption: item.caption,
        activityId: target,
        expectedAccessRevision: item.accessRevision,
        idempotencyKey: crypto.randomUUID(),
      }),
    onMutate: () => setAnnouncement(null),
    onSuccess: (_result, { item, activityId: target }) => {
      const name = item.caption ?? item.file.originalFileName;
      setAnnouncement(
        target === null
          ? `${name}의 연결을 해제했습니다.`
          : `${name}을(를) 이 활동에 연결했습니다.`,
      );
    },
    // Success or failure, the server holds the truth: a conflict means another change won.
    onSettled: async (_result, error, { item, activityId: target }) => {
      await queryClient.invalidateQueries({ queryKey: scope });
      if (error) return;
      pendingFocus.current = { list: target === null ? 'picker' : 'linked', mediaItemId: item.id };
      setFocusRequest((request) => request + 1);
    },
  });
  useEffect(() => {
    const request = pendingFocus.current;
    if (request === null) return;
    pendingFocus.current = null;
    const target =
      document.getElementById(`${cardIdPrefix}-${request.list}-${request.mediaItemId}`) ??
      document.getElementById(request.list === 'linked' ? headingId : pickerHeadingId);
    target?.focus();
  }, [focusRequest, cardIdPrefix, headingId, pickerHeadingId]);

  // Only a successful read is rendered. A failed refetch keeps the previous pages in the
  // query cache, and showing them would keep a deleted item's thumbnail on screen.
  const linkedItems = linked.isSuccess
    ? deduplicateById(linked.data.pages.flatMap((page) => page.items)).filter(
        (item) => item.activityId === activityId,
      )
    : [];
  const linkedTotal = linked.isSuccess ? (linked.data.pages.at(-1)?.total ?? 0) : 0;
  const linkedIds = new Set(linkedItems.map((item) => item.id));
  const candidates = gallery.isSuccess
    ? deduplicateById(gallery.data.pages.flatMap((page) => page.items)).filter(
        (item) => item.activityId !== activityId && !linkedIds.has(item.id),
      )
    : [];

  return (
    <section className={styles.workspace} aria-label="활동 미디어">
      <section className={styles.panel} aria-labelledby={headingId}>
        <h4 id={headingId} tabIndex={-1}>
          이 활동의 미디어
        </h4>
        <p className={styles.meta}>
          갤러리에 보관한 본인의 사진·동영상을 이 활동에 연결합니다. 연결한 미디어는 본인만 볼 수
          있고, 권한·삭제·내보내기는 갤러리 원본을 따릅니다. 갤러리에서 삭제하면 이 탭과 원본·썸네일
          주소에서 모두 사라집니다.
        </p>
        {linked.isPending ? <p role="status">연결한 미디어를 불러오는 중입니다.</p> : null}
        {linked.isError ? (
          <p role="alert">
            연결한 미디어를 불러오지 못했습니다.{' '}
            <button type="button" onClick={() => void linked.refetch()}>
              다시 시도
            </button>
          </p>
        ) : null}
        {linked.isSuccess && linkedItems.length === 0 ? (
          <p role="status">이 활동에 연결한 미디어가 없습니다.</p>
        ) : null}
        {linked.isSuccess && linkedItems.length > 0 && linkedTotal > linkedItems.length ? (
          <p role="status" className={styles.status}>
            전체 {linkedTotal}개 중 {linkedItems.length}개를 표시했습니다.
          </p>
        ) : null}
        {linkedItems.length > 0 ? (
          <ul className={styles.grid} aria-label="연결한 미디어">
            {linkedItems.map((item) => (
              <li key={item.id}>
                <LinkedMedia
                  headingId={cardHeadingId('linked', item.id)}
                  item={item}
                  transfer={mediaTransfer}
                  disabled={change.isPending}
                  onUnlink={() => change.mutate({ item, activityId: null })}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {linked.isSuccess && linked.hasNextPage ? (
          <div className={styles.actions}>
            <button
              type="button"
              onClick={() => void linked.fetchNextPage()}
              disabled={linked.isFetchingNextPage}
            >
              연결한 미디어 더 보기
            </button>
          </div>
        ) : null}
        {change.isPending ? <p role="status">연결 변경을 저장하는 중입니다.</p> : null}
        {announcement && !change.isPending ? <p role="status">{announcement}</p> : null}
        {change.isError ? <p role="alert">{readableGalleryError(change.error)}</p> : null}
      </section>

      <section className={styles.panel} aria-labelledby={pickerHeadingId}>
        <h4 id={pickerHeadingId} tabIndex={-1}>
          갤러리에서 연결
        </h4>
        <p className={styles.hint}>
          새 사진이나 동영상은 <a href={galleryHref}>갤러리</a>에서 올린 뒤 여기서 연결하세요. 다른
          활동에 연결된 미디어를 연결하면 이 활동으로 옮겨집니다.
        </p>
        {gallery.isPending ? <p role="status">갤러리를 불러오는 중입니다.</p> : null}
        {gallery.isError ? (
          <p role="alert">
            갤러리를 불러오지 못했습니다.{' '}
            <button type="button" onClick={() => void gallery.refetch()}>
              다시 시도
            </button>
          </p>
        ) : null}
        {gallery.isSuccess && candidates.length === 0 ? (
          <p role="status">연결할 수 있는 갤러리 미디어가 없습니다.</p>
        ) : null}
        {candidates.length > 0 ? (
          <ul className={styles.grid} aria-label="연결할 수 있는 미디어">
            {candidates.map((item) => (
              <li key={item.id}>
                <article className={styles.card} aria-labelledby={cardHeadingId('picker', item.id)}>
                  <h5 id={cardHeadingId('picker', item.id)} tabIndex={-1}>
                    {mediaName(item)}
                  </h5>
                  <MediaPreview item={item} transfer={mediaTransfer} />
                  <p className={styles.hint}>
                    {item.mediaKind === 'image' ? '사진' : '동영상'} · 앨범{' '}
                    {item.album ?? '지정 안 됨'}
                    {item.activityId === null ? '' : ' · 다른 활동에 연결됨'}
                  </p>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      aria-describedby={cardHeadingId('picker', item.id)}
                      disabled={change.isPending}
                      onClick={() => change.mutate({ item, activityId })}
                    >
                      이 활동에 연결
                    </button>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        ) : null}
        {gallery.isSuccess && gallery.hasNextPage ? (
          <div className={styles.actions}>
            <button
              type="button"
              onClick={() => void gallery.fetchNextPage()}
              disabled={gallery.isFetchingNextPage}
            >
              갤러리 미디어 더 보기
            </button>
          </div>
        ) : null}
      </section>
    </section>
  );
}

function mediaName(item: GalleryMediaItem) {
  return item.caption ?? item.file.originalFileName;
}

function LinkedMedia({
  headingId,
  item,
  transfer,
  disabled,
  onUnlink,
}: {
  headingId: string;
  item: GalleryMediaItem;
  transfer: GalleryMediaTransfer | undefined;
  disabled: boolean;
  onUnlink(): void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  // The original bytes come through the session's authenticated transfer, never through a
  // shareable address: the blob URL lives only for the click that saves it.
  async function download() {
    if (!transfer) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setDownloading(true);
    setDownloadFailed(false);
    try {
      const url = await transfer.open({
        mediaItemId: item.id,
        variant: 'original',
        signal: controller.signal,
      });
      try {
        if (controller.signal.aborted) return;
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = item.file.originalFileName;
        anchor.rel = 'noopener';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      if (!controller.signal.aborted) setDownloadFailed(true);
    } finally {
      if (!controller.signal.aborted) setDownloading(false);
    }
  }

  return (
    <article className={styles.card} aria-labelledby={headingId}>
      <h5 id={headingId} tabIndex={-1}>
        {mediaName(item)}
      </h5>
      <MediaPreview item={item} transfer={transfer} />
      <dl className={styles.factList}>
        <div>
          <dt>종류</dt>
          <dd>{item.mediaKind === 'image' ? '사진' : '동영상'}</dd>
        </div>
        <div>
          <dt>파일</dt>
          <dd>{item.file.originalFileName}</dd>
        </div>
        <div>
          <dt>크기</dt>
          <dd>{byteFormatter.format(item.file.byteSize)} 바이트</dd>
        </div>
      </dl>
      <div className={styles.actions}>
        <button
          type="button"
          aria-describedby={headingId}
          disabled={!transfer || downloading}
          onClick={() => void download()}
        >
          원본 내려받기
        </button>
        <button type="button" aria-describedby={headingId} disabled={disabled} onClick={onUnlink}>
          연결 해제
        </button>
      </div>
      {downloading ? <p role="status">원본을 내려받는 중입니다.</p> : null}
      {downloadFailed ? (
        <p role="alert">원본을 내려받지 못했습니다. 미디어가 삭제되었거나 접근할 수 없습니다.</p>
      ) : null}
    </article>
  );
}

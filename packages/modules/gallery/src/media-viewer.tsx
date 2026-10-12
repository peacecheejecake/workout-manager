import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import type { GalleryMediaItem } from '@workout/contracts/gallery';
import type { GalleryMediaTransfer } from './media-transfer';
import { useGalleryMediaSource } from './use-gallery-media-source';
import { galleryAdjacentIndex, gallerySwipeDirection } from './viewer-navigation';
import { VideoViewer, type GallerySubtitlesReader } from './video-viewer';
import { GalleryRenditionStatus, type GalleryRenditionsReader } from './rendition-status';
import styles from './gallery.module.css';

export function MediaViewer({
  items,
  selectedId,
  transfer,
  subtitlesReader,
  renditionsReader,
  onSelect,
  onClose,
}: {
  items: readonly GalleryMediaItem[];
  selectedId: string;
  transfer?: GalleryMediaTransfer | undefined;
  subtitlesReader?: GallerySubtitlesReader | undefined;
  renditionsReader?: GalleryRenditionsReader | undefined;
  onSelect(id: string): void;
  onClose(): void;
}) {
  const headingId = useId();
  const dialog = useRef<HTMLDialogElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const [imageFailed, setImageFailed] = useState<string | null>(null);
  const index = items.findIndex((item) => item.id === selectedId);
  const item = items[index];
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    if (element && typeof element.showModal === 'function') element.showModal();
    closeButton.current?.focus();
    return () => {
      if (element?.open) element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  function move(direction: -1 | 1) {
    const next = items[galleryAdjacentIndex(index, items.length, direction)];
    if (next && next.id !== selectedId) onSelect(next.id);
  }
  function finishSwipe(event: PointerEvent<HTMLDivElement>) {
    const start = pointer.current;
    pointer.current = null;
    if (!start || start.id !== event.pointerId) return;
    const direction = gallerySwipeDirection(event.clientX - start.x, event.clientY - start.y);
    if (direction !== null) move(direction);
  }
  return (
    <dialog
      ref={dialog}
      className={styles.viewer}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('video,input,select,textarea')) return;
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          move(-1);
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          move(1);
        }
      }}
    >
      <header className={styles.viewerHeader}>
        <h2 id={headingId}>미디어 보기</h2>
        <button type="button" ref={closeButton} onClick={onClose}>
          보기 닫기
        </button>
      </header>
      {item ? (
        <>
          <h3>{item.caption ?? item.file.originalFileName}</h3>
          <div
            className={styles.viewerSurface}
            role="group"
            aria-label="미디어 이동 영역"
            onPointerDown={(event) => {
              if (
                event.isPrimary &&
                event.pointerType === 'touch' &&
                !(
                  event.target instanceof HTMLElement && event.target.closest('video,button,select')
                )
              )
                pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
            }}
            onPointerUp={finishSwipe}
            onPointerCancel={() => {
              pointer.current = null;
            }}
          >
            <ViewerContent
              key={JSON.stringify([item.id, item.accessRevision])}
              item={item}
              transfer={transfer}
              subtitlesReader={subtitlesReader}
              failed={imageFailed === JSON.stringify([item.id, item.accessRevision])}
              onImageFailure={() => setImageFailed(JSON.stringify([item.id, item.accessRevision]))}
              onImageRetry={() => setImageFailed(null)}
            />
          </div>
          {renditionsReader ? (
            <GalleryRenditionStatus
              key={JSON.stringify([item.id, item.accessRevision])}
              item={item}
              reader={renditionsReader}
            />
          ) : null}
          <nav className={styles.actions} aria-label="미디어 이동">
            <button type="button" disabled={index <= 0} onClick={() => move(-1)}>
              이전 미디어
            </button>
            <span>
              {index + 1} / {items.length} (현재 불러온 미디어)
            </span>
            <button type="button" disabled={index >= items.length - 1} onClick={() => move(1)}>
              다음 미디어
            </button>
          </nav>
        </>
      ) : (
        <p role="status">선택한 미디어가 삭제되었거나 현재 접근할 수 없습니다.</p>
      )}
    </dialog>
  );
}
function ViewerContent({
  item,
  transfer,
  subtitlesReader,
  failed,
  onImageFailure,
  onImageRetry,
}: {
  item: GalleryMediaItem;
  transfer: GalleryMediaTransfer | undefined;
  subtitlesReader: GallerySubtitlesReader | undefined;
  failed: boolean;
  onImageFailure(): void;
  onImageRetry(): void;
}) {
  const { state, retry } = useGalleryMediaSource(item, transfer, 'original');
  if (state.kind === 'unavailable')
    return <p role="status">이 환경에서는 미디어를 표시할 수 없습니다.</p>;
  if (state.kind === 'loading') return <p role="status">선택한 미디어 불러오는 중</p>;
  if (state.kind === 'failed' || failed)
    return (
      <div role="alert">
        미디어를 불러오지 못했습니다.
        <button
          type="button"
          onClick={() => {
            onImageRetry();
            retry();
          }}
        >
          미디어 다시 불러오기
        </button>
      </div>
    );
  return item.mediaKind === 'image' ? (
    <img
      src={state.url}
      alt={item.caption ?? item.file.originalFileName}
      onError={onImageFailure}
    />
  ) : (
    <VideoViewer
      key={state.url}
      item={item}
      source={state.url}
      subtitlesReader={subtitlesReader}
      onRetry={retry}
    />
  );
}

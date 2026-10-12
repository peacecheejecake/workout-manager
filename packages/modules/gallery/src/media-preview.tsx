import { useEffect, useRef, useState } from 'react';
import type { GalleryMediaItem } from '@workout/contracts/gallery';
import type { GalleryMediaTransfer } from './media-transfer';
import { useGalleryMediaSource } from './use-gallery-media-source';
import styles from './gallery.module.css';

/**
 * Media bytes load only when the tile enters the viewport, and each blob URL is
 * revoked when the tile unmounts so private media never outlives the session.
 */
export function MediaPreview({
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
  const { state, retry } = useGalleryMediaSource(item, transfer, variant, visible);

  useEffect(() => {
    const element = container.current;
    if (!element || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const label = item.caption ?? item.file.originalFileName;
  return (
    <div className={styles.media} ref={container}>
      {state.kind === 'unavailable' ? (
        <p className={styles.hint}>이 환경에서는 미디어를 표시할 수 없습니다.</p>
      ) : state.kind === 'failed' ? (
        <div role="alert">
          미디어를 불러오지 못했습니다.
          <button type="button" onClick={retry}>
            미디어 다시 불러오기
          </button>
        </div>
      ) : state.kind !== 'ready' ? (
        <p role="status">미디어 불러오는 중</p>
      ) : item.mediaKind === 'image' ? (
        <img src={state.url} alt={label} loading="lazy" decoding="async" />
      ) : (
        <>
          {/* Tile playback does not query subtitles; the viewer handles their explicit availability. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={state.url} controls playsInline preload="none" aria-label={label} />
          <p className={styles.hint}>이 미리보기에서는 자막을 조회하지 않습니다.</p>
        </>
      )}
    </div>
  );
}

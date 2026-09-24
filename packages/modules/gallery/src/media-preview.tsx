import { useEffect, useRef, useState } from 'react';
import type { GalleryMediaItem } from '@workout/contracts/gallery';
import type { GalleryMediaTransfer } from './media-transfer';
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

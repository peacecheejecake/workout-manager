import { useEffect, useState } from 'react';
import type { GalleryMediaItem } from '@workout/contracts/gallery';
import type { GalleryMediaTransfer } from './media-transfer';

type SourceState =
  | { kind: 'unavailable'; key: string }
  | { kind: 'loading'; key: string }
  | { kind: 'failed'; key: string; owner: GalleryMediaTransfer; signal: AbortSignal }
  | { kind: 'ready'; key: string; url: string; owner: GalleryMediaTransfer; signal: AbortSignal };

/** An invocation owns its Blob URL, including URLs returned after cancellation. */
export function useGalleryMediaSource(
  item: GalleryMediaItem,
  transfer: GalleryMediaTransfer | undefined,
  variant: 'original' | 'preview',
  enabled = true,
) {
  const [attempt, setAttempt] = useState(0);
  const resolved = variant === 'preview' && item.preview === null ? 'original' : variant;
  const key = JSON.stringify([item.id, item.accessRevision, resolved, attempt]);
  const [state, setState] = useState<SourceState>({ kind: 'loading', key });
  useEffect(() => {
    if (!enabled || !transfer) return;
    const controller = new AbortController();
    let url: string | null = null;
    void Promise.resolve()
      .then(() =>
        transfer.open({ mediaItemId: item.id, variant: resolved, signal: controller.signal }),
      )
      .then((next) => {
        if (!next.startsWith('blob:')) throw new Error('MEDIA_SOURCE_INVALID');
        if (controller.signal.aborted) {
          URL.revokeObjectURL(next);
          return;
        }
        url = next;
        setState({ kind: 'ready', key, url: next, owner: transfer, signal: controller.signal });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({ kind: 'failed', key, owner: transfer, signal: controller.signal });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [enabled, transfer, item.id, resolved, key]);
  const current: SourceState = !transfer
    ? { kind: 'unavailable', key }
    : !enabled
      ? { kind: 'loading', key }
      : state.key === key &&
          ((state.kind !== 'ready' && state.kind !== 'failed') ||
            (state.owner === transfer && !state.signal.aborted))
        ? state
        : { kind: 'loading', key };
  return { state: current, retry: () => setAttempt((value) => value + 1) };
}

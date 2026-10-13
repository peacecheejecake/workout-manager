import { useEffect, useEffectEvent, useState } from 'react';
import type { GalleryMediaItem } from '@workout/contracts/gallery';
import type { GalleryMediaOpenInput, GalleryMediaTransfer } from './media-transfer';

type SourceState =
  | { kind: 'unavailable'; key: string }
  | { kind: 'loading'; key: string }
  | { kind: 'failed'; key: string; signal: AbortSignal }
  | { kind: 'ready'; key: string; url: string; signal: AbortSignal };

/**
 * An invocation owns its Blob URL, including URLs returned after cancellation.
 *
 * The open lifetime is keyed on the item, access revision, variant and retry attempt only. The
 * transfer adapter's object identity is not part of it: a host that rebuilds an equivalent
 * adapter on render (for example after URL navigation) must not revoke and re-download every
 * visible tile. Account/session isolation is owned by the session-keyed workspace lifetime that
 * remounts this hook, never by adapter identity.
 */
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
  const available = transfer !== undefined;
  // Reads the latest adapter when an open starts without making its identity an effect input.
  const open = useEffectEvent((input: GalleryMediaOpenInput) => {
    if (!transfer) throw new Error('MEDIA_TRANSFER_UNAVAILABLE');
    return transfer.open(input);
  });
  useEffect(() => {
    if (!enabled || !available) return;
    const controller = new AbortController();
    let url: string | null = null;
    void Promise.resolve()
      .then(() => open({ mediaItemId: item.id, variant: resolved, signal: controller.signal }))
      .then((next) => {
        if (!next.startsWith('blob:')) throw new Error('MEDIA_SOURCE_INVALID');
        if (controller.signal.aborted) {
          URL.revokeObjectURL(next);
          return;
        }
        url = next;
        setState({ kind: 'ready', key, url: next, signal: controller.signal });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({ kind: 'failed', key, signal: controller.signal });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [enabled, available, item.id, resolved, key]);
  const current: SourceState = !available
    ? { kind: 'unavailable', key }
    : !enabled
      ? { kind: 'loading', key }
      : state.key === key &&
          ((state.kind !== 'ready' && state.kind !== 'failed') || !state.signal.aborted)
        ? state
        : { kind: 'loading', key };
  return { state: current, retry: () => setAttempt((value) => value + 1) };
}

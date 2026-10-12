import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  GalleryCourseLinkV2,
  GalleryMediaMembershipCommandV2,
} from '@workout/contracts/gallery-navigation-v2';
import type { GalleryMediaNavigationV3 } from '@workout/contracts/gallery-navigation-v3';
import { GalleryNavigationRequestError, type GalleryNavigationApi } from './gallery-navigation-api';

/** Selected values only; the saved row supplies the CAS revision and saved tuple. */
export interface GalleryMediaOrganizerDraft {
  mediaItemId: string;
  expectedAccessRevision: number;
  savedAlbumId: string | null;
  savedCourseLink: GalleryCourseLinkV2 | null;
  albumId: string | null;
  courseLink: GalleryCourseLinkV2 | null;
}
export type GalleryMediaOrganizerOperation =
  | { state: 'idle' }
  | { state: 'submitting' }
  | { state: 'saved' }
  | { state: 'conflict' }
  | { state: 'rejected'; status: number }
  | { state: 'uncertain' };

function command(draft: GalleryMediaOrganizerDraft): GalleryMediaMembershipCommandV2 {
  return {
    mediaItemId: draft.mediaItemId,
    expectedAccessRevision: draft.expectedAccessRevision,
    albumMembership: draft.albumId === null ? null : { albumId: draft.albumId },
    courseLink: draft.courseLink,
  };
}

/** Explicit per-item album/course assignment. A list read never proves a write;
 * an uncertain result is confirmed only by resending the same key and input. */
export function useGalleryMediaOrganizer(
  scope: readonly string[],
  api: GalleryNavigationApi | undefined,
) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<GalleryMediaOrganizerDraft | null>(null);
  const [operation, setOperation] = useState<GalleryMediaOrganizerOperation>({ state: 'idle' });
  const locked = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const pending = useRef<{
    key: string;
    input: GalleryMediaMembershipCommandV2;
    api: GalleryNavigationApi;
  } | null>(null);
  useEffect(() => {
    const active = controllers.current;
    if (pending.current && pending.current.api !== api) {
      locked.current = true;
      setOperation({ state: 'uncertain' });
    }
    return () => {
      for (const controller of active) controller.abort();
      active.clear();
    };
  }, [api]);
  async function send(key: string, input: GalleryMediaMembershipCommandV2) {
    if (!api) return;
    locked.current = true;
    pending.current = { key, input, api };
    const controller = new AbortController();
    controllers.current.add(controller);
    setOperation({ state: 'submitting' });
    try {
      await api.updateMembership(input, key, controller.signal);
      if (controller.signal.aborted) return;
      pending.current = null;
      locked.current = false;
      setDraft(null);
      setOperation({ state: 'saved' });
      await client.invalidateQueries({ queryKey: [...scope, 'navigation'] });
    } catch (error) {
      if (controller.signal.aborted) return;
      const status = error instanceof GalleryNavigationRequestError ? error.status : null;
      if (status === 409) {
        // Another change won the revision race; the draft stays but cannot be resent.
        pending.current = null;
        locked.current = false;
        setOperation({ state: 'conflict' });
      } else if (status !== null && status >= 400 && status < 500) {
        pending.current = null;
        locked.current = false;
        setOperation({ state: 'rejected', status });
      } else {
        setOperation({ state: 'uncertain' });
      }
    } finally {
      controllers.current.delete(controller);
    }
  }
  return {
    draft,
    operation,
    actions: !api
      ? null
      : {
          begin: (row: GalleryMediaNavigationV3) => {
            if (locked.current) return;
            const albumId = row.albumMembership?.albumId ?? null;
            setDraft({
              mediaItemId: row.item.id,
              expectedAccessRevision: row.item.accessRevision,
              savedAlbumId: albumId,
              savedCourseLink: row.courseLink,
              albumId,
              courseLink: row.courseLink,
            });
            setOperation({ state: 'idle' });
          },
          changeAlbum: (albumId: string | null) => {
            if (!locked.current) setDraft((current) => current && { ...current, albumId });
          },
          changeCourse: (courseLink: GalleryCourseLinkV2 | null) => {
            if (!locked.current) setDraft((current) => current && { ...current, courseLink });
          },
          cancel: () => {
            if (locked.current) return;
            setDraft(null);
            setOperation({ state: 'idle' });
          },
          save: () => {
            if (locked.current || !draft || operation.state === 'conflict') return;
            void send(crypto.randomUUID(), command(draft));
          },
          /** Same key and input through the current same-session adapter: the server
           * returns the original receipt, commits once, or rejects. Never a new key. */
          confirm: () => {
            const prior = pending.current;
            if (!prior || operation.state !== 'uncertain') return;
            void send(prior.key, prior.input);
          },
        },
  };
}

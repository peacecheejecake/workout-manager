import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  galleryMediaNavigationQueryV2Schema,
  type GalleryMediaNavigationQueryV2,
  type GalleryAlbumListQueryV1,
  type GalleryAlbumCreateCommandV1,
  type GalleryAlbumRenameCommandV1,
  type GalleryAlbumDeleteCommandV1,
} from '@workout/contracts/gallery-navigation-v2';
import { writeGalleryNavigationSearch } from './gallery-navigation-search';
import type { GalleryMediaKind } from '@workout/contracts/gallery';
import { GalleryNavigationRequestError, type GalleryNavigationApi } from './gallery-navigation-api';
import type { GalleryNavigationFilters, GalleryNavigationResult } from './gallery-navigation';
import type {
  GalleryAlbumsProps,
  GalleryAlbumOperation,
  GalleryAlbumDeleteTarget,
} from './gallery-albums';

/** The shell owns URL state; the callback receives only explicitly applied validated queries. */
export interface GalleryWorkspaceNavigation {
  api: GalleryNavigationApi;
  initialQuery?: GalleryMediaNavigationQueryV2;
  /** The shell supplies its decoded current URL, including back/forward changes. */
  externalQuery?: GalleryMediaNavigationQueryV2;
  onNavigate?: (query: GalleryMediaNavigationQueryV2) => void;
}
export type GalleryFilterNavigationConflict = { state: 'idle' } | { state: 'draft_conflict' };

const albumStart: GalleryAlbumListQueryV1 = {
  limit: 50,
  sort: 'created_desc_id_asc',
  cursor: null,
};
export function useGalleryNavigationWorkspace(
  scope: readonly string[],
  navigation: GalleryWorkspaceNavigation | undefined,
  mediaKind: GalleryMediaKind | null,
) {
  const client = useQueryClient();
  const [initial] = useState(() =>
    galleryMediaNavigationQueryV2Schema.parse(
      navigation?.externalQuery ??
        navigation?.initialQuery ?? {
          filters: {
            album: { mode: 'all' },
            mediaKind,
            activityId: null,
            courseLink: null,
            capturedDay: { mode: 'all' },
          },
          limit: 50,
          sort: 'created_desc_id_asc',
          cursor: null,
        },
    ),
  );
  const external =
    navigation?.externalQuery === undefined
      ? undefined
      : galleryMediaNavigationQueryV2Schema.parse(navigation.externalQuery);
  const externalKey = external === undefined ? null : writeGalleryNavigationSearch(external);
  const [state, setState] = useState<{
    query: GalleryMediaNavigationQueryV2;
    filters: GalleryNavigationFilters;
    externalKey: string | null;
    conflict: GalleryFilterNavigationConflict;
  }>(() => ({
    query: initial,
    filters: initial.filters,
    externalKey,
    conflict: { state: 'idle' },
  }));
  const { query, filters } = state;
  // Adjust only this hook's state before React commits its consumers. Keeping the same
  // lifetime preserves album drafts and uncertain command keys during history navigation.
  if (state.externalKey !== externalKey) {
    if (external === undefined || writeGalleryNavigationSearch(query) === externalKey) {
      setState({ ...state, externalKey });
    } else {
      const filterKey = (value: GalleryNavigationFilters) =>
        writeGalleryNavigationSearch({ ...query, filters: value, cursor: null });
      const preserveDraft =
        filterKey(filters) !== filterKey(query.filters) &&
        filterKey(filters) !== filterKey(external.filters);
      setState({
        query: external,
        filters: preserveDraft ? filters : external.filters,
        externalKey,
        conflict: { state: preserveDraft ? 'draft_conflict' : 'idle' },
      });
    }
  }
  function navigate(raw: GalleryMediaNavigationQueryV2) {
    const value = galleryMediaNavigationQueryV2Schema.parse(raw);
    const changed = writeGalleryNavigationSearch(value) !== writeGalleryNavigationSearch(query);
    setState((current) => ({
      ...current,
      query: value,
      filters: value.filters,
      conflict: { state: 'idle' },
    }));
    if (changed) navigation?.onNavigate?.(value);
  }
  const [albumQuery, setAlbumQuery] = useState(albumStart);
  const api = navigation?.api;
  const page = useQuery({
    queryKey: [...scope, 'navigation', query],
    // The local adapter reference binds a cached reply to its invocation, not server authority.
    structuralSharing: false,
    enabled: api !== undefined,
    queryFn: async ({ signal }) => {
      if (!api) throw new Error('NAVIGATION_UNAVAILABLE');
      return { api, page: await api.navigate(query, signal) };
    },
  });
  const albums = useQuery({
    queryKey: [...scope, 'albums', albumQuery],
    structuralSharing: false,
    enabled: api !== undefined,
    queryFn: async ({ signal }) => {
      if (!api) throw new Error('NAVIGATION_UNAVAILABLE');
      return { api, page: await api.listAlbums(albumQuery, signal) };
    },
  });
  const previousApi = useRef(api);
  useEffect(() => {
    if (previousApi.current === api) return;
    previousApi.current = api;
    void client
      .cancelQueries({ queryKey: scope })
      .then(() => client.invalidateQueries({ queryKey: scope }));
  }, [api, client, scope]);
  const [createTitle, setCreateTitle] = useState('');
  const [renameDraft, setRenameDraft] = useState<GalleryAlbumRenameCommandV1 | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GalleryAlbumDeleteTarget | null>(null);
  const [operation, setOperation] = useState<GalleryAlbumOperation>({ state: 'idle' });
  const locked = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const pendingCommand = useRef<{
    key: string;
    input: GalleryAlbumCreateCommandV1 | GalleryAlbumRenameCommandV1 | GalleryAlbumDeleteCommandV1;
    kind: 'create' | 'rename' | 'delete';
    api: GalleryNavigationApi;
  } | null>(null);
  useEffect(() => {
    const active = controllers.current;
    const pending = pendingCommand.current;
    if (pending && pending.api !== api) {
      locked.current = true;
      setOperation({ state: 'uncertain', kind: pending.kind });
    }
    return () => {
      for (const c of active) c.abort();
      active.clear();
      // Abort cannot establish whether the old server committed. The workspace retains its key.
    };
  }, [api]);
  async function command(
    kind: 'create' | 'rename' | 'delete',
    input: GalleryAlbumCreateCommandV1 | GalleryAlbumRenameCommandV1 | GalleryAlbumDeleteCommandV1,
  ) {
    if (!api || locked.current || operation.state === 'conflict') return;
    locked.current = true;
    const controller = new AbortController();
    controllers.current.add(controller);
    setOperation({ state: 'submitting', kind });
    const key = crypto.randomUUID();
    pendingCommand.current = { key, input, kind, api };
    try {
      if (kind === 'create') await api.createAlbum(input, key, controller.signal);
      else if (kind === 'rename') await api.renameAlbum(input, key, controller.signal);
      else await api.deleteAlbum(input, key, controller.signal);
      if (controller.signal.aborted) return;
      setCreateTitle('');
      setRenameDraft(null);
      setDeleteTarget(null);
      pendingCommand.current = null;
      setOperation({ state: 'idle' });
      locked.current = false;
      await Promise.all([
        client.invalidateQueries({ queryKey: [...scope, 'albums'] }),
        client.invalidateQueries({ queryKey: [...scope, 'navigation'] }),
      ]);
    } catch (error) {
      if (controller.signal.aborted) return;
      const conflict = error instanceof GalleryNavigationRequestError && error.status === 409;
      const rejected =
        error instanceof GalleryNavigationRequestError &&
        error.status !== null &&
        error.status >= 400 &&
        error.status < 500;
      setOperation({ state: conflict ? 'conflict' : rejected ? 'error' : 'uncertain', kind });
      locked.current = !rejected;
      if (rejected) pendingCommand.current = null;
    } finally {
      controllers.current.delete(controller);
    }
  }
  const result: GalleryNavigationResult = !api
    ? { state: 'unavailable' }
    : page.isError
      ? {
          state:
            page.error instanceof GalleryNavigationRequestError && page.error.status === 409
              ? 'conflict'
              : 'error',
        }
      : page.isSuccess && page.data.api === api
        ? { state: 'ready', page: page.data.page }
        : { state: 'loading' };
  const albumResult: GalleryAlbumsProps['result'] = !api
    ? { state: 'unavailable' }
    : albums.isError
      ? { state: 'error' }
      : albums.isSuccess && albums.data.api === api
        ? { state: 'ready', page: albums.data.page }
        : { state: 'loading' };
  return {
    filters,
    query,
    filterNavigationConflict: state.conflict,
    limit: query.limit,
    result,
    items: result.state === 'ready' ? result.page.items.map((row) => row.item) : [],
    controls: {
      changeFilters: (value: GalleryNavigationFilters) => {
        setState((current) => ({ ...current, filters: value }));
      },
      navigate,
      resolveFilterNavigation: (choice: 'use_external' | 'keep_draft') => {
        setState((current) => ({
          ...current,
          filters: choice === 'use_external' ? current.query.filters : current.filters,
          conflict: { state: 'idle' },
        }));
      },
      reload: () => {
        if (query.cursor === null) void page.refetch();
        else navigate({ ...query, cursor: null });
      },
    },
    albumProps: {
      createTitle,
      renameDraft,
      deleteTarget,
      result: albumResult,
      operation,
      actions: !api
        ? null
        : {
            changeCreateTitle: (title) => {
              if (!locked.current) setCreateTitle(title);
            },
            changeRenameTitle: (title) => {
              if (!locked.current) setRenameDraft((current) => current && { ...current, title });
            },
            beginRename: (album) => {
              if (!locked.current) {
                setRenameDraft({
                  albumId: album.id,
                  expectedRevision: album.revision,
                  title: album.title,
                });
                setOperation({ state: 'idle' });
              }
            },
            cancelRename: () => {
              if (!locked.current) {
                setRenameDraft(null);
                setOperation({ state: 'idle' });
              }
            },
            requestDelete: (album) => {
              if (!locked.current) {
                setDeleteTarget({ album, detachedMediaCount: null });
                setOperation({ state: 'idle' });
              }
            },
            cancelDelete: () => {
              if (!locked.current) {
                setDeleteTarget(null);
                setOperation({ state: 'idle' });
              }
            },
            create: (input) => {
              void command('create', input);
            },
            rename: (input) => {
              void command('rename', input);
            },
            delete: (input) => {
              void command('delete', input);
            },
            navigate: (next) => {
              if (!locked.current) setAlbumQuery(next);
            },
            // A list read cannot prove an uncertain write receipt. Keep operation/key outcome locked.
            reload: () => {
              void albums.refetch();
            },
          },
    } satisfies GalleryAlbumsProps,
  };
}

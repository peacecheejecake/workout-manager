'use client';

/**
 * Client-only map leaf.
 *
 * In: SDK-free `MapPath` values and a selection. Out: selection changes and the
 * renderer's availability. It never fetches anything itself, never knows where the
 * geometry came from, and never decides policy.
 *
 * The renderer is created once per mount and only its data is updated afterwards, so
 * selecting a vertex does not rebuild the map and a resize only resizes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BasemapDescriptor } from './basemap';
import type { MapAdapterFactory, MapAdapterFailure, MapAdapterHandle } from './map-adapter';
import {
  computeBounds,
  findNearestVertex,
  selectedPosition,
  toFeatureCollection,
  validateMapPath,
} from './map-path';
import type { GeoPosition, MapPath, MapSelection } from './map-path';
import styles from './map-view.module.css';

export type MapViewStatus = 'preparing' | 'ready' | 'unavailable' | 'invalid' | 'empty';

export interface MapViewProps {
  readonly label: string;
  readonly paths: readonly MapPath[];
  readonly selection: MapSelection | null;
  readonly onSelect: (selection: MapSelection | null) => void;
  /** `null` means "no background map"; geometry is still rendered. */
  readonly basemap: BasemapDescriptor | null;
  /**
   * Change this value to request a viewport fit. The view also fits once when it first
   * becomes ready; it never refits on selection, resize or data updates. Any change
   * counts, so callers normally increment it.
   */
  readonly fitRequest?: number;
  /**
   * Maximum number of vertices rendered in the non-map coordinate list. A recorded track
   * can carry tens of thousands of samples and one control each would be a document of
   * that size; the owning module provides the complete list.
   */
  readonly fallbackLimit?: number;
  /** The renderer settled; `renderedPathFeatures` is how much of the path is on screen. */
  readonly onRenderIdle?: (info: { readonly renderedPathFeatures: number }) => void;
  /** Injected for tests and for callers that supply their own renderer. */
  readonly createAdapter?: MapAdapterFactory;
  readonly onStatusChange?: (status: MapViewStatus, detail?: string) => void;
}

async function defaultAdapterFactory(
  ...args: Parameters<MapAdapterFactory>
): ReturnType<MapAdapterFactory> {
  const module = await import('./maplibre-adapter');
  return module.createMapLibreAdapter(...args);
}

export function MapView({
  label,
  paths,
  selection,
  onSelect,
  basemap,
  fitRequest = 0,
  fallbackLimit = 200,
  onRenderIdle,
  createAdapter,
  onStatusChange,
}: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const [adapter, setAdapter] = useState<MapAdapterHandle | null>(null);
  const [renderer, setRenderer] = useState<{
    status: 'preparing' | 'ready' | 'unavailable';
    detail: string | undefined;
  }>({ status: 'preparing', detail: undefined });

  const invalid = useMemo(
    () => paths.map((path) => validateMapPath(path)).find((result) => !result.ok) ?? null,
    [paths],
  );
  const collection = useMemo(() => (invalid ? null : toFeatureCollection(paths)), [paths, invalid]);
  const bounds = useMemo(() => (invalid ? null : computeBounds(paths)), [paths, invalid]);
  const marker = useMemo(() => selectedPosition(paths, selection), [paths, selection]);

  // Geometry problems are derived from the props, not stored as a second copy of state.
  const status: MapViewStatus = invalid
    ? 'invalid'
    : paths.length === 0 || paths.every((path) => path.positions.length === 0)
      ? 'empty'
      : renderer.status;

  // Latest callbacks without re-creating the renderer on every parent render.
  const latest = useRef({ onSelect, paths, onRenderIdle });
  useEffect(() => {
    latest.current = { onSelect, paths, onRenderIdle };
  }, [onSelect, paths, onRenderIdle]);

  const factory = createAdapter ?? defaultAdapterFactory;

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let active = true;
    let handle: MapAdapterHandle | null = null;
    let observer: ResizeObserver | null = null;
    // Initialisation that has not returned a handle yet is cancelled through this signal,
    // so the adapter can remove its renderer itself.
    const controller = new AbortController();

    const fail = (_reason: MapAdapterFailure, detail?: string) => {
      if (active) setRenderer({ status: 'unavailable', detail });
    };

    factory({
      container: element,
      basemap,
      signal: controller.signal,
      onReady: () => {
        if (active) setRenderer({ status: 'ready', detail: undefined });
      },
      onFailure: fail,
      onPick: (position) => {
        if (!active) return;
        latest.current.onSelect(findNearestVertex(latest.current.paths, position));
      },
      onIdle: (info) => {
        if (active) latest.current.onRenderIdle?.(info);
      },
    })
      .then((created) => {
        if (!active) {
          created.destroy();
          return;
        }
        handle = created;
        setAdapter(created);
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => created.resize());
          observer.observe(element);
        }
      })
      .catch((error: unknown) =>
        fail('RENDERER_UNAVAILABLE', error instanceof Error ? error.message : undefined),
      );

    return () => {
      active = false;
      controller.abort();
      observer?.disconnect();
      handle?.destroy();
      setAdapter(null);
    };
  }, [factory, basemap]);

  // Reporting outward is a side effect on the caller, never a second status store.
  useEffect(() => {
    onStatusChange?.(status, renderer.detail);
  }, [status, renderer.detail, onStatusChange]);

  useEffect(() => {
    if (!adapter || !collection) return;
    adapter.setPaths(collection);
  }, [adapter, collection]);

  useEffect(() => {
    adapter?.setSelection(marker);
  }, [adapter, marker]);

  const listed = useMemo(() => {
    const entries: { path: MapPath; position: GeoPosition; index: number }[] = [];
    for (const path of paths) {
      for (const [index, position] of path.positions.entries()) {
        if (entries.length >= fallbackLimit) return entries;
        entries.push({ path, position, index });
      }
    }
    return entries;
  }, [paths, fallbackLimit]);
  const total = paths.reduce((sum, path) => sum + path.positions.length, 0);
  const truncated = total - listed.length;

  const fitted = useRef(-1);
  useEffect(() => {
    if (!adapter || !bounds || fitted.current === fitRequest) return;
    fitted.current = fitRequest;
    adapter.fitBounds(bounds);
  }, [adapter, bounds, fitRequest]);

  const message =
    status === 'ready'
      ? '지도 표시 중'
      : status === 'preparing'
        ? '지도 준비 중'
        : status === 'empty'
          ? '표시할 좌표가 없습니다.'
          : status === 'invalid'
            ? `좌표를 표시할 수 없습니다 (${invalid && !invalid.ok ? invalid.problem : 'INVALID'}).`
            : '지도를 표시할 수 없습니다. 아래 좌표 목록을 사용하세요.';

  return (
    <section className={styles.root} aria-label={label}>
      <div ref={container} className={styles.surface} data-status={status} aria-hidden="true" />
      <p className={styles.status} role="status">
        {message}
      </p>
      {basemap ? <p className={styles.attribution}>{basemap.attribution}</p> : null}
      {/*
        Always available alternative: the map is never the only way to reach a vertex.
        The list is bounded — a long recorded track has tens of thousands of samples and
        rendering one control each would put that many nodes in the document. The owning
        module supplies the full paged list; this is the renderer-failure fallback.
      */}
      <ol className={styles.fallback} aria-label={`${label} 좌표 목록`}>
        {listed.map(({ path, position, index }) => (
          <li key={`${path.id}:${path.revision}:${index}`}>
            <button
              type="button"
              aria-pressed={
                selection?.pathId === path.id && selection.vertexIndex === index ? true : undefined
              }
              onClick={() => onSelect({ pathId: path.id, vertexIndex: index })}
            >
              {position[1].toFixed(5)}, {position[0].toFixed(5)}
            </button>
          </li>
        ))}
      </ol>
      {truncated > 0 ? (
        <p
          className={styles.status}
        >{`좌표 ${total}개 중 ${listed.length}개만 목록에 표시했습니다.`}</p>
      ) : null}
    </section>
  );
}

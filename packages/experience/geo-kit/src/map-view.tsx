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
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { BasemapDescriptor } from './basemap';
import { MapAdapterError } from './map-adapter';
import type { MapAdapterFactory, MapAdapterFailure, MapAdapterHandle } from './map-adapter';
import {
  computeBounds,
  findNearestVertex,
  selectedPosition,
  toFeatureCollection,
  validateMapPath,
} from './map-path';
import type { GeoPosition, MapPath, MapPathFeatureCollection, MapSelection } from './map-path';
import { collectionKey, judgeRender } from './render-evidence';
import type { MapRenderIdleInfo } from './render-evidence';
import styles from './map-view.module.css';

/**
 * What the map can honestly say about itself.
 *
 * `drawing` and `drawn` are separate on purpose. The style loading — the background, or
 * the plain canvas when there is none — needs no worker, so it happens even on a map that
 * will never draw a line (M2-01k F2/F3). Only `drawn` means the renderer went idle with our
 * geometry among what it drew.
 *
 * - `preparing`: the renderer is starting; no style yet.
 * - `drawing`: the style is in place and the path has been handed over, but no idle has
 *   shown it on screen yet.
 * - `drawn`: an idle found every kind of our geometry that lies in the viewport drawn.
 * - `not-drawn`: a renderer that has never drawn our geometry drew none of it although it
 *   lies in the viewport (lines and points judged apart), or never settled within the
 *   deadline. The map cannot draw the path.
 * - `out-of-view`: none of the path's vertices is inside the viewport. Nothing about the
 *   renderer's ability is claimed.
 * - `unconfirmed`: a renderer that HAS drawn our geometry cannot, right now, show that it
 *   draws the current path: nothing confirmed a changed path within the deadline (typically
 *   the new path is off screen while slow background tiles hold back `idle`), or a settled
 *   frame shows none of a path whose vertex is in view (zoomed out below a pixel). Such a
 *   renderer has shown it can draw, so "cannot draw" would be a false alarm (M2-01q review
 *   B1); the current path was not seen drawn, so "drawn" would be a false comfort. It says
 *   exactly that, and the next confirming observation turns it back into `drawn`.
 * - `unavailable`: the renderer or the background map failed, with a classified reason.
 * - `invalid`: the geometry breaks the display contract and is not handed over.
 * - `empty`: there is legitimately nothing to draw (no GPS, no waypoints yet). This is
 *   decided from the data alone, so an empty path never waits for a drawn feature.
 */
export type MapViewStatus =
  | 'preparing'
  | 'drawing'
  | 'drawn'
  | 'not-drawn'
  | 'out-of-view'
  | 'unconfirmed'
  | 'unavailable'
  | 'invalid'
  | 'empty';

/**
 * How long a handed-over path may go without an idle before the map says it could not
 * draw it. A map with no worker never settles at all, so without a deadline it would stay
 * "drawing" forever; an idle that arrives later still moves it to `drawn`.
 */
export const defaultRenderDeadlineMs = 10_000;

/**
 * How long a "drawn" verdict about the previous path may stand after the path changes.
 * A working renderer confirms a change within a frame or two (120–190 ms measured), so the
 * old verdict normally just carries over without a second announcement. Past this grace
 * the status line stops claiming the path is shown until the new path is confirmed: after
 * a worker dies, "drawn" would otherwise stand for the whole render deadline (review NB1).
 */
export const defaultConfirmGraceMs = 1_500;

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
  /** The renderer settled; the info says how much of the path is on screen, per layer. */
  readonly onRenderIdle?: (info: MapRenderIdleInfo) => void;
  /** See {@link defaultRenderDeadlineMs}. Tests shorten it. */
  readonly renderDeadlineMs?: number;
  /** See {@link defaultConfirmGraceMs}. Tests shorten it. */
  readonly confirmGraceMs?: number;
  /** Injected for tests and for callers that supply their own renderer. */
  readonly createAdapter?: MapAdapterFactory;
  readonly onStatusChange?: (status: MapViewStatus, detail?: string) => void;
  /**
   * The classified reason the renderer is unavailable. `onStatusChange` only says that it
   * is; an owner that must distinguish "this device has no WebGL" from "the background
   * map would not load" needs the reason, and guessing it from a message string would be
   * a second, weaker copy of what the adapter already knows.
   */
  readonly onFailure?: (failure: MapAdapterFailure, detail?: string) => void;
  /**
   * The raw position the user picked, before it is snapped to a vertex.
   *
   * `onSelect` answers "which vertex did they mean", which is what a viewer wants. An
   * editor needs the other question — "where on the map did they point" — because a new
   * waypoint is not on any existing line. Both are reported for one pick; the owner uses
   * whichever it needs, and the kit still knows nothing about waypoints or courses.
   */
  readonly onPickPosition?: (position: GeoPosition) => void;
}

/**
 * Every renderer report is stamped with the renderer it came from: the factory and the
 * basemap that created it. A new background map creates a new renderer, and what the old
 * one said — loaded, failed, drawn — must not be read as the new one's state. Comparing the
 * stamp during render stands in for a reset, so nothing has to be cleared on a change.
 */
interface RendererStamp {
  readonly factory: MapAdapterFactory;
  readonly basemap: BasemapDescriptor | null;
}

interface RendererReport extends RendererStamp {
  readonly phase: 'loaded' | 'unavailable';
  readonly failure: MapAdapterFailure | null;
  readonly detail: string | undefined;
}

interface EvidenceReport extends RendererStamp {
  readonly verdict: 'drawn' | 'not-drawn' | 'out-of-view' | 'unconfirmed';
  /** Which handed-over path this verdict is about (see `generation` in the view). */
  readonly generation: number;
  /** Line and point features drawn at the last idle; `null` when no idle ever came. */
  readonly lines: number | null;
  readonly points: number | null;
  /** Roles among the drawn lines, space separated; `null` when the renderer did not say. */
  readonly roles: string | null;
}

/**
 * The one sentence a sighted user reads and a screen reader announces. Each state says
 * something different, and none of them says the path is shown unless it was drawn.
 */
function statusMessage(
  status: MapViewStatus,
  failure: MapAdapterFailure | null,
  hasBasemap: boolean,
  problem: string,
): string {
  if (status === 'preparing') return '지도 준비 중';
  if (status === 'drawing')
    return hasBasemap
      ? '배경 지도를 불러왔습니다. 경로를 그리는 중입니다.'
      : '경로를 그리는 중입니다.';
  if (status === 'drawn')
    return hasBasemap ? '지도에 경로를 표시했습니다.' : '배경 지도 없이 경로를 표시했습니다.';
  if (status === 'out-of-view') return '경로가 지금 보이는 지도 영역 밖에 있습니다.';
  if (status === 'unconfirmed') return '경로가 지도에 그려졌는지 지금은 확인하지 못했습니다.';
  if (status === 'not-drawn')
    return '지도가 경로를 그리지 못했습니다. 아래 좌표 목록을 사용하세요.';
  if (status === 'empty') return '표시할 좌표가 없습니다.';
  if (status === 'invalid') return `좌표를 표시할 수 없습니다 (${problem}).`;
  if (failure === 'STYLE_LOAD_FAILED' || failure === 'BASEMAP_REJECTED')
    return '배경 지도를 불러오지 못해 지도를 표시할 수 없습니다. 아래 좌표 목록을 사용하세요.';
  if (failure === 'CONTEXT_LOST')
    return '지도 렌더러(WebGL)가 중단되어 지도를 표시할 수 없습니다. 아래 좌표 목록을 사용하세요.';
  return '이 브라우저에서 지도 렌더러(WebGL)를 사용할 수 없습니다. 아래 좌표 목록을 사용하세요.';
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
  renderDeadlineMs = defaultRenderDeadlineMs,
  confirmGraceMs = defaultConfirmGraceMs,
  createAdapter,
  onStatusChange,
  onFailure,
  onPickPosition,
}: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const [adapter, setAdapter] = useState<MapAdapterHandle | null>(null);
  const factory = createAdapter ?? defaultAdapterFactory;
  const [renderer, setRenderer] = useState<RendererReport | null>(null);
  const [evidence, setEvidence] = useState<EvidenceReport | null>(null);
  // The path generation whose confirmation grace ran out (see `defaultConfirmGraceMs`).
  const [overdue, setOverdue] = useState<number | null>(null);
  const rendererNow =
    renderer !== null && renderer.factory === factory && renderer.basemap === basemap
      ? renderer
      : null;
  const evidenceNow =
    evidence !== null && evidence.factory === factory && evidence.basemap === basemap
      ? evidence
      : null;

  const invalid = useMemo(
    () => paths.map((path) => validateMapPath(path)).find((result) => !result.ok) ?? null,
    [paths],
  );
  const built = useMemo(() => (invalid ? null : toFeatureCollection(paths)), [paths, invalid]);
  // The renderer is handed a collection only when its content changes, not whenever a
  // caller builds a new array with the same lines in it (the course editor does, on every
  // render). Without this, each re-render re-sent the data and restarted the render
  // deadline, so a map that never draws could stay "drawing" for as long as the screen
  // kept re-rendering. Holding the previous value this way is React's derived-state pattern.
  // Each distinct content gets the next generation number, so a verdict can say which
  // path it is about and a reader can wait for the verdict on the path now on screen.
  const builtKey = useMemo(() => (built ? collectionKey(built) : null), [built]);
  const [held, setHeld] = useState({ key: builtKey, collection: built, generation: 0 });
  if (held.key !== builtKey)
    setHeld({ key: builtKey, collection: built, generation: held.generation + 1 });
  const collection = held.key === builtKey ? held.collection : built;
  const generation = held.key === builtKey ? held.generation : held.generation + 1;
  // Unique per mount, so a remounted map's first path is not mistaken for the previous
  // mount's first path by a reader comparing generations.
  const instance = useId();
  const bounds = useMemo(() => (invalid ? null : computeBounds(paths)), [paths, invalid]);
  const marker = useMemo(() => selectedPosition(paths, selection), [paths, selection]);

  // Geometry problems are derived from the props, not stored as a second copy of state.
  // An empty path is decided here, before any renderer is asked: there is nothing it could
  // draw, so it never waits for a drawn feature.
  const status: MapViewStatus = invalid
    ? 'invalid'
    : paths.length === 0 || paths.every((path) => path.positions.length === 0)
      ? 'empty'
      : rendererNow === null
        ? 'preparing'
        : rendererNow.phase === 'unavailable'
          ? 'unavailable'
          : evidenceNow?.verdict === 'drawn' &&
              evidenceNow.generation !== generation &&
              overdue === generation
            ? 'drawing'
            : (evidenceNow?.verdict ?? 'drawing');

  // Latest callbacks without re-creating the renderer on every parent render.
  const latest = useRef({ onSelect, paths, onRenderIdle, onFailure, onPickPosition });
  useEffect(() => {
    latest.current = { onSelect, paths, onRenderIdle, onFailure, onPickPosition };
  }, [onSelect, paths, onRenderIdle, onFailure, onPickPosition]);

  // The collection last handed to the renderer, and the last one an idle confirmed. Read
  // only inside callbacks and timers, never during render.
  const handed = useRef<{ collection: MapPathFeatureCollection; generation: number } | null>(null);
  const confirmed = useRef<MapPathFeatureCollection | null>(null);
  // Whether the current renderer has ever drawn our geometry. Reset with each renderer.
  const drew = useRef(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let active = true;
    let handle: MapAdapterHandle | null = null;
    let observer: ResizeObserver | null = null;
    // Initialisation that has not returned a handle yet is cancelled through this signal,
    // so the adapter can remove its renderer itself.
    const controller = new AbortController();
    confirmed.current = null;
    drew.current = false;

    const fail = (reason: MapAdapterFailure, detail?: string) => {
      if (!active) return;
      setRenderer({ factory, basemap, phase: 'unavailable', failure: reason, detail });
      latest.current.onFailure?.(reason, detail);
    };

    factory({
      container: element,
      basemap,
      signal: controller.signal,
      // The style is in place: the background, not the path.
      onReady: () => {
        if (active)
          setRenderer({ factory, basemap, phase: 'loaded', failure: null, detail: undefined });
      },
      onFailure: fail,
      onPick: (position) => {
        if (!active) return;
        latest.current.onPickPosition?.(position);
        latest.current.onSelect(findNearestVertex(latest.current.paths, position));
      },
      onIdle: (info) => {
        if (!active) return;
        latest.current.onRenderIdle?.(info);
        const judged = judgeRender(info);
        if (judged === 'no-evidence') return;
        // Once this renderer has drawn our line, a later settled frame with nothing drawn
        // (zoomed out below a pixel, say) does not show that it cannot draw — nor that it
        // drew. Only a renderer that never drew (no worker, a broken layer) is said to be
        // unable to.
        if (judged === 'drawn') drew.current = true;
        const verdict = judged === 'not-drawn' && drew.current ? 'unconfirmed' : judged;
        confirmed.current = handed.current?.collection ?? null;
        const about = handed.current?.generation ?? 0;
        const lines = info.renderedLineFeatures;
        const points = info.renderedPointFeatures;
        const roles = info.renderedLineRoles ? info.renderedLineRoles.join(' ') : null;
        setEvidence((previous) =>
          previous !== null &&
          previous.factory === factory &&
          previous.basemap === basemap &&
          previous.verdict === verdict &&
          previous.generation === about &&
          previous.lines === lines &&
          previous.points === points &&
          previous.roles === roles
            ? previous
            : { factory, basemap, verdict, generation: about, lines, points, roles },
        );
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
          // A resize only resizes. It never refits: the viewport the user chose stays.
          observer = new ResizeObserver(() => created.resize());
          observer.observe(element);
        }
      })
      .catch((error: unknown) =>
        // The adapter classifies the failures that stop initialisation; anything else is
        // reported as the renderer being unavailable rather than guessed at.
        fail(
          error instanceof MapAdapterError ? error.failure : 'RENDERER_UNAVAILABLE',
          error instanceof Error ? error.message : undefined,
        ),
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
  const detail = rendererNow?.detail;
  useEffect(() => {
    onStatusChange?.(status, detail);
  }, [status, detail, onStatusChange]);

  useEffect(() => {
    if (!adapter || !collection) return;
    handed.current = { collection, generation };
    adapter.setPaths(collection);
  }, [adapter, collection, generation]);

  // A handed-over path that nothing confirms within the deadline. A renderer without its
  // worker loads its style and then never settles, so on a renderer that has never drawn
  // this silence becomes the stated failure `not-drawn` instead of an indefinite "drawing".
  // On a renderer that HAS drawn, the same silence proves nothing about its ability: a new
  // path off screen while background tiles are slow produces it too (M2-01q review B1). It
  // is then `unconfirmed` — neither the false alarm "cannot draw" nor the false comfort of
  // keeping "drawn". A later data change keeps the current verdict on screen (no
  // announcement per edit) until confirmed or until this deadline.
  useEffect(() => {
    if (!adapter || !collection || collection.features.length === 0) return;
    const timer = setTimeout(() => {
      if (confirmed.current === collection) return;
      setEvidence({
        factory,
        basemap,
        verdict: drew.current ? 'unconfirmed' : 'not-drawn',
        generation,
        lines: null,
        points: null,
        roles: null,
      });
    }, renderDeadlineMs);
    return () => clearTimeout(timer);
  }, [adapter, collection, generation, renderDeadlineMs, factory, basemap]);

  // After the grace, a "drawn" about the previous path no longer speaks for this one.
  useEffect(() => {
    if (!adapter || !collection || collection.features.length === 0) return;
    const timer = setTimeout(() => {
      if (confirmed.current !== collection) setOverdue(generation);
    }, confirmGraceMs);
    return () => clearTimeout(timer);
  }, [adapter, collection, generation, confirmGraceMs]);

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

  const message = statusMessage(
    status,
    rendererNow?.failure ?? null,
    basemap !== null,
    invalid && !invalid.ok ? invalid.problem : 'INVALID',
  );

  return (
    <section
      className={styles.root}
      aria-label={label}
      data-map-status={status}
      data-rendered-lines={evidenceNow?.lines ?? undefined}
      data-rendered-points={evidenceNow?.points ?? undefined}
      data-rendered-line-roles={evidenceNow?.roles ?? undefined}
      data-paths-generation={`${instance}${generation}`}
      data-evidence-generation={
        evidenceNow === null ? undefined : `${instance}${evidenceNow.generation}`
      }
    >
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

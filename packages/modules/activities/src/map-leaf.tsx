'use client';

/**
 * The module's one map leaf, isolated. Shared by the local-file preview and the stored
 * activity track: both compose this leaf explicitly instead of passing a mode flag to a
 * single screen.
 *
 * Two failure modes are handled here rather than in the screen. The adapter's own
 * failures come back through `onStatusChange`, but a rejected lazy chunk never reaches
 * the adapter at all: it rejects the `lazy()` promise, and without a boundary React
 * propagates that past the screen and takes the summary down with it. The summary must
 * stay usable when the map fails, so the boundary lives at the leaf.
 */
import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import type { BasemapDescriptor } from '@workout/geo-kit/basemap';
import type { MapAdapterFactory, MapAdapterFailure } from '@workout/geo-kit/map-adapter';
import type { MapPath, MapSelection } from '@workout/geo-kit/map-path';
import type { MapViewProps, MapViewStatus } from '@workout/geo-kit/map-view';

/** The renderer leaf itself. Created once, at module scope, never during a render. */
const DefaultMapView = lazy(() =>
  import('@workout/geo-kit/map-view').then((module) => ({ default: module.MapView })),
);

class MapBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    // The message belongs to the boundary's own state, so it is shown exactly while the
    // renderer is gone and disappears when the boundary is remounted for a new recording.
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

export interface MapLeafProps {
  readonly label: string;
  readonly paths: readonly MapPath[];
  readonly selection: MapSelection | null;
  readonly onSelect: (selection: MapSelection | null) => void;
  readonly basemap: BasemapDescriptor | null;
  readonly fitRequest: number;
  readonly onStatusChange: (status: MapViewStatus) => void;
  /** Classified renderer failure, so an owner can separate WebGL from the background map. */
  readonly onFailure?: (failure: MapAdapterFailure, detail?: string) => void;
  /** Shown in place of the renderer when it could not be loaded at all. */
  readonly loadFailureFallback: ReactNode;
  /** Number of path features the renderer actually drew, for the screen's status line. */
  readonly onRenderIdle: (info: { readonly renderedPathFeatures: number }) => void;
  readonly createAdapter?: MapAdapterFactory;
  /**
   * Renderer component override. Injected by tests to exercise the chunk-load failure
   * path; production always uses the module-scope lazy leaf above.
   */
  readonly mapView?: ComponentType<MapViewProps>;
}

export function MapLeaf({ mapView, ...props }: MapLeafProps) {
  const MapView = mapView ?? DefaultMapView;
  return (
    <MapBoundary fallback={props.loadFailureFallback}>
      <Suspense fallback={<p role="status">지도 구성 요소를 불러오는 중입니다.</p>}>
        <MapView
          label={props.label}
          paths={props.paths}
          selection={props.selection}
          onSelect={props.onSelect}
          basemap={props.basemap}
          fitRequest={props.fitRequest}
          onStatusChange={props.onStatusChange}
          onRenderIdle={props.onRenderIdle}
          {...(props.onFailure ? { onFailure: props.onFailure } : {})}
          {...(props.createAdapter ? { createAdapter: props.createAdapter } : {})}
        />
      </Suspense>
    </MapBoundary>
  );
}

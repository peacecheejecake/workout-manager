'use client';

/**
 * The courses module's own map leaf.
 *
 * It is deliberately this module's and not a shared import from the activities module:
 * modules do not reach into each other's private files, and the two leaves exist for
 * different screens. What they share is the kit underneath.
 *
 * Two failure modes are handled here rather than in the screen. The adapter's own failures
 * arrive through `onStatusChange`, but a rejected lazy chunk never reaches the adapter at
 * all — it rejects the `lazy()` promise, and without a boundary React would take the whole
 * course screen down with it. The list, the waypoint editor and the save flow must stay
 * usable when the renderer does not load, so the boundary lives at the leaf.
 */
import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import type { BasemapDescriptor } from '@workout/geo-kit/basemap';
import type { MapAdapterFactory, MapAdapterFailure } from '@workout/geo-kit/map-adapter';
import type { GeoPosition, MapPath, MapSelection } from '@workout/geo-kit/map-path';
import type { MapViewProps, MapViewStatus } from '@workout/geo-kit/map-view';
import type { MapRenderIdleInfo } from '@workout/geo-kit/render-evidence';

/** Created once, at module scope, never during a render. */
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
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

export interface CourseMapLeafProps {
  readonly label: string;
  readonly paths: readonly MapPath[];
  readonly selection: MapSelection | null;
  readonly onSelect: (selection: MapSelection | null) => void;
  /** Where the owner pointed, which is where a new waypoint would go. */
  readonly onPickPosition?: (position: GeoPosition) => void;
  readonly basemap: BasemapDescriptor | null;
  readonly fitRequest: number;
  readonly onStatusChange: (status: MapViewStatus) => void;
  readonly onFailure?: (failure: MapAdapterFailure, detail?: string) => void;
  /**
   * What the renderer drew at each idle (`queryRenderedFeatures` over the path layers,
   * never the basemap). The map's own status already turns this into "drawn" or "not
   * drawn"; this is for an owner that wants the raw observation.
   */
  readonly onRenderIdle?: (info: MapRenderIdleInfo) => void;
  readonly loadFailureFallback: ReactNode;
  /** Injected by tests to exercise the chunk-load failure path. */
  readonly mapView?: ComponentType<MapViewProps>;
  readonly createAdapter?: MapAdapterFactory;
}

export function CourseMapLeaf({ mapView, ...props }: CourseMapLeafProps) {
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
          {...(props.onPickPosition ? { onPickPosition: props.onPickPosition } : {})}
          {...(props.onFailure ? { onFailure: props.onFailure } : {})}
          {...(props.onRenderIdle ? { onRenderIdle: props.onRenderIdle } : {})}
          {...(props.createAdapter ? { createAdapter: props.createAdapter } : {})}
        />
      </Suspense>
    </MapBoundary>
  );
}

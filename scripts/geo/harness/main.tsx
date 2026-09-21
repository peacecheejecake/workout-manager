/**
 * Measurement harness for the self-hosted basemap (M2-01d).
 *
 * It renders the real `@workout/geo-kit` MapView against tiles, style, glyphs and sprite
 * served from this origin only. It is a scripts/ fixture, not product code, and it is
 * never bundled into an application shell.
 *
 * The track is synthetic and served by the harness server. No personal GPS is used.
 */
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MapView } from '../../../packages/experience/geo-kit/src/map-view.js';
import type { MapPath, MapSelection } from '../../../packages/experience/geo-kit/src/map-path.js';
import type { MapViewStatus } from '../../../packages/experience/geo-kit/src/map-view.js';

interface HarnessBridge {
  status: MapViewStatus;
  statusAt: Record<string, number>;
  diagnostics: string[];
  /** One entry per renderer idle: when it settled and how much of the path was drawn. */
  idles: { at: number; renderedPathFeatures: number }[];
  cspViolations: string[];
  trackPoints: number;
  frames: number[];
  startFrameRecording(): void;
  stopFrameRecording(): number[];
}

declare global {
  interface Window {
    __geoHarness?: HarnessBridge;
  }
}

const bridge: HarnessBridge = {
  status: 'preparing',
  statusAt: {},
  diagnostics: [],
  idles: [],
  cspViolations: [],
  trackPoints: 0,
  frames: [],
  startFrameRecording() {
    bridge.frames = [];
    let previous = performance.now();
    const tick = (now: number) => {
      bridge.frames.push(now - previous);
      previous = now;
      if (recording) requestAnimationFrame(tick);
    };
    recording = true;
    requestAnimationFrame(tick);
  },
  stopFrameRecording() {
    recording = false;
    return bridge.frames;
  },
};
let recording = false;
window.__geoHarness = bridge;
// A blocked request under CSP is not a console message we can rely on; record the event.
window.document.addEventListener('securitypolicyviolation', (event) => {
  bridge.cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`.slice(0, 200));
});

interface TrackDocument {
  readonly deploymentId: string;
  readonly positions: [number, number][];
  readonly breaks: number[];
  readonly attribution: string;
}

function Harness() {
  const [document, setDocument] = useState<TrackDocument | null>(null);
  const [selection, setSelection] = useState<MapSelection | null>(null);

  useEffect(() => {
    // Same-origin only; the harness never learns any other URL.
    void fetch('/track.json')
      .then((response) => response.json())
      .then((value: TrackDocument) => {
        bridge.trackPoints = value.positions.length;
        bridge.statusAt.trackLoaded = performance.now();
        setDocument(value);
      });
  }, []);

  const paths = useMemo<MapPath[]>(
    () =>
      document
        ? [
            {
              id: 'synthetic-long-track',
              role: 'recorded',
              revision: 'r1',
              positions: document.positions,
              breaks: document.breaks,
            },
          ]
        : [],
    [document],
  );

  const basemap = useMemo(
    () =>
      document
        ? {
            styleUrl: `/map/basemap/${document.deploymentId}/style.json`,
            attribution: document.attribution,
            localIdeographFontFamily: "'Apple SD Gothic Neo', sans-serif",
          }
        : null,
    [document],
  );

  if (!document || !basemap) return <p>합성 트랙 준비 중</p>;
  return (
    <div style={{ ['--geo-kit-map-height' as string]: '600px' }}>
      <MapView
        label="합성 장거리 트랙"
        paths={paths}
        selection={selection}
        onSelect={setSelection}
        basemap={basemap}
        onRenderIdle={(info) => {
          bridge.idles.push({
            at: performance.now(),
            renderedPathFeatures: info.renderedPathFeatures,
          });
        }}
        onStatusChange={(status, detail) => {
          bridge.status = status;
          bridge.statusAt[status] = performance.now();
          if (detail) bridge.diagnostics.push(detail);
        }}
      />
    </div>
  );
}

/**
 * Positive control for the probe: install the kit's transport with a fetch that FOLLOWS
 * redirects. The measurement must then detect the external request, which is what proves
 * the redirect control is not vacuous. Test-only, never reachable in product code.
 */
const permissiveTransport = new URLSearchParams(window.location.search).has('permissive');

const container = window.document.getElementById('root');
if (container) {
  // MapLibre 6 loads its worker as a separate same-origin ESM file. The probe copies it
  // next to the bundle, exactly as the existing UI spike does for the two app shells.
  void import('../../../packages/experience/geo-kit/src/maplibre-adapter.js').then((module) => {
    module.configureMapWorker('/assets/maplibre-gl-worker.mjs');
    if (permissiveTransport) {
      // Installed first; the kit's own call is then a no-op for this origin.
      module.installSelfHostedTransport(window.location.origin, (input, init) =>
        fetch(input, { ...init, redirect: 'follow' }),
      );
    }
    createRoot(container).render(<Harness />);
  });
}

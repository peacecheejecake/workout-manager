import { SpikeWorkspace } from '@workout/ui-spike/workspace';

export default function Page() {
  return (
    <main className="wm-page">
      <SpikeWorkspace workerUrl="/dist/maplibre/maplibre-gl-worker.mjs" />
    </main>
  );
}

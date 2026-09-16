import { useEffect, useRef, useState } from 'react';
import { Map, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import styles from './workspace.module.css';

/** No tiles, personal coordinates or provider requests: this tests the renderer and worker. */
export function MapPanel({ workerUrl }: { workerUrl: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let map: Map | undefined;
    let observer: ResizeObserver | undefined;
    let active = true;
    const fail = () => {
      if (active) setStatus('unavailable');
    };
    const timeout = setTimeout(fail, 15000);
    try {
      const tokens = getComputedStyle(element);
      const canvas = tokens.getPropertyValue('--canvas').trim() || '#edf1f6';
      const accent = tokens.getPropertyValue('--accent').trim() || '#6256b8';
      setWorkerUrl(workerUrl);
      map = new Map({
        container: element,
        center: [126.98, 37.566],
        zoom: 15,
        attributionControl: false,
        cooperativeGestures: true,
        style: {
          version: 8,
          sources: {
            sample: {
              type: 'geojson',
              data: {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates: [
                    [126.978, 37.566],
                    [126.98, 37.568],
                    [126.982, 37.566],
                  ],
                },
              },
            },
          },
          layers: [
            { id: 'background', type: 'background', paint: { 'background-color': canvas } },
            {
              id: 'sample-line',
              type: 'line',
              source: 'sample',
              paint: { 'line-color': accent, 'line-width': 6 },
            },
          ],
        },
      });
      const current = map;
      current.on('error', fail);
      current.on('idle', () => {
        if (active && current.queryRenderedFeatures({ layers: ['sample-line'] }).length > 0) {
          clearTimeout(timeout);
          setStatus('ready');
        }
      });
      current.getCanvas().addEventListener('webglcontextlost', fail);
      observer = new ResizeObserver(() => current.resize());
      observer.observe(element);
    } catch {
      fail();
    }
    return () => {
      active = false;
      clearTimeout(timeout);
      observer?.disconnect();
      map?.remove();
    };
  }, [workerUrl]);
  return (
    <section aria-label="지도 worker 검증" className={styles.card}>
      <h2>지도 렌더링</h2>
      <p>공개 합성 좌표의 선입니다. 도로 지도·계산된 보행 경로가 아닙니다.</p>
      <div ref={container} className={styles.map} aria-label="합성 선 지도" />
      <p role="status">
        {status === 'ready'
          ? '지도 worker와 합성 선 표시 확인'
          : status === 'unavailable'
            ? '지도 표시 불가 · 아래 좌표 목록은 계속 사용할 수 있습니다.'
            : '지도 준비 중'}
      </p>
      <ol aria-label="합성 좌표 목록">
        <li>126.978, 37.566</li>
        <li>126.980, 37.568</li>
        <li>126.982, 37.566</li>
      </ol>
      <p>렌더러: MapLibre GL JS · 좌표: 개발용 합성 자료 · 외부 tile 요청 없음</p>
    </section>
  );
}

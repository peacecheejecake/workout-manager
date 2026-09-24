import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import {
  recordedTrackSchema,
  type MapPath,
  type RecordedTrack,
  type TrackPosition,
} from '@workout/contracts/tracks';
import type {
  MapAdapterFactory,
  MapAdapterHandle,
  MapAdapterOptions,
} from '@workout/geo-kit/map-adapter';
import type { MapPathFeatureCollection } from '@workout/geo-kit/map-path';
import { buildMapPath } from '@workout/track-parsing';
import { ActivityTrackPanel } from '../src/activity-track-panel';
import { DetailSelectionProvider } from '../src/detail-selection-provider';
import { summarizeTrack } from '../src/track-preview-geometry';
import { activityId, at, sourceId, storedRevision } from './stored-track-fixtures';

type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});
const scope = ['users', 'alice', 'sessions', 'session-a'] as const;

/** A renderer stand-in that records what the real MapView hands the adapter. */
function adapterProbe() {
  const created: MapAdapterOptions[] = [];
  const setPaths: MapPathFeatureCollection[] = [];
  const factory: MapAdapterFactory = (options) => {
    created.push(options);
    options.onReady();
    const handle: MapAdapterHandle = {
      setPaths: (collection) => setPaths.push(collection),
      setSelection: () => undefined,
      fitBounds: () => undefined,
      resize: () => undefined,
      destroy: () => undefined,
    };
    return Promise.resolve(handle);
  };
  return { factory, created, setPaths };
}

function renderPanel(handler: (input: TransportRequest) => Reply) {
  const request = vi.fn((input: TransportRequest) => Promise.resolve(handler(input)));
  const probe = adapterProbe();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DetailSelectionProvider identity="activity-1">
        <ActivityTrackPanel
          athleteId="alice"
          sessionId="session-a"
          transport={{ request }}
          activityId={activityId}
          activitySourceRevision={1}
          details={null}
          scope={scope}
          basemap={null}
          createMapAdapter={probe.factory}
        />
      </DetailSelectionProvider>
    </QueryClientProvider>,
  );
  return { request, probe };
}

/**
 * V2-A17 (05_implementation_requirements): "CSV 요약에 route 없음 | route unavailable,
 * 직선 route 생성 금지". There is no CSV importer in this product; the summary-only activity
 * it describes is any activity with a distance and a duration but no stored recording.
 */
describe('a summary-only activity has no route', () => {
  it('draws nothing, mounts no renderer and asks for no geometry', async () => {
    const { request, probe } = renderPanel(() =>
      reply({ error: { code: 'ACTIVITY_TRACK_NOT_FOUND' } }, 404),
    );
    expect(await screen.findByText(/이 활동에는 저장된 경로가 없습니다/)).toBeVisible();
    // Give any lazily mounted renderer the chance to appear before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 150));
    // No renderer at all — not a drawn one and not one still loading.
    expect(screen.queryByRole('region', { name: '저장된 활동 경로' })).toBeNull();
    expect(screen.queryByText(/지도 구성 요소/)).toBeNull();
    expect(probe.created).toEqual([]);
    expect(probe.setPaths).toEqual([]);
    expect(document.querySelector('canvas, svg polyline, svg path')).toBeNull();
    // Only the metadata was read: no geometry object was requested or invented.
    expect(request.mock.calls.map(([input]) => input.path)).toEqual([
      `/bff/v1/activities/${activityId}/track`,
    ]);
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
});

/**
 * P8-simplify (map plan §8): "zoom/LOD 변경 전후 실제 요약·집계 동일". The server stores one
 * display level; a coarser level must change what is drawn and nothing in the summary.
 */
const zigzag = (index: number): TrackPosition => [
  Number((127.02 + index * 0.0002).toFixed(7)),
  Number((37.5 + (index % 2) * 0.00006).toFixed(7)),
];
function recording(): RecordedTrack {
  const samples = Array.from({ length: 41 }, (_, index) => ({
    sampleId: `0:${index}`,
    sourceIndex: index,
    recordedAt: at(index),
    // Sample 20 has no fix: the recording is split around it and never bridged.
    position: index === 20 ? null : zigzag(index),
    elevationMeters: null,
    distanceMeters: index * 19,
    speedMetersPerSecond: null,
    // Uneven values, so an average over any subset of samples shows up in the summary.
    heartRateBpm: index === 20 ? 199 : 100 + ((index * 37) % 61),
    lapIndex: null,
    detailLink: null,
  }));
  return recordedTrackSchema.parse({
    schemaVersion: 1,
    provenance: {
      kind: 'activity-source',
      activityId,
      sourceId,
      sourceRevision: 1,
      trackRevision: 1,
    },
    sourceKind: 'fit-session',
    name: 'LOD 기록',
    samples,
    segments: [
      {
        index: 0,
        startReason: 'stream-start',
        sampleIds: samples.slice(0, 20).map((s) => s.sampleId),
      },
      { index: 1, startReason: 'missing-position', sampleIds: ['0:20'] },
      {
        index: 2,
        startReason: 'missing-position',
        sampleIds: samples.slice(21).map((s) => s.sampleId),
      },
    ],
    segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
    distances: { deviceReportedMeters: 760, recomputedFromPositionsMeters: 781.4 },
  });
}

async function renderedLevel(track: RecordedTrack, path: MapPath) {
  const { probe } = renderPanel((input) => {
    if (input.path.endsWith('/track'))
      return reply({
        status: 'available',
        track: storedRevision({ positionedSampleCount: 40 }),
      });
    if (input.path.endsWith('variant=normalized')) return reply(track);
    return reply(path);
  });
  await screen.findByRole('region', { name: '저장된 활동 경로' });
  await waitFor(() => expect(probe.setPaths.length).toBeGreaterThan(0));
  const summary = screen.getByText('GPS 재계산 거리').closest('dl');
  if (!summary) throw new Error('no summary list');
  const drawn = probe.setPaths.at(-1);
  const lines = (drawn?.features ?? []).flatMap((feature) =>
    feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : [],
  );
  const result = {
    summary: summary.textContent,
    vertices: lines.reduce((sum, line) => sum + line.length, 0),
    lines,
  };
  cleanup();
  return result;
}

describe('display level of detail never moves the summary', () => {
  it('keeps every summary number while a coarser level draws fewer vertices', async () => {
    const track = recording();
    const snapshot = JSON.stringify(track);
    const levels = [0, 3, 50].map((toleranceMeters) => buildMapPath(track, { toleranceMeters }));
    const rendered = [];
    for (const path of levels) rendered.push(await renderedLevel(track, path));

    // The level really changed what was drawn...
    const counts = rendered.map((level) => level.vertices);
    expect(counts[0]).toBe(40);
    expect(counts[2]).toBeLessThan(counts[0] ?? 0);
    expect(new Set(levels.map((path) => path.displayedPolylineLengthMeters)).size).toBeGreaterThan(
      1,
    );
    // ...the gap stays a gap at every level: two lines, never one bridging sample 20...
    for (const level of rendered) expect(level.lines).toHaveLength(2);
    // ...and every drawn vertex is still a stored sample at its stored position.
    const byId = new Map(track.samples.map((sample) => [sample.sampleId, sample.position]));
    for (const path of levels)
      path.vertexSampleIds.forEach((ids, line) =>
        ids.forEach((id, vertex) =>
          expect(path.geometry.coordinates[line]?.[vertex]).toEqual(byId.get(id)),
        ),
      );

    // The summary is identical at every level and is the samples' own summary.
    const [first, ...others] = rendered.map((level) => level.summary);
    for (const other of others) expect(other).toBe(first);
    const expected = summarizeTrack(track);
    expect(first).toContain(`${Math.round(expected.recomputedDistanceMeters ?? -1)}m`);
    expect(first).toContain(`${Math.round(expected.averageHeartRateBpm ?? -1)}bpm`);
    expect(first).toContain(`${expected.elapsedSeconds}초`);
    expect(first).toContain(`${Math.round(expected.averagePaceSecondsPerKilometer ?? -1)}초/km`);
    expect(JSON.stringify(track)).toBe(snapshot);
  });
});

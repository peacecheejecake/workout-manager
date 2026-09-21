import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MapAdapterFactory, MapAdapterHandle } from '@workout/geo-kit/map-adapter';
import type { MapPathFeatureCollection } from '@workout/geo-kit/map-path';
import { parseTrackFile } from '@workout/track-parsing';
import { LocalTrackPreview } from '../src/track-preview.js';
import { createBrowserTrackParser } from '../src/track-preview-browser.js';
import { createInlineTrackParser, TrackPreviewError } from '../src/track-preview-parser.js';

/**
 * End to end through the real parser.
 *
 * jsdom has no `Worker`, so these tests pass an **explicit** calling-thread parser around
 * the same `parseTrackFile` the worker entry calls. The shells never make that choice
 * implicitly — the last test here fixes that. These are real GPX bytes, not a contract
 * fixture: the file is sniffed, parsed, normalized, validated and drawn. The real-worker
 * path is covered by `tests/identity/track-preview.spec.ts`.
 */
const realParser = () =>
  createInlineTrackParser((bytes, filename) => parseTrackFile(bytes, { filename }));
const GPX11 = 'http://www.topografix.com/GPX/1/1';

function gpx(body: string): Uint8Array {
  return new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" xmlns="${GPX11}">${body}</gpx>`,
  );
}

function point(longitude: number, latitude: number, seconds: number, heartRate?: number): string {
  const time = new Date(Date.parse('2026-03-01T00:00:00Z') + seconds * 1000).toISOString();
  return (
    `<trkpt lat="${latitude}" lon="${longitude}"><time>${time}</time>` +
    (heartRate === undefined
      ? ''
      : `<extensions xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">` +
        `<gpxtpx:TrackPointExtension><gpxtpx:hr>${heartRate}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>`) +
    `</trkpt>`
  );
}

const continuous = gpx(
  `<trk><name>실제 GPX 기록</name><trkseg>${[0, 1, 2, 3]
    .map((index) => point(127.02 + index / 1000, 37.5 + index / 1000, index * 10, 140 + index))
    .join('')}</trkseg></trk>`,
);

// Two `trkseg` elements: the parser keeps them as separate segments and the viewer must
// draw two features rather than one line joined across the break.
const twoSegments = gpx(
  `<trk><trkseg>${point(127.02, 37.5, 0)}${point(127.021, 37.501, 10)}</trkseg>` +
    `<trkseg>${point(127.05, 37.52, 20)}${point(127.051, 37.521, 30)}</trkseg></trk>`,
);

function upload(bytes: Uint8Array, name: string): File {
  return new File([bytes.slice().buffer as ArrayBuffer], name, {
    type: 'application/octet-stream',
  });
}

function stubAdapter() {
  const collections: MapPathFeatureCollection[] = [];
  const factory: MapAdapterFactory = async (options) => {
    options.onReady();
    const handle: MapAdapterHandle = {
      setPaths: (collection) => collections.push(collection),
      setSelection: () => undefined,
      fitBounds: () => undefined,
      resize: () => undefined,
      destroy: () => undefined,
    };
    return handle;
  };
  return { factory, collections };
}

const session = { athleteId: 'athlete-1', sessionId: 'session-1' } as const;

describe('local track preview with real file bytes', () => {
  it('parses real GPX bytes in memory and shows the recording with local-file provenance', async () => {
    const user = userEvent.setup();
    const adapter = stubAdapter();
    render(
      <LocalTrackPreview {...session} parser={realParser()} createMapAdapter={adapter.factory} />,
    );
    await user.upload(screen.getByTestId('track-preview-file'), upload(continuous, 'run.gpx'));

    await screen.findByText(/로컬 파일 미리보기 · 저장 안 함 · 활동 ID 없음 \(gpx-track-v1\)/);
    // The digest on screen is the real SHA-256 of those bytes, not a fabricated id.
    const expected = [
      ...new Uint8Array(
        await crypto.subtle.digest('SHA-256', continuous.slice().buffer as ArrayBuffer),
      ),
    ]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    expect(screen.getByText(`gpx · ${expected.slice(0, 12)}…`)).toBeInTheDocument();

    expect(screen.getByText('전체 4개 · 위치 있음 4개 · 구간 1개')).toBeInTheDocument();
    // 140+141+142+143 = 566 over four samples: an unweighted mean of 141.5, shown rounded.
    expect(screen.getByText('142bpm')).toBeInTheDocument();
    expect(screen.getByText('30초')).toBeInTheDocument();
    // No device distance in the file: the viewer reports unknown instead of using GPS.
    expect(screen.getAllByText('미확인').length).toBeGreaterThan(0);
    await waitFor(() => expect(adapter.collections.length).toBeGreaterThan(0));
    const features = adapter.collections.at(-1)?.features ?? [];
    expect(features).toHaveLength(1);
    expect(features[0]?.geometry.type).toBe('LineString');
  });

  it('draws two features for two trkseg elements and never bridges them', async () => {
    const user = userEvent.setup();
    const adapter = stubAdapter();
    render(
      <LocalTrackPreview {...session} parser={realParser()} createMapAdapter={adapter.factory} />,
    );
    await user.upload(screen.getByTestId('track-preview-file'), upload(twoSegments, 'two.gpx'));
    await screen.findByText(/기록이 1회 끊겼습니다/);
    expect(screen.getByText('GPX trkseg 분리 1회')).toBeInTheDocument();
    await waitFor(() => expect(adapter.collections.length).toBeGreaterThan(0));
    expect(adapter.collections.at(-1)?.features).toHaveLength(2);
  });

  it('rejects an archive by content, whatever the file is called', async () => {
    const user = userEvent.setup();
    render(<LocalTrackPreview {...session} parser={realParser()} />);
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await user.upload(screen.getByTestId('track-preview-file'), upload(zip, 'track.gpx'));
    await screen.findByText(/TRACK_ARCHIVE_REJECTED/);
  });

  it('rejects a GPX whose DOCTYPE declares an external entity', async () => {
    const user = userEvent.setup();
    render(<LocalTrackPreview {...session} parser={realParser()} />);
    const xxe = new TextEncoder().encode(
      `<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY x SYSTEM "file:///etc/passwd">]>` +
        `<gpx version="1.1" xmlns="${GPX11}"><trk><trkseg></trkseg></trk></gpx>`,
    );
    await user.upload(screen.getByTestId('track-preview-file'), upload(xxe, 'evil.gpx'));
    await screen.findByText(/TRACK_XML_DTD_BLOCKED/);
  });

  it('keeps a waypoint-only file out of the recorded states instead of inventing a track', async () => {
    const user = userEvent.setup();
    render(<LocalTrackPreview {...session} parser={realParser()} />);
    await user.upload(
      screen.getByTestId('track-preview-file'),
      upload(gpx('<wpt lat="37.5" lon="127.0"><name>집</name></wpt>'), 'waypoint.gpx'),
    );
    // The parser returns waypoints with no recorded track; the viewer must not draw one.
    await screen.findByText('표시할 기록 트랙이 없습니다.');
    expect(screen.queryByRole('heading', { name: '경로' })).not.toBeInTheDocument();
  });
});

describe('the browser parser does not silently leave the worker', () => {
  it('reports PREVIEW_PARSER_UNAVAILABLE when the runtime has no Worker', async () => {
    // jsdom provides no `Worker`. A calling-thread parse would keep neither the caller's
    // deadline nor a usable cancel button, so it must not be chosen implicitly.
    expect(typeof globalThis.Worker).toBe('undefined');
    const parser = createBrowserTrackParser();
    await expect(
      parser.parse({ bytes: continuous, filename: 'run.gpx' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'PREVIEW_PARSER_UNAVAILABLE' });
  });

  it('shows that failure on screen instead of parsing on the interface thread', async () => {
    const user = userEvent.setup();
    render(<LocalTrackPreview {...session} parser={createBrowserTrackParser()} />);
    await user.upload(screen.getByTestId('track-preview-file'), upload(continuous, 'run.gpx'));
    await screen.findByText(/PREVIEW_PARSER_UNAVAILABLE/);
    expect(screen.queryByRole('heading', { name: '경로' })).not.toBeInTheDocument();
    expect(TrackPreviewError.name).toBe('TrackPreviewError');
  });
});

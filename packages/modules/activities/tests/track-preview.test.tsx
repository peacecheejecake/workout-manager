import { lazy } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MapAdapterFactory, MapAdapterHandle } from '@workout/geo-kit/map-adapter';
import type { MapBounds, MapPathFeatureCollection } from '@workout/geo-kit/map-path';
import { LocalTrackPreview } from '../src/track-preview.js';
import {
  TrackPreviewError,
  type TrackPreviewParser,
  type TrackPreviewRequest,
} from '../src/track-preview-parser.js';
import {
  gappedPreviewFile,
  longPreviewFile,
  multiTrackPreviewFile,
  noGpsPreviewFile,
  normalPreviewFile,
  requireItem,
} from './track-preview-fixtures.js';

interface AdapterLog {
  readonly created: number;
  readonly fits: MapBounds[];
  readonly collections: MapPathFeatureCollection[];
  readonly selections: unknown[];
}

function stubAdapter(options: { fail?: boolean; failFirstOnly?: boolean } = {}): {
  factory: MapAdapterFactory;
  log: AdapterLog;
} {
  const log = {
    created: 0,
    fits: [] as MapBounds[],
    collections: [] as MapPathFeatureCollection[],
    selections: [] as unknown[],
  };
  let creations = 0;
  const factory: MapAdapterFactory = async (adapterOptions) => {
    creations += 1;
    if (options.fail || (options.failFirstOnly && creations === 1)) {
      adapterOptions.onFailure('RENDERER_UNAVAILABLE', 'no webgl');
      throw new Error('RENDERER_UNAVAILABLE');
    }
    log.created += 1;
    adapterOptions.onReady();
    const handle: MapAdapterHandle = {
      setPaths: (collection) => log.collections.push(collection),
      setSelection: (position) => log.selections.push(position),
      fitBounds: (bounds) => log.fits.push(bounds),
      resize: () => undefined,
      destroy: () => undefined,
    };
    return handle;
  };
  return { factory, log: log as AdapterLog };
}

function resolvingParser(file = normalPreviewFile()) {
  const seen: TrackPreviewRequest[] = [];
  const parser: TrackPreviewParser = {
    parse(request) {
      seen.push(request);
      return Promise.resolve(file);
    },
  };
  return { parser, seen };
}

function file(name: string, content = 'not really a gpx'): File {
  return new File([content], name, { type: 'text/plain' });
}

const session = { athleteId: 'athlete-1', sessionId: 'session-1' } as const;

// A renderer chunk that never loads. Created at module scope, like the real lazy leaf.
const FailingMapView = lazy(() => Promise.reject(new Error('CHUNK_LOAD_FAILED'))) as never;

// A renderer the test can break and repair, to show a failure report does not outlive
// the mount that failed.
let rendererShouldFail = false;
function FlakyMapView() {
  if (rendererShouldFail) throw new Error('CHUNK_LOAD_FAILED');
  return <p data-testid="flaky-map-ready">지도 준비됨</p>;
}

describe('local track preview screen', () => {
  it('starts empty and never contacts a transport', async () => {
    const { parser } = resolvingParser();
    render(<LocalTrackPreview {...session} parser={parser} />);
    expect(screen.getByText('아직 파일을 선택하지 않았습니다.')).toBeInTheDocument();
    expect(screen.getByText(/업로드하지 않으며/)).toBeInTheDocument();
  });

  it('parses the chosen file in memory and shows the summary with local-file provenance', async () => {
    const user = userEvent.setup();
    const { parser, seen } = resolvingParser();
    const adapter = stubAdapter();
    render(<LocalTrackPreview {...session} parser={parser} createMapAdapter={adapter.factory} />);
    await user.upload(screen.getByTestId('track-preview-file'), file('run.gpx'));
    await screen.findByText(/로컬 파일 미리보기 · 저장 안 함 · 활동 ID 없음/);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.bytes).toBeInstanceOf(Uint8Array);
    // Device and recomputed distances are separate values on screen.
    expect(screen.getByText('400m')).toBeInTheDocument();
    expect(screen.getByText('398m')).toBeInTheDocument();
    expect(screen.getByText('450초/km')).toBeInTheDocument();
    await waitFor(() => expect(adapter.log.collections.length).toBeGreaterThan(0));
    expect(adapter.log.collections.at(-1)?.features).toHaveLength(1);
  });

  it('does not trust the extension: a .txt file is still handed to the parser as bytes', async () => {
    const user = userEvent.setup();
    const { parser, seen } = resolvingParser();
    render(<LocalTrackPreview {...session} parser={parser} />);
    await user.upload(screen.getByTestId('track-preview-file'), file('notes.txt'));
    await screen.findByText(/로컬 파일 미리보기 · 저장 안 함/);
    expect(seen[0]?.filename).toBe('notes.txt');
    expect(seen[0]?.bytes.byteLength).toBeGreaterThan(0);
  });

  it('reports a gap explicitly and draws the pieces as separate features', async () => {
    const user = userEvent.setup();
    const { parser } = resolvingParser(gappedPreviewFile());
    const adapter = stubAdapter();
    render(<LocalTrackPreview {...session} parser={parser} createMapAdapter={adapter.factory} />);
    await user.upload(screen.getByTestId('track-preview-file'), file('run.gpx'));
    await screen.findByText(/기록이 1회 끊겼습니다/);
    expect(screen.getByText('시간 간격 1회')).toBeInTheDocument();
    await waitFor(() => expect(adapter.log.collections.length).toBeGreaterThan(0));
    expect(adapter.log.collections.at(-1)?.features).toHaveLength(2);
  });

  it('separates a recording without GPS from an error and keeps the summary usable', async () => {
    const user = userEvent.setup();
    const { parser } = resolvingParser(noGpsPreviewFile());
    render(<LocalTrackPreview {...session} parser={parser} />);
    await user.upload(screen.getByTestId('track-preview-file'), file('indoor.fit'));
    await screen.findByText(/위치가 기록되지 않은 파일입니다/);
    expect(screen.getByRole('heading', { name: '기본 요약' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '경로' })).not.toBeInTheDocument();
  });

  it('shows a parse failure as its own state with the parser code', async () => {
    const user = userEvent.setup();
    const parser: TrackPreviewParser = {
      parse: () => Promise.reject(new TrackPreviewError('TRACK_ARCHIVE_REJECTED')),
    };
    render(<LocalTrackPreview {...session} parser={parser} />);
    await user.upload(screen.getByTestId('track-preview-file'), file('bundle.zip'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('압축 파일은 받지 않습니다.');
    expect(alert).toHaveTextContent('TRACK_ARCHIVE_REJECTED');
  });

  it('cancels a running parse and reports cancellation, not failure', async () => {
    const user = userEvent.setup();
    let abort: AbortSignal | null = null;
    const parser: TrackPreviewParser = {
      parse: (_request, signal) =>
        new Promise((_resolve, reject) => {
          abort = signal;
          signal.addEventListener('abort', () =>
            reject(new TrackPreviewError('PREVIEW_CANCELLED')),
          );
        }),
    };
    render(<LocalTrackPreview {...session} parser={parser} />);
    await user.upload(screen.getByTestId('track-preview-file'), file('run.gpx'));
    await screen.findByText('파일을 해석하고 있습니다.');
    await user.click(screen.getByRole('button', { name: '파싱 취소' }));
    await screen.findByText(/사용자가 파싱을 취소했습니다/);
    expect(abort).not.toBeNull();
  });

  it('drops the result of a replaced file and shows only the newest one', async () => {
    const user = userEvent.setup();
    const first = { resolve: (_value: unknown) => undefined };
    const slow = normalPreviewFile();
    const parser: TrackPreviewParser = {
      parse: (request) =>
        request.filename === 'first.gpx'
          ? new Promise((resolve) => {
              first.resolve = resolve as (value: unknown) => undefined;
            })
          : Promise.resolve(gappedPreviewFile()),
    };
    render(<LocalTrackPreview {...session} parser={parser} />);
    const input = screen.getByTestId('track-preview-file');
    await user.upload(input, file('first.gpx'));
    await screen.findByText('파일을 해석하고 있습니다.');
    await user.upload(input, file('second.gpx'));
    await screen.findByText(/기록이 1회 끊겼습니다/);
    // The superseded parse answers late; its result must not replace the newer one.
    await act(async () => {
      first.resolve(slow);
      await Promise.resolve();
    });
    expect(screen.getByText(/기록이 1회 끊겼습니다/)).toBeInTheDocument();
    expect(screen.queryByText('400m')).not.toBeInTheDocument();
  });

  it('refuses an oversized file before a single byte is read', async () => {
    const user = userEvent.setup();
    const { parser, seen } = resolvingParser();
    render(<LocalTrackPreview {...session} parser={parser} />);
    const big = file('huge.fit');
    const read = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer');
    Object.defineProperty(big, 'size', { value: 33 * 1024 * 1024 });
    await user.upload(screen.getByTestId('track-preview-file'), big);
    await screen.findByText(/PREVIEW_FILE_TOO_LARGE/);
    expect(read).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
    read.mockRestore();
  });

  it('says so when the shell wired no parser instead of pretending to parse', async () => {
    const user = userEvent.setup();
    render(<LocalTrackPreview {...session} parser={null} />);
    await user.upload(screen.getByTestId('track-preview-file'), file('run.gpx'));
    await screen.findByText(/PREVIEW_PARSER_UNAVAILABLE/);
  });

  it('shows nothing until one of several recordings is explicitly chosen', async () => {
    const user = userEvent.setup();
    const { parser } = resolvingParser(multiTrackPreviewFile());
    const adapter = stubAdapter();
    render(<LocalTrackPreview {...session} parser={parser} createMapAdapter={adapter.factory} />);
    await user.upload(screen.getByTestId('track-preview-file'), file('two.fit'));

    await screen.findByRole('heading', { name: '기록 선택' });
    // Nothing is displayed for a file holding several recordings until one is picked:
    // no summary, no geometry and no renderer at all.
    expect(screen.getByText(/표시할 기록을 직접 선택하세요/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '기본 요약' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '경로' })).not.toBeInTheDocument();
    expect(adapter.log.created).toBe(0);
    expect(adapter.log.fits).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /세션 1/ }));
    await screen.findByRole('heading', { name: '기본 요약' });
    await waitFor(() => expect(adapter.log.fits).toHaveLength(1));
  });

  it('refits on a recording switch and a whole-view request, but never on a selection', async () => {
    const user = userEvent.setup();
    const { parser } = resolvingParser(multiTrackPreviewFile());
    const adapter = stubAdapter();
    render(<LocalTrackPreview {...session} parser={parser} createMapAdapter={adapter.factory} />);
    await user.upload(screen.getByTestId('track-preview-file'), file('two.fit'));
    await user.click(await screen.findByRole('button', { name: /세션 1/ }));
    await waitFor(() => expect(adapter.log.fits).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: /시작 지점/ }));
    await screen.findByText(/선택 표본/);
    expect(adapter.log.fits).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /세션 2/ }));
    await waitFor(() => expect(adapter.log.fits).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: '전체 보기' }));
    await waitFor(() => expect(adapter.log.fits).toHaveLength(3));
    // One renderer for the whole mount: data updates never rebuild it.
    expect(adapter.log.created).toBe(1);
  });

  it('keeps summary and a keyboard-reachable coordinate list when the renderer fails', async () => {
    const user = userEvent.setup();
    const { parser } = resolvingParser();
    const adapter = stubAdapter({ fail: true });
    render(<LocalTrackPreview {...session} parser={parser} createMapAdapter={adapter.factory} />);
    await user.upload(screen.getByTestId('track-preview-file'), file('run.gpx'));
    await screen.findByText(/지도를 표시하지 못했습니다/);
    expect(screen.getByRole('heading', { name: '기본 요약' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: '로컬 파일 경로 좌표 목록' });
    const buttons = within(list).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    await user.click(requireItem(buttons, 1));
    await screen.findByText(/선택 표본 0:1/);
  });

  it('selects the start and the end sample from the keyboard, without a drag', async () => {
    const user = userEvent.setup();
    const { parser } = resolvingParser();
    render(<LocalTrackPreview {...session} parser={parser} />);
    await user.upload(screen.getByTestId('track-preview-file'), file('run.gpx'));
    const start = await screen.findByRole('button', { name: '시작 지점' });
    start.focus();
    expect(start).toHaveFocus();
    await user.keyboard('{Enter}');
    await screen.findByText(/선택 표본 0:0/);
    // Tab moves to the next control and the space key activates it: no pointer needed.
    await user.tab();
    expect(screen.getByRole('button', { name: '끝 지점' })).toHaveFocus();
    await user.keyboard(' ');
    await screen.findByText(/선택 표본 0:3/);
    await user.click(screen.getByRole('button', { name: '선택 해제' }));
    await screen.findByText('선택한 지점이 없습니다.');
  });

  it('keeps the summary when the renderer chunk itself fails to load', async () => {
    const user = userEvent.setup();
    const { parser } = resolvingParser();
    render(<LocalTrackPreview {...session} parser={parser} mapView={FailingMapView} />);
    await user.upload(screen.getByTestId('track-preview-file'), file('run.gpx'));
    // A rejected lazy chunk never reaches the adapter's failure handling, so without a
    // boundary at the leaf it would propagate and take the summary with it.
    await screen.findByText(/지도를 표시하지 못했습니다/);
    expect(screen.getByRole('heading', { name: '기본 요약' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '시작 지점' })).toBeInTheDocument();
  });

  it('reaches every sample of a long track by keyboard, past the bounded kit list', async () => {
    const user = userEvent.setup();
    const { parser } = resolvingParser(longPreviewFile(260));
    render(<LocalTrackPreview {...session} parser={parser} />);
    await user.upload(screen.getByTestId('track-preview-file'), file('long.gpx'));
    await screen.findByRole('heading', { name: '기본 요약' });

    // The kit's own fallback list stops at 200 entries, so samples 201-259 are only
    // reachable through the module's paged navigator.
    const kitList = await screen.findByRole('list', { name: '로컬 파일 경로 좌표 목록' });
    expect(within(kitList).getAllByRole('button')).toHaveLength(200);
    const navigator = screen.getByRole('list', { name: '표본 목록' });
    expect(within(navigator).getAllByRole('button')).toHaveLength(50);

    const last = screen.getByRole('button', { name: '마지막 묶음' });
    last.focus();
    await user.keyboard('{Enter}');
    const lastPage = screen.getByRole('list', { name: '표본 목록' });
    const entries = within(lastPage).getAllByRole('button');
    const target = entries[entries.length - 1];
    expect(target).toBeDefined();
    if (!target) throw new Error('no sample control');
    target.focus();
    await user.keyboard(' ');
    await screen.findByText(/선택 표본 0:259/);
  });

  it('drops a renderer failure report once a later recording renders', async () => {
    const user = userEvent.setup();
    const files = [normalPreviewFile(), noGpsPreviewFile(), gappedPreviewFile()];
    let call = 0;
    const parser: TrackPreviewParser = {
      parse: () => Promise.resolve(requireItem(files, Math.min(call++, files.length - 1))),
    };
    // Fails the first time it is mounted, renders the second time: the failure report must
    // belong to the mount that failed, not to the screen for the rest of its life.
    rendererShouldFail = true;
    render(<LocalTrackPreview {...session} parser={parser} mapView={FlakyMapView} />);
    const input = screen.getByTestId('track-preview-file');

    await user.upload(input, file('first.gpx'));
    await screen.findByText(/지도를 표시하지 못했습니다/);
    rendererShouldFail = false;

    // A file without positions removes the map section entirely.
    await user.upload(input, file('indoor.fit'));
    await screen.findByText(/위치가 기록되지 않은 파일입니다/);

    // The next recording gets a working renderer, so the old failure must be gone.
    await user.upload(input, file('third.gpx'));
    await screen.findByText(/기록이 1회 끊겼습니다/);
    await screen.findByTestId('flaky-map-ready');
    expect(screen.queryByText(/지도를 표시하지 못했습니다/)).not.toBeInTheDocument();
  });

  it('writes no GPS or draft to browser storage', async () => {
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    try {
      const { parser } = resolvingParser();
      render(<LocalTrackPreview {...session} parser={parser} />);
      await user.upload(screen.getByTestId('track-preview-file'), file('run.gpx'));
      await screen.findByText(/로컬 파일 미리보기 · 저장 안 함/);
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  it('clears the preview when the account or session changes', async () => {
    const user = userEvent.setup();
    const { parser } = resolvingParser();
    const view = render(<LocalTrackPreview {...session} parser={parser} />);
    await user.upload(screen.getByTestId('track-preview-file'), file('run.gpx'));
    await screen.findByText(/로컬 파일 미리보기 · 저장 안 함/);
    view.rerender(
      <LocalTrackPreview athleteId="athlete-2" sessionId="session-2" parser={parser} />,
    );
    expect(screen.getByText('아직 파일을 선택하지 않았습니다.')).toBeInTheDocument();
    expect(screen.queryByText(/로컬 파일 미리보기 · 저장 안 함/)).not.toBeInTheDocument();
  });
});

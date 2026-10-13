import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { galleryMediaItemSchema } from '@workout/contracts/gallery';
import { MediaViewer } from '../src/media-viewer';
import { galleryVideoFailure, VideoViewer } from '../src/video-viewer';
import { useGalleryMediaSource } from '../src/use-gallery-media-source';
import type { GalleryMediaItem } from '@workout/contracts/gallery';
import type { GalleryMediaTransfer } from '../src/media-transfer';
import { galleryAdjacentIndex, gallerySwipeDirection } from '../src/viewer-navigation';
const id = '10000000-0000-4000-8000-000000000001';
const nextId = '10000000-0000-4000-8000-000000000002';
const item = galleryMediaItemSchema.parse({
  id,
  mediaKind: 'image',
  visibility: 'private',
  includeForCoach: false,
  album: null,
  caption: '사진 설명',
  activityId: null,
  capturedAt: null,
  capturedLocalDate: null,
  file: {
    originalFileName: 'image.png',
    mediaType: 'image/png',
    byteSize: 20,
    sha256: 'a'.repeat(64),
  },
  preview: null,
  accessRevision: 1,
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
});
const movie = galleryMediaItemSchema.parse({
  ...item,
  mediaKind: 'video',
  file: { ...item.file, mediaType: 'video/mp4', originalFileName: 'video.mp4' },
});
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL: vi.fn() }));
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});
it('offers clamped button and keyboard navigation, cancel and focus restoration', async () => {
  const user = userEvent.setup();
  const trigger = document.createElement('button');
  document.body.append(trigger);
  trigger.focus();
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <MediaViewer
      items={[item, { ...item, id: nextId }]}
      selectedId={id}
      onSelect={onSelect}
      onClose={onClose}
    />,
  );
  expect(screen.getByRole('button', { name: '보기 닫기' })).toHaveFocus();
  expect(screen.getByRole('button', { name: '이전 미디어' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '다음 미디어' }));
  expect(onSelect).toHaveBeenCalledWith(nextId);
  fireEvent.keyDown(screen.getByLabelText('미디어 이동 영역'), { key: 'ArrowRight' });
  expect(onSelect).toHaveBeenCalledTimes(2);
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }));
  expect(onClose).toHaveBeenCalledOnce();
  view.unmount();
  expect(trigger).toHaveFocus();
  trigger.remove();
});
it('revokes old revision and late cancelled URLs and hides removed media', async () => {
  let resolveFirst: ((url: string) => void) | undefined;
  const open = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockResolvedValue('blob:revision2');
  const transfer = { open, upload: vi.fn() };
  const props = { selectedId: id, transfer, onSelect: vi.fn(), onClose: vi.fn() };
  const view = render(<MediaViewer {...props} items={[item]} />);
  view.rerender(<MediaViewer {...props} items={[{ ...item, accessRevision: 2 }]} />);
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:revision2');
  await act(async () => {
    resolveFirst?.('blob:late-private');
  });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late-private');
  view.rerender(<MediaViewer {...props} items={[]} />);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:revision2');
});
it('retries a failed transfer through a fresh source invocation', async () => {
  const open = vi
    .fn()
    .mockRejectedValueOnce(new Error('private details'))
    .mockResolvedValue('blob:retry');
  render(
    <MediaViewer
      items={[item]}
      selectedId={id}
      transfer={{ open, upload: vi.fn() }}
      onSelect={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await userEvent.click(await screen.findByRole('button', { name: '미디어 다시 불러오기' }));
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:retry');
  expect(screen.queryByText('private details')).not.toBeInTheDocument();
});
it('uses actual playback rate and inline video, terminates codec loading and exposes recovery/fullscreen alternative', async () => {
  const retry = vi.fn();
  render(<VideoViewer item={movie} source="blob:video" onRetry={retry} />);
  const video = screen.getByLabelText('사진 설명');
  expect(video).toHaveAttribute('playsinline');
  await userEvent.selectOptions(screen.getByLabelText('재생 속도'), '1.5');
  expect(video).toHaveProperty('playbackRate', 1.5);
  fireEvent.error(video);
  expect(screen.queryByText('동영상 재생 정보를 불러오는 중입니다.')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '동영상 다시 불러오기' }));
  expect(retry).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole('button', { name: '동영상 전체 화면' }));
  expect(screen.getByText(/이 환경에서는 전체 화면/)).toBeInTheDocument();
  expect(screen.getByText(/자막을 확인할 수 없습니다/)).toBeInTheDocument();
});
it('rejects stale subtitle bindings rather than asserting none or displaying another media track', async () => {
  const read = vi.fn().mockResolvedValue({
    schemaVersion: 1,
    mediaItemId: nextId,
    accessRevision: 1,
    status: 'none',
  });
  render(
    <VideoViewer item={movie} source="blob:video" onRetry={vi.fn()} subtitlesReader={{ read }} />,
  );
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  expect(await screen.findByText(/자막을 확인할 수 없습니다/)).toBeInTheDocument();
  expect(screen.queryByText('연결된 자막이 없습니다.')).not.toBeInTheDocument();
});
it('preserves non-drag alternatives and ignores vertical/diagonal/nonfinite gestures', () => {
  expect(galleryAdjacentIndex(0, 2, -1)).toBe(0);
  expect(galleryAdjacentIndex(1, 2, 1)).toBe(1);
  expect(gallerySwipeDirection(-80, 1)).toBe(1);
  expect(gallerySwipeDirection(80, 1)).toBe(-1);
  expect(gallerySwipeDirection(10, 90)).toBeNull();
  expect(gallerySwipeDirection(80, 80)).toBeNull();
  expect(gallerySwipeDirection(NaN, 0)).toBeNull();
});

it('selects actual timed tracks and removes their private cues when switched off', async () => {
  class Cue {
    constructor(
      public startTime: number,
      public endTime: number,
      public text: string,
    ) {}
  }
  vi.stubGlobal('VTTCue', Cue);
  const addCue = vi.fn();
  const removeCue = vi.fn();
  const nativeTrack = { mode: 'disabled', addCue, removeCue };
  Object.defineProperty(HTMLMediaElement.prototype, 'addTextTrack', {
    configurable: true,
    value: () => nativeTrack,
  });
  const trackId = '10000000-0000-4000-8000-000000000003';
  const reader = {
    read: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      mediaItemId: id,
      accessRevision: 1,
      status: 'available',
      tracks: [
        {
          id: trackId,
          revision: 2,
          language: 'ko',
          label: '한국어',
          cues: [{ startMs: 0, endMs: 1000, text: '<script>문자</script>\n\n둘째' }],
        },
      ],
    }),
  };
  const view = render(
    <VideoViewer item={movie} source="blob:video" onRetry={vi.fn()} subtitlesReader={reader} />,
  );
  await userEvent.selectOptions(await screen.findByLabelText('자막 선택'), trackId);
  expect(addCue).toHaveBeenCalledWith(new Cue(0, 1, '&lt;script&gt;문자&lt;/script&gt;\n\n둘째'));
  expect(nativeTrack.mode).toBe('showing');
  expect(document.querySelector('script')).toBeNull();
  await userEvent.selectOptions(screen.getByLabelText('자막 선택'), 'off');
  expect(nativeTrack.mode).toBe('disabled');
  expect(removeCue).toHaveBeenCalledOnce();
  view.unmount();
  Reflect.deleteProperty(HTMLMediaElement.prototype, 'addTextTrack');
});
it('aborts subtitle reads when the media lifetime ends and only server-confirmed none is displayed', async () => {
  let signal: AbortSignal | undefined;
  const reader = {
    read: vi.fn().mockImplementation((input: { signal: AbortSignal }) => {
      signal = input.signal;
      return Promise.resolve({
        schemaVersion: 1,
        mediaItemId: id,
        accessRevision: 1,
        status: 'none',
      });
    }),
  };
  const view = render(
    <VideoViewer item={movie} source="blob:video" onRetry={vi.fn()} subtitlesReader={reader} />,
  );
  expect(await screen.findByText('연결된 자막이 없습니다.')).toBeInTheDocument();
  view.unmount();
  expect(signal?.aborted).toBe(true);
});

it('rejects a non-Blob URL and handles a synchronous transfer failure without exposing private errors', async () => {
  const props = { items: [item], selectedId: id, onSelect: vi.fn(), onClose: vi.fn() };
  const view = render(
    <MediaViewer
      {...props}
      transfer={{
        open: vi.fn().mockResolvedValue('https://private.invalid/image'),
        upload: vi.fn(),
      }}
    />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('미디어를 불러오지 못했습니다.');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  view.rerender(
    <MediaViewer
      {...props}
      transfer={{
        open() {
          throw new Error('private');
        },
        upload: vi.fn(),
      }}
    />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('미디어를 불러오지 못했습니다.');
  expect(screen.queryByText('private')).not.toBeInTheDocument();
});

it('bounds native tracks across repeated selections, track changes and reader/revision lifetimes while clearing every cue', async () => {
  class Cue {
    constructor(
      public startTime: number,
      public endTime: number,
      public text: string,
    ) {}
  }
  vi.stubGlobal('VTTCue', Cue);
  const tracks: { mode: string; cues: Cue[]; addCue(cue: Cue): void; removeCue(cue: Cue): void }[] =
    [];
  const addTextTrack = vi.fn(() => {
    const native = {
      mode: 'disabled',
      cues: Array<Cue>(),
      addCue(cue: Cue) {
        this.cues.push(cue);
      },
      removeCue(cue: Cue) {
        const index = this.cues.indexOf(cue);
        expect(index).toBeGreaterThanOrEqual(0);
        this.cues.splice(index, 1);
      },
    };
    tracks.push(native);
    return native;
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'addTextTrack', {
    configurable: true,
    value: addTextTrack,
  });
  const ko = '10000000-0000-4000-8000-000000000003';
  const en = '10000000-0000-4000-8000-000000000004';
  function reader(revision: number, text: string) {
    return {
      read: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        mediaItemId: id,
        accessRevision: revision,
        status: 'available',
        tracks: [
          {
            id: ko,
            revision,
            language: 'ko',
            label: '한국어',
            cues: [{ startMs: 0, endMs: 1000, text }],
          },
          {
            id: en,
            revision,
            language: 'en',
            label: 'English',
            cues: [{ startMs: 1000, endMs: 2000, text: 'English cue' }],
          },
        ],
      }),
    };
  }
  const first = reader(1, '원래 자막');
  const view = render(
    <VideoViewer item={movie} source="blob:video" onRetry={vi.fn()} subtitlesReader={first} />,
  );
  try {
    const select = await screen.findByLabelText('자막 선택');
    const nativeVideo = screen.getByLabelText('사진 설명');
    Object.defineProperty(nativeVideo, 'textTracks', { value: tracks });
    for (let cycle = 0; cycle < 4; cycle++) {
      await userEvent.selectOptions(select, ko);
      expect(nativeVideo).toHaveProperty('textTracks.length', 1);
      expect(tracks).toHaveLength(1);
      expect(tracks[0]?.cues).toHaveLength(1);
      await userEvent.selectOptions(select, 'off');
      expect(tracks[0]?.cues).toHaveLength(0);
      expect(tracks[0]?.mode).toBe('disabled');
    }
    await userEvent.selectOptions(select, ko);
    await userEvent.selectOptions(select, en);
    expect(tracks[0]?.cues.map((cue) => cue.text)).toEqual(['English cue']);
    view.rerender(<VideoViewer item={movie} source="blob:video" onRetry={vi.fn()} />);
    expect(tracks[0]?.cues).toHaveLength(0);
    expect(tracks[0]?.mode).toBe('disabled');
    const replacement = reader(1, '교체 reader 자막');
    view.rerender(
      <VideoViewer
        item={movie}
        source="blob:video"
        onRetry={vi.fn()}
        subtitlesReader={replacement}
      />,
    );
    await userEvent.selectOptions(await screen.findByLabelText('자막 선택'), ko);
    expect(tracks[0]?.cues.map((cue) => cue.text)).toEqual(['교체 reader 자막']);
    const revised = reader(2, '수정 revision 자막');
    view.rerender(
      <VideoViewer
        item={{ ...movie, accessRevision: 2 }}
        source="blob:video"
        onRetry={vi.fn()}
        subtitlesReader={revised}
      />,
    );
    await waitFor(() =>
      expect(tracks[0]?.cues.map((cue) => cue.text)).toEqual(['수정 revision 자막']),
    );
    expect(nativeVideo).toHaveProperty('textTracks.length', 1);
    expect(addTextTrack).toHaveBeenCalledOnce();
    expect(tracks).toHaveLength(1);
    view.unmount();
    expect(tracks[0]?.cues).toHaveLength(0);
    expect(tracks[0]?.mode).toBe('disabled');
  } finally {
    cleanup();
    Reflect.deleteProperty(HTMLMediaElement.prototype, 'addTextTrack');
  }
});

function SourceLifetime({
  media,
  transfer,
  enabled = true,
}: {
  media: GalleryMediaItem;
  transfer: GalleryMediaTransfer;
  enabled?: boolean;
}) {
  const { state } = useGalleryMediaSource(media, transfer, 'original', enabled);
  return state.kind === 'ready' ? (
    <img alt="수명 검증 미디어" src={state.url} />
  ) : (
    <p role="status">{state.kind}</p>
  );
}
it('never reuses revoked A when navigating A to delayed B to A, and revokes late B', async () => {
  let resolveB: ((url: string) => void) | undefined;
  let resolveFreshA: ((url: string) => void) | undefined;
  const open = vi
    .fn()
    .mockResolvedValueOnce('blob:old-A')
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveB = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFreshA = resolve;
        }),
    );
  const transfer = { open, upload: vi.fn() };
  const view = render(<SourceLifetime media={item} transfer={transfer} />);
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:old-A');
  view.rerender(<SourceLifetime media={{ ...item, id: nextId }} transfer={transfer} />);
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-A');
  view.rerender(<SourceLifetime media={item} transfer={transfer} />);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('loading');
  await waitFor(() => expect(open).toHaveBeenCalledTimes(3));
  await act(async () => {
    resolveB?.('blob:late-B');
  });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late-B');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  await act(async () => {
    resolveFreshA?.('blob:fresh-A');
  });
  expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:fresh-A');
});
it('keeps one open per item lifetime when the adapter object identity changes', async () => {
  const open = vi.fn().mockResolvedValueOnce('blob:stable').mockResolvedValue('blob:extra');
  const view = render(<SourceLifetime media={item} transfer={{ open, upload: vi.fn() }} />);
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:stable');
  for (let pass = 0; pass < 3; pass += 1)
    view.rerender(<SourceLifetime media={item} transfer={{ open, upload: vi.fn() }} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(open).toHaveBeenCalledOnce();
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:stable');
  expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:stable');
});
it('treats a re-enabled aborted invocation as loading until a fresh URL arrives', async () => {
  let resolveFresh: ((url: string) => void) | undefined;
  const open = vi
    .fn()
    .mockResolvedValueOnce('blob:before-disable')
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFresh = resolve;
        }),
    );
  const transfer = { open, upload: vi.fn() };
  const view = render(<SourceLifetime media={item} transfer={transfer} />);
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:before-disable');
  view.rerender(<SourceLifetime media={item} transfer={transfer} enabled={false} />);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:before-disable');
  view.rerender(<SourceLifetime media={item} transfer={transfer} />);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('loading');
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  await act(async () => {
    resolveFresh?.('blob:after-enable');
  });
  expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:after-enable');
});

it('maps finite MediaError codes and never shows native decoder text', () => {
  expect(galleryVideoFailure(4)).toBe('unsupported');
  expect(galleryVideoFailure(3)).toBe('decode');
  for (const code of [1, 2, null, 99]) expect(galleryVideoFailure(code)).toBe('unreadable');
  render(<VideoViewer item={movie} source="blob:video" onRetry={vi.fn()} />);
  const video = screen.getByLabelText('사진 설명');
  Object.defineProperty(video, 'error', {
    configurable: true,
    value: { code: 4, message: 'private native decoder detail' },
  });
  fireEvent.error(video);
  expect(screen.getByRole('alert')).toHaveTextContent('지원하지 않는 형식이거나 코덱입니다.');
  expect(screen.queryByText(/private native decoder detail/)).not.toBeInTheDocument();
});

it('mirrors a native control rate change only for supported speeds', () => {
  render(<VideoViewer item={movie} source="blob:video" onRetry={vi.fn()} />);
  const video = screen.getByLabelText<HTMLVideoElement>('사진 설명');
  const select = screen.getByLabelText<HTMLSelectElement>('재생 속도');
  video.playbackRate = 2;
  fireEvent(video, new Event('ratechange'));
  expect(select.value).toBe('2');
  video.playbackRate = 1.25;
  fireEvent(video, new Event('ratechange'));
  expect(select.value).toBe('2');
});

it('enters fullscreen on the control wrapper, keeps an inline return and exits on unmount', async () => {
  let active: Element | null = null;
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => active,
  });
  const exit = vi.fn(async () => {
    active = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
  const request = vi.fn(async (target: Element) => {
    active = target;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    value(this: Element) {
      return request(this);
    },
  });
  try {
    const view = render(<VideoViewer item={movie} source="blob:video" onRetry={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '동영상 전체 화면' }));
    expect(request).toHaveBeenCalledOnce();
    expect(active).toBe(screen.getByLabelText('사진 설명').parentElement);
    expect(screen.getByLabelText('재생 속도')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '화면 안에서 보기' }));
    expect(exit).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '동영상 전체 화면' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '동영상 전체 화면' }));
    view.unmount();
    expect(exit).toHaveBeenCalledTimes(2);
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
    Reflect.deleteProperty(document, 'exitFullscreen');
    Reflect.deleteProperty(document, 'fullscreenElement');
  }
});

it('distinguishes subtitle loading, unavailable reasons and retries a failed read once per click', async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error('private transport detail'))
    .mockResolvedValueOnce({
      schemaVersion: 1,
      mediaItemId: id,
      accessRevision: 1,
      status: 'available',
      tracks: [
        {
          id: '10000000-0000-4000-8000-000000000005',
          revision: 1,
          language: 'ko',
          label: '직접 첨부',
          cues: [{ startMs: 0, endMs: 500, text: '합성' }],
        },
      ],
    });
  render(
    <VideoViewer item={movie} source="blob:video" onRetry={vi.fn()} subtitlesReader={{ read }} />,
  );
  expect(screen.getByText('자막 연결 상태를 확인하는 중입니다.')).toBeInTheDocument();
  expect(await screen.findByText(/자막 응답을 확인하지 못했습니다/)).toBeInTheDocument();
  expect(screen.queryByText(/private transport detail/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '자막 다시 확인' }));
  expect(await screen.findByLabelText('자막 선택')).toBeInTheDocument();
  expect(screen.getByText(/자동 생성되거나 검토된 자막이 아닙니다/)).toBeInTheDocument();
  expect(read).toHaveBeenCalledTimes(2);
});

it('reports a server without subtitle storage without offering a pointless retry', async () => {
  const read = vi.fn().mockResolvedValue({
    schemaVersion: 1,
    mediaItemId: id,
    accessRevision: 1,
    status: 'unavailable',
    reason: 'reader_unavailable',
  });
  render(
    <VideoViewer item={movie} source="blob:video" onRetry={vi.fn()} subtitlesReader={{ read }} />,
  );
  expect(await screen.findByText(/자막 연결 서비스가 제공되지 않습니다/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '자막 다시 확인' })).not.toBeInTheDocument();
});

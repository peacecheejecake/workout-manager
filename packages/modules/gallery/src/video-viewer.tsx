import { useEffect, useRef, useState } from 'react';
import type { GalleryMediaItem } from '@workout/contracts/gallery';
import {
  galleryViewerSubtitlesSchema,
  type GalleryViewerSubtitles,
} from '@workout/contracts/gallery-viewer';
import styles from './gallery.module.css';

const SPEEDS = ['0.5', '1', '1.5', '2'];
export type GalleryVideoFailure = 'unsupported' | 'decode' | 'unreadable';
/** Finite MediaError mapping only; native messages are never shown. */
export function galleryVideoFailure(code: number | null): GalleryVideoFailure {
  // 4 MEDIA_ERR_SRC_NOT_SUPPORTED, 3 MEDIA_ERR_DECODE; network/abort/unknown are unreadable.
  return code === 4 ? 'unsupported' : code === 3 ? 'decode' : 'unreadable';
}

/** Backend ownership/attachment persistence is separate from this read port. */
export interface GallerySubtitlesReader {
  read(input: {
    mediaItemId: string;
    accessRevision: number;
    signal: AbortSignal;
  }): Promise<unknown>;
}

export function VideoViewer({
  item,
  source,
  subtitlesReader,
  onRetry,
}: {
  item: GalleryMediaItem;
  source: string;
  subtitlesReader?: GallerySubtitlesReader | undefined;
  onRetry(): void;
}) {
  const video = useRef<HTMLVideoElement | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  // Native TextTrack objects cannot be removed. Reuse one for this video lifetime.
  const subtitleTrack = useRef<TextTrack | null>(null);
  const [decoder, setDecoder] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [decodeFailure, setDecodeFailure] = useState<GalleryVideoFailure>('unreadable');
  const [speed, setSpeed] = useState('1');
  const [fullscreen, setFullscreen] = useState<'inline' | 'fullscreen' | 'unavailable'>('inline');
  const [readAttempt, setReadAttempt] = useState(0);
  const [selectedTrack, setSelectedTrack] = useState('off');
  const [captionFailureKey, setCaptionFailureKey] = useState<string | null>(null);
  const identity = JSON.stringify([item.id, item.accessRevision, readAttempt]);
  const [subtitleState, setSubtitleState] = useState<{
    identity: string;
    value: GalleryViewerSubtitles;
    reader: GallerySubtitlesReader;
  } | null>(null);
  const empty: GalleryViewerSubtitles = {
    schemaVersion: 1,
    mediaItemId: item.id,
    accessRevision: item.accessRevision,
    status: 'unavailable',
    reason: 'reader_unavailable',
  };
  const settled = subtitleState?.identity === identity && subtitleState.reader === subtitlesReader;
  const subtitles = settled ? subtitleState.value : empty;
  const subtitlesLoading = subtitlesReader !== undefined && !settled;

  useEffect(() => {
    if (!subtitlesReader) return;
    const controller = new AbortController();
    void Promise.resolve()
      .then(() =>
        subtitlesReader.read({
          mediaItemId: item.id,
          accessRevision: item.accessRevision,
          signal: controller.signal,
        }),
      )
      .then((raw) => {
        if (controller.signal.aborted) return;
        const parsed = galleryViewerSubtitlesSchema.safeParse(raw);
        const value: GalleryViewerSubtitles = !parsed.success
          ? {
              schemaVersion: 1,
              mediaItemId: item.id,
              accessRevision: item.accessRevision,
              status: 'unavailable',
              reason: 'load_failed',
            }
          : parsed.data.mediaItemId !== item.id ||
              parsed.data.accessRevision !== item.accessRevision
            ? {
                schemaVersion: 1,
                mediaItemId: item.id,
                accessRevision: item.accessRevision,
                status: 'unavailable',
                reason: 'stale_response',
              }
            : parsed.data;
        setSubtitleState({ identity, value, reader: subtitlesReader });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setSubtitleState({
            identity,
            reader: subtitlesReader,
            value: {
              schemaVersion: 1,
              mediaItemId: item.id,
              accessRevision: item.accessRevision,
              status: 'unavailable',
              reason: 'load_failed',
            },
          });
      });
    return () => controller.abort();
  }, [identity, item.id, item.accessRevision, subtitlesReader]);

  // Only this viewer's own fullscreen state is reflected; other elements are left untouched.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    // Refs are detached before passive cleanup; keep this lifetime's elements.
    const wrapper = container.current;
    const element = video.current;
    const owns = (active: Element | null | undefined) =>
      active !== null && active !== undefined && (active === wrapper || active === element);
    const update = () => {
      const owned = owns(document.fullscreenElement);
      setFullscreen((current) =>
        owned ? 'fullscreen' : current === 'unavailable' ? current : 'inline',
      );
    };
    document.addEventListener('fullscreenchange', update);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      if (owns(document.fullscreenElement) && typeof document.exitFullscreen === 'function')
        void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  const track =
    subtitles.status === 'available'
      ? subtitles.tracks.find((entry) => entry.id === selectedTrack)
      : undefined;
  const captionKey = track ? JSON.stringify([identity, track.id, track.revision]) : null;
  const captionFailed =
    track !== undefined && (typeof VTTCue !== 'function' || captionFailureKey === captionKey);
  useEffect(() => {
    const element = video.current;
    if (!track || !element) return;
    if (typeof element.addTextTrack !== 'function' || typeof VTTCue !== 'function') {
      return;
    }
    let active = true;
    let nativeTrack: TextTrack | null = null;
    const cues: VTTCue[] = [];
    try {
      nativeTrack = subtitleTrack.current ?? element.addTextTrack('subtitles', '선택한 자막');
      subtitleTrack.current = nativeTrack;
      // VTTCue receives text directly: newlines never become VTT record delimiters.
      for (const cue of track.cues) {
        const nativeCue = new VTTCue(
          cue.startMs / 1000,
          cue.endMs / 1000,
          cue.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        );
        nativeTrack.addCue(nativeCue);
        cues.push(nativeCue);
      }
      nativeTrack.mode = 'showing';
    } catch {
      if (nativeTrack) {
        nativeTrack.mode = 'disabled';
        for (const cue of cues) nativeTrack.removeCue(cue);
        cues.length = 0;
      }
      queueMicrotask(() => {
        if (active) setCaptionFailureKey(captionKey);
      });
    }
    return () => {
      active = false;
      if (!nativeTrack) return;
      nativeTrack.mode = 'disabled';
      for (const cue of cues) nativeTrack.removeCue(cue);
    };
  }, [track, captionKey]);

  useEffect(() => {
    const element = video.current;
    return () => {
      if (!element) return;
      element.pause();
      element.removeAttribute('src');
      element.load();
    };
  }, []);

  /**
   * The wrapper (not the bare video) enters fullscreen so caption/speed controls and the
   * inline return button stay reachable. iOS-style video-only fullscreen is the fallback.
   */
  async function enterFullscreen() {
    const wrapper = container.current;
    const element = video.current;
    if (!wrapper || !element) return;
    try {
      if (typeof wrapper.requestFullscreen === 'function') {
        await wrapper.requestFullscreen();
        setFullscreen(document.fullscreenElement === wrapper ? 'fullscreen' : 'inline');
        return;
      }
      const native: unknown = Reflect.get(element, 'webkitEnterFullscreen');
      if (typeof native !== 'function') {
        setFullscreen('unavailable');
        return;
      }
      native.call(element);
      setFullscreen('inline');
    } catch {
      setFullscreen('unavailable');
    }
  }
  async function exitFullscreen() {
    try {
      if (document.fullscreenElement && typeof document.exitFullscreen === 'function')
        await document.exitFullscreen();
    } catch {
      // The browser keeps its own state; the change listener reports the actual mode.
    }
    setFullscreen(document.fullscreenElement ? 'fullscreen' : 'inline');
  }
  const unavailableMessage =
    subtitles.status === 'unavailable'
      ? subtitles.reason === 'reader_unavailable'
        ? '자막을 확인할 수 없습니다. 이 환경에서는 자막 연결 서비스가 제공되지 않습니다.'
        : subtitles.reason === 'stale_response'
          ? '자막을 확인할 수 없습니다. 미디어가 바뀌어 받은 자막을 사용하지 않았습니다.'
          : '자막을 확인할 수 없습니다. 자막 응답을 확인하지 못했습니다.'
      : null;
  return (
    <div className={styles.videoViewer} ref={container}>
      {/* Missing/unavailable captions are explicit; no fabricated empty track. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={video}
        src={source}
        controls
        playsInline
        preload="metadata"
        aria-label={item.caption ?? item.file.originalFileName}
        onLoadedData={() => setDecoder('ready')}
        onCanPlay={() => setDecoder('ready')}
        onError={(event) => {
          setDecodeFailure(galleryVideoFailure(event.currentTarget.error?.code ?? null));
          setDecoder('failed');
        }}
        onRateChange={(event) => {
          // Native controls may change speed too; the select mirrors only supported values.
          const next = String(event.currentTarget.playbackRate);
          if (SPEEDS.includes(next)) setSpeed(next);
        }}
      ></video>
      {decoder === 'loading' ? <p role="status">동영상 재생 정보를 불러오는 중입니다.</p> : null}
      {decoder === 'failed' ? (
        <div role="alert">
          <p>
            이 동영상을 재생할 수 없습니다.{' '}
            {decodeFailure === 'unsupported'
              ? '이 환경에서 지원하지 않는 형식이거나 코덱입니다.'
              : decodeFailure === 'decode'
                ? '동영상을 해독하는 중 오류가 발생했습니다.'
                : '지원하지 않는 형식이거나 파일을 읽을 수 없습니다.'}
          </p>
          <button type="button" onClick={onRetry}>
            동영상 다시 불러오기
          </button>
          <p>다른 미디어를 선택하거나 갤러리에서 원본을 확인하세요.</p>
        </div>
      ) : null}
      <label>
        재생 속도{' '}
        <select
          value={speed}
          onChange={(event) => {
            const next = event.target.value;
            if (!SPEEDS.includes(next)) return;
            setSpeed(next);
            if (video.current) video.current.playbackRate = Number(next);
          }}
        >
          {SPEEDS.map((value) => (
            <option key={value} value={value}>
              {value}배
            </option>
          ))}
        </select>
      </label>
      {fullscreen === 'fullscreen' ? (
        <button type="button" onClick={() => void exitFullscreen()}>
          화면 안에서 보기
        </button>
      ) : (
        <button type="button" onClick={() => void enterFullscreen()}>
          동영상 전체 화면
        </button>
      )}
      {fullscreen === 'unavailable' ? (
        <p role="status">
          이 환경에서는 전체 화면을 사용할 수 없습니다. 화면 안에서 재생할 수 있습니다.
        </p>
      ) : null}
      {captionFailed ? <p role="status">이 환경에서는 선택한 자막을 표시할 수 없습니다.</p> : null}
      {subtitles.status === 'available' ? (
        <>
          <label>
            자막 선택{' '}
            <select
              value={track ? selectedTrack : 'off'}
              onChange={(event) => setSelectedTrack(event.target.value)}
            >
              <option value="off">자막 끄기</option>
              {subtitles.tracks.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label} ({entry.language})
                </option>
              ))}
            </select>
          </label>
          <p className={styles.hint}>
            직접 첨부한 자막 파일입니다. 자동 생성되거나 검토된 자막이 아닙니다.
          </p>
        </>
      ) : subtitles.status === 'none' ? (
        <p role="status">연결된 자막이 없습니다.</p>
      ) : subtitles.status === 'missing' ? (
        <p role="status">자막의 원본 미디어에 접근할 수 없습니다.</p>
      ) : subtitlesLoading ? (
        <p role="status">자막 연결 상태를 확인하는 중입니다.</p>
      ) : (
        <div role="status">
          <p>{unavailableMessage}</p>
          {subtitlesReader && subtitles.reason !== 'reader_unavailable' ? (
            <button type="button" onClick={() => setReadAttempt((value) => value + 1)}>
              자막 다시 확인
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

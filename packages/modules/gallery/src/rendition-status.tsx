import { useEffect, useId, useState } from 'react';
import type { GalleryMediaItem } from '@workout/contracts/gallery';
import {
  galleryRenditionListV1Schema,
  type GalleryRenditionListV1,
  type GalleryRenditionV1,
} from '@workout/contracts/gallery-rendition';
import styles from './gallery.module.css';

/** Host-injected reader; the reply is re-validated here and never trusted as authority. */
export interface GalleryRenditionsReader {
  list(input: { mediaItemId: string; signal: AbortSignal }): Promise<unknown>;
}

type StatusState =
  | { kind: 'loading'; key: string }
  | { kind: 'failed'; key: string }
  | { kind: 'loaded'; key: string; list: GalleryRenditionListV1 };

const KIND_LABEL: Record<GalleryRenditionV1['kind'], string> = {
  image_preview: '미리보기 이미지',
  image_thumbnail: '썸네일',
  video_playback: '재생용 영상',
};
const FAILURE_LABEL: Record<Extract<GalleryRenditionV1, { state: 'failed' }>['code'], string> = {
  input_invalid: '원본을 확인할 수 없음',
  input_budget: '원본이 처리 한도를 넘음',
  pixel_budget: '해상도가 처리 한도를 넘음',
  invalid_media: '손상된 미디어',
  decode_failed: '해독 실패',
  output_budget: '변환 결과가 한도를 넘음',
  aborted: '처리가 중단됨',
  timeout: '처리 시간 초과',
  codec_unavailable: '변환 도구를 사용할 수 없음',
};
const UNAVAILABLE_LABEL: Record<
  Extract<GalleryRenditionV1, { state: 'unavailable' }>['reason'],
  string
> = {
  not_available: '아직 변환 정보가 없습니다',
  stale_lineage: '원본 정보가 바뀌어 다시 확인이 필요합니다',
  consent_withdrawn: '동의가 없어 처리하지 않습니다',
  media_deleted: '삭제된 미디어입니다',
  target_closed: '지금은 처리할 수 없습니다',
};

function describe(rendition: GalleryRenditionV1): string {
  switch (rendition.state) {
    case 'queued':
      return '변환 대기 중';
    case 'running':
      return '변환 중';
    case 'ready':
      return `준비됨 (${rendition.output.widthPixels}×${rendition.output.heightPixels})`;
    case 'failed':
      return `변환 실패: ${FAILURE_LABEL[rendition.code]}${
        rendition.retryEligibility === 'ineligible' ? ' · 자동으로 다시 시도하지 않습니다' : ''
      }`;
    case 'unsupported':
      return rendition.code === 'unsupported_pages'
        ? '여러 프레임 이미지는 변환하지 않습니다'
        : '지원하지 않는 형식이라 변환하지 않습니다';
    case 'unavailable':
      return UNAVAILABLE_LABEL[rendition.reason];
  }
}

/**
 * S17 derived-rendition state (M2-03c). Read on open and on explicit refresh only: no polling
 * and no live-region churn. The original is always shown from its own immutable bytes.
 */
export function GalleryRenditionStatus({
  item,
  reader,
}: {
  item: GalleryMediaItem;
  reader: GalleryRenditionsReader;
}) {
  const headingId = useId();
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([item.id, item.accessRevision, attempt]);
  const [state, setState] = useState<StatusState>({ kind: 'loading', key });
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => reader.list({ mediaItemId: item.id, signal: controller.signal }))
      .then((value) => {
        const parsed = galleryRenditionListV1Schema.safeParse(value);
        if (controller.signal.aborted) return;
        setState(
          parsed.success && parsed.data.mediaItemId === item.id
            ? { kind: 'loaded', key, list: parsed.data }
            : { kind: 'failed', key },
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: 'failed', key });
      });
    return () => controller.abort();
  }, [reader, item.id, key]);
  const current: StatusState = state.key === key ? state : { kind: 'loading', key };
  return (
    <section className={styles.renditions} aria-labelledby={headingId}>
      <h4 id={headingId}>변환본 상태</h4>
      {current.kind === 'loading' ? (
        <p>변환 상태 확인 중</p>
      ) : current.kind === 'failed' ? (
        <p>변환 상태를 확인하지 못했습니다.</p>
      ) : (
        <ul>
          {current.list.renditions.map((rendition) => (
            <li key={rendition.kind}>
              <span>{KIND_LABEL[rendition.kind]}</span>: {describe(rendition)}
            </li>
          ))}
        </ul>
      )}
      <p className={styles.hint}>
        원본은 올린 그대로(위치 등 촬영 정보 포함) 내 계정에만 비공개로 보관됩니다.
        미리보기·썸네일·재생용 변환본에는 위치를 포함한 어떤 촬영 메타데이터도 넣지 않습니다.
      </p>
      <button
        type="button"
        disabled={current.kind === 'loading'}
        onClick={() => setAttempt((value) => value + 1)}
      >
        변환 상태 새로고침
      </button>
    </section>
  );
}

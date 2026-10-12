import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { galleryMediaItemSchema } from '@workout/contracts/gallery';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { GalleryRenditionStatus } from '../src/rendition-status';
import { MediaViewer } from '../src/media-viewer';
import {
  createGalleryRenditionsApi,
  GalleryRenditionsRequestError,
} from '../src/gallery-renditions-api';

const id = '10000000-0000-4000-8000-000000000001';
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
    originalFileName: 'image.jpg',
    mediaType: 'image/jpeg',
    byteSize: 20,
    sha256: 'a'.repeat(64),
  },
  preview: null,
  accessRevision: 1,
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
});
const lineage = {
  schemaVersion: 1,
  mediaItemId: id,
  originalSha256: 'a'.repeat(64),
  parentAccessRevision: 1,
  recipeVersion: 1,
};
const list = (preview: object, thumbnail: object) => ({
  schemaVersion: 1,
  mediaItemId: id,
  renditions: [
    { ...lineage, kind: 'image_preview', ...preview },
    { ...lineage, kind: 'image_thumbnail', ...thumbnail },
  ],
});
beforeEach(() => {
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
});

describe('GalleryRenditionStatus', () => {
  it('names every state explicitly, including terminal no-retry failures', async () => {
    const reader = {
      list: vi.fn().mockResolvedValue(
        list(
          {
            state: 'ready',
            output: {
              mediaType: 'image/webp',
              sha256: 'b'.repeat(64),
              byteSize: 10,
              widthPixels: 400,
              heightPixels: 800,
            },
          },
          { state: 'failed', code: 'decode_failed', retryEligibility: 'ineligible' },
        ),
      ),
    };
    render(<GalleryRenditionStatus item={item} reader={reader} />);
    expect(screen.getByText('변환 상태 확인 중')).toBeInTheDocument();
    const section = await screen.findByRole('region', { name: '변환본 상태' });
    expect(section).toHaveTextContent('미리보기 이미지: 준비됨 (400×800)');
    expect(section).toHaveTextContent(
      '썸네일: 변환 실패: 해독 실패 · 자동으로 다시 시도하지 않습니다',
    );
    expect(reader.list).toHaveBeenCalledWith(expect.objectContaining({ mediaItemId: id }));
    // User decision 2026-10-10: originals keep GPS privately; derivatives carry no metadata.
    expect(section).toHaveTextContent(
      '원본은 올린 그대로(위치 등 촬영 정보 포함) 내 계정에만 비공개로 보관됩니다.',
    );
    expect(section).toHaveTextContent(
      '미리보기·썸네일·재생용 변환본에는 위치를 포함한 어떤 촬영 메타데이터도 넣지 않습니다.',
    );
  });

  it.each([
    [{ state: 'queued' }, { state: 'running' }, ['변환 대기 중', '변환 중']],
    [
      { state: 'unsupported', code: 'unsupported_format' },
      { state: 'unsupported', code: 'unsupported_pages' },
      ['지원하지 않는 형식이라 변환하지 않습니다', '여러 프레임 이미지는 변환하지 않습니다'],
    ],
    [
      { state: 'unavailable', reason: 'media_deleted' },
      { state: 'unavailable', reason: 'not_available' },
      ['삭제된 미디어입니다', '아직 변환 정보가 없습니다'],
    ],
  ])('renders %o / %o without inventing output', async (preview, thumbnail, texts) => {
    render(
      <GalleryRenditionStatus
        item={item}
        reader={{ list: vi.fn().mockResolvedValue(list(preview, thumbnail)) }}
      />,
    );
    const section = await screen.findByRole('region', { name: '변환본 상태' });
    await waitFor(() => expect(section).toHaveTextContent(texts[0] ?? ''));
    expect(section).toHaveTextContent(texts[1] ?? '');
    expect(section).not.toHaveTextContent('준비됨');
  });

  it('treats invalid or foreign replies as unknown and refreshes only on request', async () => {
    const reader = {
      list: vi
        .fn()
        .mockResolvedValueOnce({
          ...list({ state: 'queued' }, { state: 'queued' }),
          mediaItemId: '10000000-0000-4000-8000-000000000009',
        })
        .mockRejectedValueOnce(new Error('private server text'))
        .mockResolvedValueOnce(list({ state: 'queued' }, { state: 'running' })),
    };
    const user = userEvent.setup();
    render(<GalleryRenditionStatus item={item} reader={reader} />);
    expect(await screen.findByText('변환 상태를 확인하지 못했습니다.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '변환 상태 새로고침' }));
    expect(await screen.findByText('변환 상태를 확인하지 못했습니다.')).toBeInTheDocument();
    expect(screen.queryByText(/private server text/)).toBeNull();
    await user.click(screen.getByRole('button', { name: '변환 상태 새로고침' }));
    expect(await screen.findByText(/변환 중/)).toBeInTheDocument();
    expect(reader.list).toHaveBeenCalledTimes(3);
  });

  it('aborts the pending read when the viewer moves on', async () => {
    let signal: AbortSignal | undefined;
    const reader = {
      list: vi.fn((input: { signal: AbortSignal }) => {
        signal = input.signal;
        return new Promise(() => undefined);
      }),
    };
    const view = render(<GalleryRenditionStatus item={item} reader={reader} />);
    await waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('is shown inside the media viewer only when a reader is injected', async () => {
    const reader = {
      list: vi.fn().mockResolvedValue(list({ state: 'queued' }, { state: 'queued' })),
    };
    const props = { items: [item], selectedId: id, onSelect: vi.fn(), onClose: vi.fn() };
    const view = render(<MediaViewer {...props} />);
    expect(screen.queryByRole('region', { name: '변환본 상태' })).toBeNull();
    view.unmount();
    render(<MediaViewer {...props} renditionsReader={reader} />);
    expect(await screen.findByRole('region', { name: '변환본 상태' })).toHaveTextContent(
      '변환 대기 중',
    );
  });
});

describe('createGalleryRenditionsApi', () => {
  function transport(reply: unknown): AuthenticatedTransport {
    return { request: vi.fn().mockResolvedValue(reply) } as unknown as AuthenticatedTransport;
  }
  it('reads the owned rendition list through the authenticated transport', async () => {
    const body = list({ state: 'queued' }, { state: 'running' });
    const port = transport({ status: 200, body, traceId: null });
    const signal = new AbortController().signal;
    await expect(
      createGalleryRenditionsApi(port).list({ mediaItemId: id, signal }),
    ).resolves.toEqual(body);
    expect(port.request).toHaveBeenCalledWith({
      path: `/bff/v1/gallery/media/${id}/renditions`,
      method: 'GET',
      body: null,
      idempotencyKey: null,
      signal,
    });
  });
  it('maps statuses, malformed and foreign replies to finite errors', async () => {
    const signal = new AbortController().signal;
    for (const [reply, code] of [
      [
        { status: 404, body: { error: { code: 'MEDIA_NOT_FOUND' } }, traceId: null },
        'REQUEST_FAILED',
      ],
      [{ status: 200, body: { nope: true }, traceId: null }, 'INVALID_REPLY'],
      [
        {
          status: 200,
          body: {
            ...list({ state: 'queued' }, { state: 'queued' }),
            mediaItemId: '10000000-0000-4000-8000-000000000009',
          },
          traceId: null,
        },
        'INVALID_REPLY',
      ],
      ['not a reply', 'INVALID_REPLY'],
    ] as const) {
      const error = await createGalleryRenditionsApi(transport(reply))
        .list({ mediaItemId: id, signal })
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(GalleryRenditionsRequestError);
      expect((error as GalleryRenditionsRequestError).code).toBe(code);
    }
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      createGalleryRenditionsApi(transport({})).list({ mediaItemId: id, signal: aborted.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { GalleryWorkspace, type GalleryMediaTransfer } from '../src/gallery-workspace';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const mediaItemId = '10000000-0000-4000-8000-000000000001';
const uploadId = '10000000-0000-4000-8000-000000000002';
const createdAt = '2026-09-19T00:00:00.000Z';
const item = {
  id: mediaItemId,
  mediaKind: 'image' as const,
  visibility: 'private' as const,
  includeForCoach: false as const,
  album: '대회',
  caption: '결승선',
  activityId: null,
  capturedAt: null,
  capturedLocalDate: null,
  file: {
    originalFileName: 'finish.png',
    mediaType: 'image/png' as const,
    byteSize: 2048,
    sha256: 'a'.repeat(64),
  },
  preview: null,
  accessRevision: 1,
  createdAt,
  updatedAt: createdAt,
};

function transportFor(
  handler: (input: { path: string; method: string; body: unknown }) => {
    status: number;
    body: unknown;
  },
): AuthenticatedTransport {
  return {
    request: async (input) =>
      transportReplySchema.parse({ ...handler(input), traceId: null }) as never,
  };
}

function listOnly(status = 200, body: unknown = { items: [item], total: 1 }) {
  return transportFor((input) => {
    if (input.method === 'GET' && input.path.startsWith('/bff/v1/gallery/media?'))
      return { status, body };
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
}

function renderWorkspace(transport: AuthenticatedTransport, mediaTransfer?: GalleryMediaTransfer) {
  return render(
    <GalleryWorkspace
      athleteId="athlete"
      sessionId="session"
      transport={transport}
      {...(mediaTransfer ? { mediaTransfer } : {})}
    />,
  );
}

it('shows the loading state and then the stored media without exposing a storage reference', async () => {
  renderWorkspace(listOnly());
  expect(screen.getByText('갤러리를 불러오는 중입니다.')).toBeInTheDocument();
  expect(await screen.findByRole('link', { name: '결승선' })).toBeInTheDocument();
  expect(document.body.textContent).not.toContain('private/v1/tenants');
});

it('shows an explicit empty state', async () => {
  renderWorkspace(listOnly(200, { items: [], total: 0 }));
  expect(await screen.findByText('아직 저장한 사진이나 동영상이 없습니다.')).toBeInTheDocument();
});

it('recovers a repeated window from a head insertion without duplicating or skipping', async () => {
  const user = userEvent.setup();
  const second = { ...item, id: '10000000-0000-4000-8000-000000000004', caption: '출발선' };
  const third = { ...item, id: '10000000-0000-4000-8000-000000000005', caption: '중간' };
  const offsets: string[] = [];
  const transport = transportFor((input) => {
    const offset = new URL(input.path, 'http://localhost').searchParams.get('offset') ?? '0';
    offsets.push(offset);
    // A concurrent insert at the head shifts the window, so offset 1 repeats
    // the identity already loaded. Advancing by distinct identities re-reads
    // instead of stepping past the one that was never shown.
    if (offset === '0') return { status: 200, body: { items: [item], total: 3 } };
    if (offset === '1') return { status: 200, body: { items: [item, second], total: 3 } };
    return { status: 200, body: { items: [third], total: 3 } };
  });
  renderWorkspace(transport);
  await screen.findByRole('link', { name: '결승선' });
  await user.click(screen.getByRole('button', { name: '더 보기' }));
  expect(await screen.findByRole('link', { name: '출발선' })).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: '결승선' })).toHaveLength(1);
  // The raw page length would have jumped to 3 and ended the listing here.
  await user.click(screen.getByRole('button', { name: '더 보기' }));
  expect(await screen.findByRole('link', { name: '중간' })).toBeInTheDocument();
  expect(offsets).toEqual(['0', '1', '2']);
  expect(screen.queryByRole('button', { name: '더 보기' })).not.toBeInTheDocument();
});

it('reports a partial listing and loads the next page on request', async () => {
  const user = userEvent.setup();
  const second = { ...item, id: '10000000-0000-4000-8000-000000000003', caption: '출발선' };
  const offsets: string[] = [];
  const transport = transportFor((input) => {
    const offset = new URL(input.path, 'http://localhost').searchParams.get('offset') ?? '0';
    offsets.push(offset);
    return {
      status: 200,
      body: { items: offset === '0' ? [item] : [second], total: 2 },
    };
  });
  renderWorkspace(transport);
  expect(await screen.findByText('전체 2개 중 1개를 표시했습니다.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '더 보기' }));
  expect(await screen.findByRole('link', { name: '출발선' })).toBeInTheDocument();
  expect(offsets).toEqual(['0', '1']);
  expect(screen.queryByRole('button', { name: '더 보기' })).not.toBeInTheDocument();
});

it('surfaces a failed listing with a retry affordance', async () => {
  renderWorkspace(listOnly(500, { error: { code: 'INTERNAL' } }));
  expect(await screen.findByRole('alert')).toHaveTextContent('갤러리를 불러오지 못했습니다.');
  expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
});

it('keeps the upload button reachable by keyboard and reports a missing file', async () => {
  const user = userEvent.setup();
  renderWorkspace(listOnly(), { upload: vi.fn(), open: vi.fn(async () => 'blob:preview') });
  await screen.findByRole('link', { name: '결승선' });
  const submit = screen.getByRole('button', { name: '올리기' });
  submit.focus();
  expect(submit).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '업로드할 사진 또는 동영상을 선택하세요.',
  );
});

function deferred<T = true>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

const reservationBody = {
  uploadId,
  mediaItemId,
  operation: 'create_item' as const,
  state: 'reserved' as const,
  createdAt,
  updatedAt: createdAt,
};

function pngFile() {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'finish.png', {
    type: 'image/png',
  });
}

it('reports the preparing, uploading and finalizing stages in order', async () => {
  const user = userEvent.setup();
  const calls: string[] = [];
  const reserveGate = deferred();
  const finalizeGate = deferred();
  const transport: AuthenticatedTransport = {
    request: async (input) => {
      calls.push(`${input.method} ${input.path}`);
      if (input.method === 'GET')
        return transportReplySchema.parse({
          status: 200,
          body: { items: [], total: 0 },
          traceId: null,
        }) as never;
      if (input.path === '/bff/v1/gallery/media/uploads') {
        await reserveGate.promise;
        return transportReplySchema.parse({
          status: 200,
          body: reservationBody,
          traceId: null,
        }) as never;
      }
      if (input.path === `/bff/v1/gallery/media/uploads/${uploadId}/finalize`) {
        await finalizeGate.promise;
        return transportReplySchema.parse({
          status: 200,
          body: { status: 'available', item },
          traceId: null,
        }) as never;
      }
      throw new Error(`unexpected request ${input.method} ${input.path}`);
    },
  };
  const uploadGate = deferred();
  const upload = vi.fn<GalleryMediaTransfer['upload']>(async (request) => {
    request.onProgress(1, 2);
    await uploadGate.promise;
  });
  renderWorkspace(transport, { upload, open: vi.fn(async () => 'blob:preview') });
  await screen.findByText('아직 저장한 사진이나 동영상이 없습니다.');
  await user.upload(screen.getByLabelText('파일'), pngFile());
  await user.click(screen.getByRole('button', { name: '올리기' }));

  expect(await screen.findByText('업로드 준비 중')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '올리기' })).toBeDisabled();
  reserveGate.resolve(true);

  expect(await screen.findByText('업로드 중')).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: '업로드 진행률' })).toBeInTheDocument();
  uploadGate.resolve(true);

  expect(await screen.findByText('저장 확정 중')).toBeInTheDocument();
  finalizeGate.resolve(true);

  await waitFor(() => expect(screen.queryByRole('button', { name: '올리기' })).not.toBeDisabled());
  expect(upload.mock.calls[0]?.[0]).toMatchObject({ uploadId, mediaType: 'image/png' });
  expect(calls).toContain(`POST /bff/v1/gallery/media/uploads/${uploadId}/finalize`);
});

it('keeps the album and caption draft and returns focus after a failed upload', async () => {
  const user = userEvent.setup();
  const transport = transportFor((input) => {
    if (input.method === 'GET') return { status: 200, body: { items: [], total: 0 } };
    if (input.path === '/bff/v1/gallery/media/uploads')
      return { status: 503, body: { error: { code: 'UPLOAD_RESUME_REQUIRED' } } };
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  renderWorkspace(transport, {
    upload: vi.fn(),
    open: vi.fn(async () => 'blob:preview'),
  });
  await screen.findByText('아직 저장한 사진이나 동영상이 없습니다.');
  await user.type(screen.getByLabelText('앨범 (선택)'), '대회');
  await user.type(screen.getByLabelText('설명 (선택)'), '결승선 초안');
  await user.upload(screen.getByLabelText('파일'), pngFile());
  await user.click(screen.getByRole('button', { name: '올리기' }));

  expect(
    await screen.findByText('업로드가 중단됐습니다. 같은 파일로 다시 시도하세요.'),
  ).toBeInTheDocument();
  expect(screen.getByLabelText('앨범 (선택)')).toHaveValue('대회');
  expect(screen.getByLabelText('설명 (선택)')).toHaveValue('결승선 초안');
  const submit = screen.getByRole('button', { name: '올리기' });
  expect(submit).not.toBeDisabled();
  // The implementation returns focus from an effect that runs after the idle
  // stage is committed; the test never focuses it. jsdom cannot prove that a
  // disabled control would have refused focus, so the real browser evidence is
  // the gallery Playwright spec.
  expect(submit).toHaveFocus();
});

it('stops rendering cached detail media when a refetch reports it is gone', async () => {
  const revoked: string[] = [];
  let available = true;
  const transport = transportFor((input) => {
    if (input.method === 'GET' && input.path.startsWith('/bff/v1/gallery/media?'))
      return { status: 200, body: { items: available ? [item] : [], total: available ? 1 : 0 } };
    if (input.method === 'GET' && input.path === `/bff/v1/gallery/media/${mediaItemId}`)
      return available
        ? { status: 200, body: { status: 'available', item } }
        : { status: 404, body: { error: { code: 'MEDIA_NOT_FOUND' } } };
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  const revoke = vi
    .spyOn(URL, 'revokeObjectURL')
    .mockImplementation((value) => revoked.push(value));
  try {
    render(
      <GalleryWorkspace
        athleteId="athlete"
        sessionId="session"
        transport={transport}
        mediaItemId={mediaItemId}
        mediaTransfer={{ upload: vi.fn(), open: vi.fn(async () => 'blob:detail') }}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByRole('img', { name: '결승선' }).length).toBeGreaterThan(0),
    );

    // The item is removed on another device; this tab only learns about it
    // through a refetch that now fails.
    available = false;
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '미디어를 찾을 수 없거나 열람 권한이 없습니다.',
    );
    await waitFor(() => expect(screen.queryByRole('img', { name: '결승선' })).toBeNull());
    expect(revoked).toContain('blob:detail');
  } finally {
    revoke.mockRestore();
  }
});

it('hides the card as soon as the detail 404s, before the list refetch resolves', async () => {
  const revoked: string[] = [];
  let available = true;
  const listGate = deferred();
  const transport: AuthenticatedTransport = {
    request: async (input) => {
      if (input.method === 'GET' && input.path.startsWith('/bff/v1/gallery/media?')) {
        // The refetch stays in flight, so the list keeps its previous success
        // state while the detail resolves.
        if (!available) await listGate.promise;
        return transportReplySchema.parse({
          status: 200,
          body: { items: [item], total: 1 },
          traceId: null,
        }) as never;
      }
      if (input.method === 'GET' && input.path === `/bff/v1/gallery/media/${mediaItemId}`)
        return transportReplySchema.parse(
          available
            ? { status: 200, body: { status: 'available', item }, traceId: null }
            : { status: 404, body: { error: { code: 'MEDIA_NOT_FOUND' } }, traceId: null },
        ) as never;
      throw new Error(`unexpected request ${input.method} ${input.path}`);
    },
  };
  const revoke = vi
    .spyOn(URL, 'revokeObjectURL')
    .mockImplementation((value) => revoked.push(value));
  try {
    render(
      <GalleryWorkspace
        athleteId="athlete"
        sessionId="session"
        transport={transport}
        mediaItemId={mediaItemId}
        mediaTransfer={{ upload: vi.fn(), open: vi.fn(async () => 'blob:inflight') }}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByRole('img', { name: '결승선' }).length).toBeGreaterThan(0),
    );

    available = false;
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    // The list request has not answered yet, so this proves the card is hidden
    // by the detail outcome rather than by the refetched list.
    await waitFor(() => expect(screen.queryAllByRole('img')).toHaveLength(0));
    expect(screen.queryByRole('link', { name: '결승선' })).toBeNull();
    expect(revoked).toContain('blob:inflight');
    listGate.resolve(true);
  } finally {
    revoke.mockRestore();
  }
});

it('explains an oversize upload rejected on the content transfer', async () => {
  const user = userEvent.setup();
  const transport = transportFor((input) => {
    if (input.method === 'GET') return { status: 200, body: { items: [], total: 0 } };
    if (input.path === '/bff/v1/gallery/media/uploads')
      return { status: 200, body: reservationBody };
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  const upload = vi.fn<GalleryMediaTransfer['upload']>(async () => {
    throw new Error('FILE_TOO_LARGE');
  });
  renderWorkspace(transport, { upload, open: vi.fn(async () => 'blob:preview') });
  await screen.findByText('아직 저장한 사진이나 동영상이 없습니다.');
  await user.upload(screen.getByLabelText('파일'), pngFile());
  await user.click(screen.getByRole('button', { name: '올리기' }));
  expect(
    await screen.findByText(
      '파일이 허용된 크기를 넘었습니다. 사진은 15 MiB, 동영상은 64 MiB까지 저장합니다.',
    ),
  ).toBeInTheDocument();
});

it('does not pull focus back to submit after a later successful upload', async () => {
  const user = userEvent.setup();
  let failNext = true;
  const finalizeGate = deferred();
  const transport: AuthenticatedTransport = {
    request: async (input) => {
      const reply = (status: number, body: unknown) =>
        transportReplySchema.parse({ status, body, traceId: null }) as never;
      if (input.method === 'GET') return reply(200, { items: [], total: 0 });
      if (input.path === '/bff/v1/gallery/media/uploads')
        return failNext
          ? reply(503, { error: { code: 'UPLOAD_RESUME_REQUIRED' } })
          : reply(200, reservationBody);
      if (input.path === `/bff/v1/gallery/media/uploads/${uploadId}/finalize`) {
        await finalizeGate.promise;
        return reply(200, { status: 'available', item });
      }
      throw new Error(`unexpected request ${input.method} ${input.path}`);
    },
  };
  renderWorkspace(transport, {
    upload: vi.fn(async () => undefined),
    open: vi.fn(async () => 'blob:preview'),
  });
  await screen.findByText('아직 저장한 사진이나 동영상이 없습니다.');
  await user.upload(screen.getByLabelText('파일'), pngFile());
  await user.click(screen.getByRole('button', { name: '올리기' }));
  expect(
    await screen.findByText('업로드가 중단됐습니다. 같은 파일로 다시 시도하세요.'),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '올리기' })).toHaveFocus();

  failNext = false;
  await user.upload(screen.getByLabelText('파일'), pngFile());
  await user.click(screen.getByRole('button', { name: '올리기' }));
  // Still finalizing: the form controls are disabled, so a real user can only
  // move to something that stays enabled, such as the filter navigation.
  expect(await screen.findByText('저장 확정 중')).toBeInTheDocument();
  const filterLink = screen.getByRole('link', { name: '사진' });
  filterLink.focus();
  expect(filterLink).toHaveFocus();

  finalizeGate.resolve(true);
  await waitFor(() => expect(screen.queryByText('저장 확정 중')).toBeNull());
  await waitFor(() => expect(screen.getByRole('button', { name: '올리기' })).not.toBeDisabled());
  // The finished upload must not grab focus back.
  expect(filterLink).toHaveFocus();
  expect(screen.getByRole('button', { name: '올리기' })).not.toHaveFocus();
});

it('falls back to the generic message for an inherited allowlist key', async () => {
  const user = userEvent.setup();
  const transport = transportFor((input) => {
    if (input.method === 'GET') return { status: 200, body: { items: [], total: 0 } };
    if (input.path === '/bff/v1/gallery/media/uploads')
      return { status: 200, body: reservationBody };
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  const upload = vi.fn<GalleryMediaTransfer['upload']>(async () => {
    throw new Error('constructor');
  });
  renderWorkspace(transport, { upload, open: vi.fn(async () => 'blob:preview') });
  await screen.findByText('아직 저장한 사진이나 동영상이 없습니다.');
  await user.upload(screen.getByLabelText('파일'), pngFile());
  await user.click(screen.getByRole('button', { name: '올리기' }));
  expect(await screen.findByText('요청을 완료하지 못했습니다.')).toBeInTheDocument();
});

it('hides cached list media when the detail is gone and the list refetch fails', async () => {
  const revoked: string[] = [];
  let available = true;
  const transport = transportFor((input) => {
    if (input.method === 'GET' && input.path.startsWith('/bff/v1/gallery/media?'))
      return available
        ? { status: 200, body: { items: [item], total: 1 } }
        : { status: 503, body: { error: { code: 'LIST_UNAVAILABLE' } } };
    if (input.method === 'GET' && input.path === `/bff/v1/gallery/media/${mediaItemId}`)
      return available
        ? { status: 200, body: { status: 'available', item } }
        : { status: 404, body: { error: { code: 'MEDIA_NOT_FOUND' } } };
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  const revoke = vi
    .spyOn(URL, 'revokeObjectURL')
    .mockImplementation((value) => revoked.push(value));
  try {
    render(
      <GalleryWorkspace
        athleteId="athlete"
        sessionId="session"
        transport={transport}
        mediaItemId={mediaItemId}
        mediaTransfer={{ upload: vi.fn(), open: vi.fn(async () => 'blob:both') }}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByRole('img', { name: '결승선' }).length).toBeGreaterThan(0),
    );

    // Deleted elsewhere: the detail read 404s and the list refetch fails at the
    // same moment, so nothing may be rendered from either cached payload.
    available = false;
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryAllByRole('img')).toHaveLength(0));
    expect(screen.queryByRole('link', { name: '결승선' })).toBeNull();
    expect(await screen.findByText('갤러리를 불러오지 못했습니다.')).toBeInTheDocument();
    expect(revoked).toContain('blob:both');
  } finally {
    revoke.mockRestore();
  }
});

it('drops the deleted item from the detail view instead of showing stale media', async () => {
  const user = userEvent.setup();
  const openedUrls: string[] = [];
  let listed = [item];
  const transport = transportFor((input) => {
    if (input.method === 'GET' && input.path.startsWith('/bff/v1/gallery/media?'))
      return { status: 200, body: { items: listed, total: listed.length } };
    if (input.method === 'GET' && input.path === `/bff/v1/gallery/media/${mediaItemId}`)
      return listed.length > 0
        ? { status: 200, body: { status: 'available', item } }
        : { status: 404, body: { error: { code: 'MEDIA_NOT_FOUND' } } };
    if (input.method === 'DELETE' && input.path === `/bff/v1/gallery/media/${mediaItemId}`) {
      listed = [];
      return {
        status: 200,
        body: {
          status: 'deleted',
          mediaItemId,
          deletedAt: createdAt,
          accessRevision: 2,
        },
      };
    }
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  const revoke = vi
    .spyOn(URL, 'revokeObjectURL')
    .mockImplementation((value) => openedUrls.push(value));
  try {
    render(
      <GalleryWorkspace
        athleteId="athlete"
        sessionId="session"
        transport={transport}
        mediaItemId={mediaItemId}
        mediaTransfer={{ upload: vi.fn(), open: vi.fn(async () => 'blob:selected') }}
      />,
    );
    await screen.findByRole('heading', { level: 2, name: '선택한 미디어' });
    await waitFor(() =>
      expect(screen.getAllByRole('img', { name: '결승선' }).length).toBeGreaterThan(0),
    );

    await user.click(screen.getAllByRole('button', { name: '삭제' })[0] as HTMLElement);

    expect(
      await screen.findByText('이 미디어는 삭제되어 더 이상 열람할 수 없습니다.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '결승선' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '결승선' })).not.toBeInTheDocument();
    expect(openedUrls).toContain('blob:selected');
  } finally {
    revoke.mockRestore();
  }
});

it('rejects an unsupported file before reserving an upload', async () => {
  const user = userEvent.setup();
  const upload = vi.fn<GalleryMediaTransfer['upload']>();
  renderWorkspace(listOnly(200, { items: [], total: 0 }), {
    upload,
    open: vi.fn(async () => 'blob:preview'),
  });
  await screen.findByText('아직 저장한 사진이나 동영상이 없습니다.');
  const input = screen.getByLabelText('파일');
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File(['x'], 'notes.txt', { type: 'text/plain' })],
  });
  fireEvent.change(input);
  await user.click(screen.getByRole('button', { name: '올리기' }));
  expect(await screen.findByText('지원하지 않는 파일 형식입니다.')).toBeInTheDocument();
  expect(upload).not.toHaveBeenCalled();
});

it('states that media cannot be shown when no transfer capability is injected', async () => {
  renderWorkspace(listOnly());
  await screen.findByRole('link', { name: '결승선' });
  expect(screen.getByText('이 환경에서는 미디어를 표시할 수 없습니다.')).toBeInTheDocument();
});

import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import type { GalleryMediaItem } from '@workout/contracts/gallery';
import { ActivityMediaPanel, type GalleryMediaTransfer } from '../src/activity-media-panel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const activityId = '20000000-0000-4000-8000-000000000001';
const otherActivityId = '20000000-0000-4000-8000-000000000002';
const createdAt = '2026-09-19T00:00:00.000Z';

function media(id: string, caption: string, overrides: Partial<GalleryMediaItem> = {}) {
  return {
    id,
    mediaKind: 'image' as const,
    visibility: 'private' as const,
    includeForCoach: false as const,
    album: '대회',
    caption,
    activityId: null,
    capturedAt: null,
    capturedLocalDate: null,
    file: {
      originalFileName: `${caption}.png`,
      mediaType: 'image/png' as const,
      byteSize: 2048,
      sha256: 'a'.repeat(64),
    },
    preview: null,
    accessRevision: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  } satisfies GalleryMediaItem;
}

interface Request {
  path: string;
  method: string;
  body: unknown;
}

/** A stateful stand-in for the gallery API: list filtering and the PATCH link write. */
function galleryServer(initial: GalleryMediaItem[]) {
  const items = new Map(initial.map((item) => [item.id, item]));
  const requests: Request[] = [];
  let failNextPatch: { status: number; code: string } | null = null;
  const transport: AuthenticatedTransport = {
    request: async (input) => {
      const request = { path: input.path, method: input.method, body: input.body };
      requests.push(request);
      const url = new URL(input.path, 'http://localhost');
      const reply = (status: number, body: unknown) =>
        transportReplySchema.parse({ status, body, traceId: null }) as never;
      if (input.method === 'GET' && url.pathname === '/bff/v1/gallery/media') {
        const filter = url.searchParams.get('activityId');
        const listed = [...items.values()].filter(
          (item) => filter === null || item.activityId === filter,
        );
        return reply(200, { items: listed, total: listed.length });
      }
      const patch = url.pathname.match(/^\/bff\/v1\/gallery\/media\/([0-9a-f-]{36})$/);
      if (input.method === 'PATCH' && patch?.[1]) {
        if (failNextPatch) {
          const failure = failNextPatch;
          failNextPatch = null;
          return reply(failure.status, { error: { code: failure.code } });
        }
        const current = items.get(patch[1]);
        if (!current) return reply(404, { error: { code: 'MEDIA_NOT_FOUND' } });
        const body = input.body as { activityId: string | null; expectedAccessRevision: number };
        if (body.expectedAccessRevision !== current.accessRevision)
          return reply(409, { error: { code: 'REVISION_CONFLICT' } });
        const next = {
          ...current,
          activityId: body.activityId,
          accessRevision: current.accessRevision + 1,
        };
        items.set(next.id, next);
        return reply(200, { status: 'available', item: next });
      }
      throw new Error(`unexpected request ${input.method} ${input.path}`);
    },
  };
  return {
    transport,
    requests,
    items,
    failNextPatch(status: number, code: string) {
      failNextPatch = { status, code };
    },
  };
}

function transferStub() {
  const open = vi.fn(async (input: { mediaItemId: string; variant: string }) => {
    return `blob:${input.mediaItemId}:${input.variant}`;
  });
  const transfer: GalleryMediaTransfer = { upload: vi.fn(), open };
  return { transfer, open };
}

function renderPanel(transport: AuthenticatedTransport, transfer?: GalleryMediaTransfer) {
  return render(
    <ActivityMediaPanel
      athleteId="athlete"
      sessionId="session"
      transport={transport}
      activityId={activityId}
      {...(transfer ? { mediaTransfer: transfer } : {})}
    />,
  );
}

const linkedRegion = () => screen.getByRole('region', { name: '이 활동의 미디어' });
const pickerRegion = () => screen.getByRole('region', { name: '갤러리에서 연결' });

it('links an existing gallery item to the activity through the gallery update, preserving its metadata', async () => {
  const user = userEvent.setup();
  const finish = media('10000000-0000-4000-8000-000000000001', '결승선');
  const server = galleryServer([finish]);
  renderPanel(server.transport);
  expect(
    await within(linkedRegion()).findByText('이 활동에 연결한 미디어가 없습니다.'),
  ).toBeVisible();
  const card = await within(pickerRegion()).findByRole('article', { name: '결승선' });
  await user.click(within(card).getByRole('button', { name: '이 활동에 연결' }));

  expect(
    await within(linkedRegion()).findByRole('article', { name: '결승선' }),
  ).toBeInTheDocument();
  expect(await screen.findByText('결승선을(를) 이 활동에 연결했습니다.')).toBeInTheDocument();
  const patch = server.requests.find((request) => request.method === 'PATCH');
  expect(patch).toEqual({
    path: `/bff/v1/gallery/media/${finish.id}`,
    method: 'PATCH',
    body: { album: '대회', caption: '결승선', activityId, expectedAccessRevision: 1 },
  });
  expect(server.items.get(finish.id)?.activityId).toBe(activityId);
  // The linked item leaves the picker: it is shown once, where it now belongs.
  await waitFor(() =>
    expect(within(pickerRegion()).queryByRole('article', { name: '결승선' })).toBeNull(),
  );
  // The linked list is read with the server-side activity filter.
  expect(
    server.requests.some(
      (request) => request.method === 'GET' && request.path.includes(`activityId=${activityId}`),
    ),
  ).toBe(true);
});

it('unlinks by clearing the activity on the gallery item', async () => {
  const user = userEvent.setup();
  const finish = media('10000000-0000-4000-8000-000000000001', '결승선', { activityId });
  const server = galleryServer([finish]);
  renderPanel(server.transport);
  const card = await within(linkedRegion()).findByRole('article', { name: '결승선' });
  await user.click(within(card).getByRole('button', { name: '연결 해제' }));
  expect(
    await within(linkedRegion()).findByText('이 활동에 연결한 미디어가 없습니다.'),
  ).toBeVisible();
  expect(await within(pickerRegion()).findByRole('article', { name: '결승선' })).toBeVisible();
  expect(server.items.get(finish.id)?.activityId).toBeNull();
  expect(server.requests.find((request) => request.method === 'PATCH')?.body).toMatchObject({
    activityId: null,
    expectedAccessRevision: 1,
  });
});

it('marks media linked to another activity and moves it on link', async () => {
  const user = userEvent.setup();
  const elsewhere = media('10000000-0000-4000-8000-000000000002', '다른 날', {
    activityId: otherActivityId,
  });
  const server = galleryServer([elsewhere]);
  renderPanel(server.transport);
  const card = await within(pickerRegion()).findByRole('article', { name: '다른 날' });
  expect(card).toHaveTextContent('다른 활동에 연결됨');
  await user.click(within(card).getByRole('button', { name: '이 활동에 연결' }));
  expect(await within(linkedRegion()).findByRole('article', { name: '다른 날' })).toBeVisible();
  expect(server.items.get(elsewhere.id)?.activityId).toBe(activityId);
});

it('reports a conflicting change and shows the server state after it', async () => {
  const user = userEvent.setup();
  const finish = media('10000000-0000-4000-8000-000000000001', '결승선');
  const server = galleryServer([finish]);
  renderPanel(server.transport);
  const card = await within(pickerRegion()).findByRole('article', { name: '결승선' });
  server.failNextPatch(409, 'REVISION_CONFLICT');
  await user.click(within(card).getByRole('button', { name: '이 활동에 연결' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('다른 변경이 먼저 저장되었습니다.');
  expect(server.items.get(finish.id)?.activityId).toBeNull();
  expect(within(linkedRegion()).getByText('이 활동에 연결한 미디어가 없습니다.')).toBeVisible();
});

it('loads the thumbnail variant and downloads the original through the authenticated transfer', async () => {
  const user = userEvent.setup();
  const finish = media('10000000-0000-4000-8000-000000000001', '결승선', {
    activityId,
    preview: {
      kind: 'preview',
      mediaType: 'image/jpeg',
      byteSize: 512,
      sha256: 'b'.repeat(64),
    },
  });
  const server = galleryServer([finish]);
  const { transfer, open } = transferStub();
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const clicked: { href: string; download: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({ href: this.href, download: this.download });
  });
  renderPanel(server.transport, transfer);
  const card = await within(linkedRegion()).findByRole('article', { name: '결승선' });
  expect(await within(card).findByRole('img', { name: '결승선' })).toHaveAttribute(
    'src',
    `blob:${finish.id}:preview`,
  );
  await user.click(within(card).getByRole('button', { name: '원본 내려받기' }));
  await waitFor(() => expect(clicked).toHaveLength(1));
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ mediaItemId: finish.id, variant: 'original' }),
  );
  expect(clicked[0]).toEqual({ href: `blob:${finish.id}:original`, download: '결승선.png' });
  // The download's blob URL does not outlive the click.
  expect(revoke).toHaveBeenCalledWith(`blob:${finish.id}:original`);
});

it('reports a failed download', async () => {
  const user = userEvent.setup();
  const finish = media('10000000-0000-4000-8000-000000000001', '결승선', {
    activityId,
    preview: { kind: 'preview', mediaType: 'image/jpeg', byteSize: 512, sha256: 'b'.repeat(64) },
  });
  const server = galleryServer([finish]);
  const transfer: GalleryMediaTransfer = {
    upload: vi.fn(),
    open: vi.fn(async (input) => {
      if (input.variant === 'original') throw new Error('REQUEST_FAILED');
      return 'blob:thumbnail';
    }),
  };
  renderPanel(server.transport, transfer);
  const card = await within(linkedRegion()).findByRole('article', { name: '결승선' });
  await user.click(within(card).getByRole('button', { name: '원본 내려받기' }));
  expect(await within(card).findByRole('alert')).toHaveTextContent('원본을 내려받지 못했습니다.');
});

it('never renders cached media after the linked list fails to refresh', async () => {
  const user = userEvent.setup();
  const finish = media('10000000-0000-4000-8000-000000000001', '결승선', { activityId });
  const server = galleryServer([finish]);
  let failLists = false;
  const transport: AuthenticatedTransport = {
    request: async (input) => {
      if (failLists && input.method === 'GET')
        return transportReplySchema.parse({
          status: 500,
          body: { error: { code: 'INTERNAL' } },
          traceId: null,
        }) as never;
      return server.transport.request(input);
    },
  };
  const { transfer } = transferStub();
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  renderPanel(transport, transfer);
  const card = await within(linkedRegion()).findByRole('article', { name: '결승선' });
  expect(await within(card).findByRole('img')).toBeInTheDocument();
  // The item was deleted elsewhere; the refresh that would reveal it fails.
  failLists = true;
  server.items.delete(finish.id);
  await user.click(within(card).getByRole('button', { name: '연결 해제' }));
  expect(
    await within(linkedRegion()).findByText('연결한 미디어를 불러오지 못했습니다.', {
      exact: false,
    }),
  ).toBeVisible();
  expect(screen.queryAllByRole('img')).toHaveLength(0);
});

it('keeps focus with the card it moved after link and unlink', async () => {
  const user = userEvent.setup();
  const finish = media('10000000-0000-4000-8000-000000000001', '결승선');
  const server = galleryServer([finish]);
  renderPanel(server.transport);
  const candidate = await within(pickerRegion()).findByRole('article', { name: '결승선' });
  await user.click(within(candidate).getByRole('button', { name: '이 활동에 연결' }));
  // The pressed button is gone with its card; focus lands on the card in its new list.
  const linkedCard = await within(linkedRegion()).findByRole('article', { name: '결승선' });
  await waitFor(() =>
    expect(within(linkedCard).getByRole('heading', { level: 5, name: '결승선' })).toHaveFocus(),
  );
  await user.click(within(linkedCard).getByRole('button', { name: '연결 해제' }));
  const back = await within(pickerRegion()).findByRole('article', { name: '결승선' });
  await waitFor(() =>
    expect(within(back).getByRole('heading', { level: 5, name: '결승선' })).toHaveFocus(),
  );
  expect(document.body).not.toHaveFocus();
});

it('falls back to the list heading when the moved card is not in the refreshed list', async () => {
  const user = userEvent.setup();
  const finish = media('10000000-0000-4000-8000-000000000001', '결승선');
  const server = galleryServer([finish]);
  let hideLinked = false;
  const transport: AuthenticatedTransport = {
    request: async (input) => {
      if (hideLinked && input.method === 'GET' && input.path.includes('activityId='))
        return transportReplySchema.parse({
          status: 200,
          body: { items: [], total: 0 },
          traceId: null,
        }) as never;
      return server.transport.request(input);
    },
  };
  renderPanel(transport);
  const candidate = await within(pickerRegion()).findByRole('article', { name: '결승선' });
  hideLinked = true;
  await user.click(within(candidate).getByRole('button', { name: '이 활동에 연결' }));
  await waitFor(() =>
    expect(screen.getByRole('heading', { level: 4, name: '이 활동의 미디어' })).toHaveFocus(),
  );
});

it('names every card action with its media and nests headings under the activity title', async () => {
  const first = media('10000000-0000-4000-8000-000000000001', '결승선', { activityId });
  const second = media('10000000-0000-4000-8000-000000000002', '출발선');
  const server = galleryServer([first, second]);
  renderPanel(server.transport, transferStub().transfer);
  const linkedCard = await within(linkedRegion()).findByRole('article', { name: '결승선' });
  const pickerCard = await within(pickerRegion()).findByRole('article', { name: '출발선' });
  for (const name of ['원본 내려받기', '연결 해제'])
    expect(within(linkedCard).getByRole('button', { name })).toHaveAccessibleDescription('결승선');
  expect(
    within(pickerCard).getByRole('button', { name: '이 활동에 연결' }),
  ).toHaveAccessibleDescription('출발선');
  // The activity title is an h3 in the detail; the panel sits below it.
  expect(screen.getByRole('heading', { level: 4, name: '이 활동의 미디어' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 4, name: '갤러리에서 연결' })).toBeInTheDocument();
  expect(within(linkedCard).getByRole('heading', { level: 5, name: '결승선' })).toBeInTheDocument();
  expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
});

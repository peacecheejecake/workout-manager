import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import {
  privateResourceReadResultSchema,
  privateTextResourceReadResultSchema,
  type PrivateUrlResourceFailure,
} from '@workout/contracts/resources';
import { ResourceWorkspace, type ResourceFileTransfer } from '../src/resource-workspace';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const resourceId = '10000000-0000-4000-8000-000000000001';
const versionId = '10000000-0000-4000-8000-000000000002';
const previousVersionId = '10000000-0000-4000-8000-000000000003';
const createdAt = '2026-09-19T00:00:00.000Z';
const text = '첫 문단입니다.\n\n두 번째 문단입니다.';
const paragraphs = [
  {
    locator: {
      kind: 'paragraph' as const,
      resourceVersionId: versionId,
      index: 0,
      startOffset: 0,
      endOffset: 8,
      offsetUnit: 'utf16_code_unit' as const,
    },
    text: '첫 문단입니다.',
  },
  {
    locator: {
      kind: 'paragraph' as const,
      resourceVersionId: versionId,
      index: 1,
      startOffset: 10,
      endOffset: 21,
      offsetUnit: 'utf16_code_unit' as const,
    },
    text: '두 번째 문단입니다.',
  },
];
const resource = {
  schemaVersion: 1 as const,
  id: resourceId,
  sourceKind: 'text' as const,
  title: '훈련 원칙 메모',
  category: 'note' as const,
  metadata: { language: 'ko' },
  tags: ['원칙'],
  visibility: 'private' as const,
  favorite: true,
  includeForCoach: false as const,
  reviewedState: 'unreviewed' as const,
  lifecycle: { contentStatus: 'parsed' as const, indexStatus: 'not_indexed' as const },
  accessRevision: 1,
  currentVersionId: versionId,
  deletedAt: null,
  createdAt,
  updatedAt: createdAt,
};
const read = privateTextResourceReadResultSchema.parse({
  status: 'available',
  resource,
  version: {
    schemaVersion: 1,
    id: versionId,
    resourceId,
    version: 2,
    previousVersionId,
    contentHash: 'a'.repeat(64),
    source: { kind: 'text', text },
    paragraphs,
    lifecycle: resource.lifecycle,
    createdAt,
  },
  reader: {
    resourceId,
    resourceVersionId: versionId,
    title: resource.title,
    sourceKind: 'text',
    lifecycle: resource.lifecycle,
    originalText: text,
    paragraphs,
  },
});

const fileResourceId = '20000000-0000-4000-8000-000000000001';
const fileVersionId = '20000000-0000-4000-8000-000000000002';
const fileDescriptor = {
  originalFileName: '훈련-계획.pdf',
  extension: 'pdf' as const,
  mediaType: 'application/pdf' as const,
  byteSize: 15,
  sha256: 'b'.repeat(64),
};
const fileResource = {
  ...resource,
  id: fileResourceId,
  sourceKind: 'file' as const,
  title: '훈련 계획 PDF',
  lifecycle: { contentStatus: 'raw_stored' as const, indexStatus: 'not_indexed' as const },
  currentVersionId: fileVersionId,
};
const fileRead = privateResourceReadResultSchema.parse({
  status: 'available',
  resource: fileResource,
  version: {
    schemaVersion: 1,
    id: fileVersionId,
    resourceId: fileResourceId,
    version: 1,
    previousVersionId: null,
    contentHash: fileDescriptor.sha256,
    source: { kind: 'file', file: fileDescriptor },
    lifecycle: fileResource.lifecycle,
    createdAt,
  },
  reader: {
    resourceId: fileResourceId,
    resourceVersionId: fileVersionId,
    title: fileResource.title,
    sourceKind: 'file',
    lifecycle: fileResource.lifecycle,
    file: fileDescriptor,
  },
});

const urlResourceId = '50000000-0000-4000-8000-000000000001';
const urlVersionId = '50000000-0000-4000-8000-000000000002';
const ingestionId = '50000000-0000-4000-8000-000000000003';
const displayUrl = 'https://example.com/article';
const urlText = '첫 URL 문단';
const finalizedLifecycle = {
  contentStatus: 'finalized' as const,
  displayUrl,
  attempt: 2,
  retryAt: null,
  indexStatus: 'not_indexed' as const,
};
const provenance = {
  requestedDisplayUrl: displayUrl,
  finalDisplayUrl: displayUrl,
  fetchedAt: createdAt,
  mediaType: 'text/html' as const,
  byteSize: 128,
  sha256: 'c'.repeat(64),
  redirectCount: 0,
  parser: { name: 'article-parser', version: '1.0.0' },
};
const parsedSnapshot = {
  resourceVersionId: urlVersionId,
  text: urlText,
  fragments: [
    {
      locator: {
        kind: 'html_block' as const,
        resourceVersionId: urlVersionId,
        index: 0,
        startOffset: 0,
        endOffset: urlText.length,
        offsetUnit: 'utf16_code_unit' as const,
        headingPath: ['훈련'],
      },
      text: urlText,
    },
  ],
};
const urlResource = {
  ...resource,
  id: urlResourceId,
  sourceKind: 'url' as const,
  title: 'URL 훈련 자료',
  lifecycle: finalizedLifecycle,
  currentVersionId: urlVersionId,
};
const urlReadResult = privateResourceReadResultSchema.parse({
  status: 'available',
  resource: urlResource,
  version: {
    schemaVersion: 1,
    id: urlVersionId,
    resourceId: urlResourceId,
    version: 1,
    previousVersionId: null,
    contentHash: provenance.sha256,
    source: { kind: 'url', displayUrl },
    lifecycle: finalizedLifecycle,
    provenance,
    parsedSnapshot,
    createdAt,
  },
  reader: {
    resourceId: urlResourceId,
    resourceVersionId: urlVersionId,
    title: urlResource.title,
    sourceKind: 'url',
    lifecycle: finalizedLifecycle,
    provenance,
    parsedSnapshot,
  },
});
if (urlReadResult.status !== 'available' || urlReadResult.resource.sourceKind !== 'url')
  throw new Error('Expected an available URL fixture.');
const urlRead = urlReadResult;

function ingestionRecord(
  lifecycle:
    | typeof finalizedLifecycle
    | {
        contentStatus: 'queued' | 'fetching' | 'parsing' | 'bookmark_only' | 'cancelled';
        displayUrl: string;
        attempt: number;
        retryAt: string | null;
        indexStatus: 'not_indexed';
      }
    | {
        contentStatus: 'failed';
        displayUrl: string;
        attempt: number;
        retryAt: string | null;
        indexStatus: 'not_indexed';
        failure: PrivateUrlResourceFailure;
      },
) {
  return {
    schemaVersion: 1,
    ingestionId,
    operation: 'create',
    resourceId: urlResourceId,
    versionId: urlVersionId,
    lifecycle,
    createdAt,
    updatedAt: createdAt,
  };
}

it('shows version-pinned paragraphs and clears private results on account switch', async () => {
  const ownerRequests = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    if (input.path.startsWith(`/bff/v1/resources/${resourceId}`)) {
      return transportReplySchema.parse({ status: 200, body: read, traceId: null });
    }
    if (input.path.startsWith('/bff/v1/resources?')) {
      return transportReplySchema.parse({
        status: 200,
        body: { items: [resource], total: 1 },
        traceId: null,
      });
    }
    return transportReplySchema.parse({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
      traceId: null,
    });
  });
  const otherRequests = vi.fn<AuthenticatedTransport['request']>(async () =>
    transportReplySchema.parse({
      status: 200,
      body: { items: [], total: 0 },
      traceId: null,
    }),
  );
  const view = render(
    <ResourceWorkspace
      athleteId="owner"
      sessionId="owner-session"
      transport={{ request: ownerRequests }}
      resourceId={resourceId}
    />,
  );
  expect(await screen.findAllByRole('heading', { level: 3, name: resource.title })).toHaveLength(2);
  expect(screen.getAllByText(/검색 색인 안 됨 · 코치 사용 안 함/).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByRole('link', { name: '문단 1 링크' }).getAttribute('href')).toBe(
    '#paragraph-1',
  );
  expect(screen.getByRole('link', { name: '이전 버전 열기' }).getAttribute('href')).toBe(
    `/resources/${resourceId}?version=${previousVersionId}`,
  );
  expect(ownerRequests).toHaveBeenCalledWith(
    expect.objectContaining({ path: `/bff/v1/resources/${resourceId}`, method: 'GET' }),
  );

  view.rerender(
    <ResourceWorkspace
      athleteId="other"
      sessionId="other-session"
      transport={{ request: otherRequests }}
    />,
  );
  await screen.findByText('저장한 자료가 없습니다.');
  expect(screen.queryByText('첫 문단입니다.')).toBeNull();
  expect(screen.queryByText(resource.title)).toBeNull();
});

it('reuses an uncertain request key, then replaces a terminal failed upload intent', async () => {
  const user = userEvent.setup();
  const uploadId = '30000000-0000-4000-8000-000000000001';
  const retryUploadId = '30000000-0000-4000-8000-000000000004';
  const reservedResourceId = '30000000-0000-4000-8000-000000000002';
  const reservedVersionId = '30000000-0000-4000-8000-000000000003';
  let reserveCalls = 0;
  const requests = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    if (input.path.startsWith('/bff/v1/resources?')) {
      return transportReplySchema.parse({
        status: 200,
        body: { items: [], total: 0 },
        traceId: null,
      });
    }
    if (input.path === '/bff/v1/resources/uploads') {
      reserveCalls += 1;
      return transportReplySchema.parse({
        status: 200,
        body: {
          uploadId: reserveCalls === 3 ? retryUploadId : uploadId,
          resourceId: reservedResourceId,
          versionId: reservedVersionId,
          state: reserveCalls === 2 ? 'failed' : reserveCalls === 3 ? 'prepared' : 'reserved',
          createdAt,
          updatedAt: createdAt,
        },
        traceId: null,
      });
    }
    if (input.path === `/bff/v1/resources/uploads/${retryUploadId}/finalize`) {
      return transportReplySchema.parse({
        status: 200,
        body: { status: 'unavailable' },
        traceId: null,
      });
    }
    return transportReplySchema.parse({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
      traceId: null,
    });
  });
  const upload = vi
    .fn<ResourceFileTransfer['upload']>()
    .mockImplementationOnce(async ({ file, onProgress }) => {
      onProgress(Math.ceil(file.size / 2), file.size);
      throw new Error('offline');
    })
    .mockImplementationOnce(async ({ file, onProgress }) => {
      onProgress(file.size, file.size);
    });

  render(
    <ResourceWorkspace
      athleteId="owner"
      sessionId="owner-session"
      transport={{ request: requests }}
      fileTransfer={{ upload, open: vi.fn() }}
    />,
  );
  const form = screen.getByRole('form', { name: '파일 자료 만들기' });
  await user.type(within(form).getByLabelText('제목'), '업로드 자료');
  const selected = new File(['%PDF-1.7 sample'], '훈련.pdf', { type: 'application/pdf' });
  await user.upload(within(form).getByLabelText('원본 파일'), selected);
  fireEvent.submit(form);

  expect((await within(form).findByRole('alert')).textContent).toContain(
    '선택한 파일은 유지되었습니다',
  );
  const firstIntent = requests.mock.calls
    .map(([input]) => input)
    .find((input) => input.path === '/bff/v1/resources/uploads');
  expect(firstIntent?.idempotencyKey).toBeTruthy();

  expect(within(form).getByRole('button', { name: '파일 업로드 다시 시도' })).not.toBeNull();
  fireEvent.submit(form);
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(requests).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/bff/v1/resources/uploads/${retryUploadId}/finalize`,
        method: 'POST',
      }),
    ),
  );
  const intents = requests.mock.calls
    .map(([input]) => input)
    .filter((input) => input.path === '/bff/v1/resources/uploads');
  expect(intents).toHaveLength(3);
  expect(intents[1]?.idempotencyKey).toBe(firstIntent?.idempotencyKey);
  expect(intents[2]?.idempotencyKey).not.toBe(firstIntent?.idempotencyKey);
  expect(upload).toHaveBeenLastCalledWith(
    expect.objectContaining({
      uploadId: retryUploadId,
      file: selected,
      mediaType: 'application/pdf',
      signal: expect.any(AbortSignal),
    }),
  );
});

it.each([
  ['UPLOAD_RESUME_REQUIRED', true],
  ['UPLOAD_RETRY_REQUIRED', false],
] as const)(
  '%s controls whether the file upload retry keeps its request key',
  async (code, keepsKey) => {
    const user = userEvent.setup();
    const firstUploadId = '40000000-0000-4000-8000-000000000001';
    const secondUploadId = '40000000-0000-4000-8000-000000000002';
    let reserveCalls = 0;
    const requests = vi.fn<AuthenticatedTransport['request']>(async (input) => {
      if (input.path.startsWith('/bff/v1/resources?')) {
        return transportReplySchema.parse({
          status: 200,
          body: { items: [], total: 0 },
          traceId: null,
        });
      }
      if (input.path === '/bff/v1/resources/uploads') {
        reserveCalls += 1;
        return transportReplySchema.parse({
          status: 200,
          body: {
            uploadId: reserveCalls === 1 ? firstUploadId : secondUploadId,
            resourceId: '40000000-0000-4000-8000-000000000003',
            versionId: '40000000-0000-4000-8000-000000000004',
            state: 'reserved',
            createdAt,
            updatedAt: createdAt,
          },
          traceId: null,
        });
      }
      if (input.path === `/bff/v1/resources/uploads/${secondUploadId}/finalize`) {
        return transportReplySchema.parse({
          status: 200,
          body: { status: 'unavailable' },
          traceId: null,
        });
      }
      return transportReplySchema.parse({
        status: 404,
        body: { error: { code: 'NOT_FOUND' } },
        traceId: null,
      });
    });
    const upload = vi
      .fn<ResourceFileTransfer['upload']>()
      .mockRejectedValueOnce(new Error(code))
      .mockResolvedValueOnce(undefined);

    render(
      <ResourceWorkspace
        athleteId="owner"
        sessionId="owner-session"
        transport={{ request: requests }}
        fileTransfer={{ upload, open: vi.fn() }}
      />,
    );
    const form = screen.getByRole('form', { name: '파일 자료 만들기' });
    await user.type(within(form).getByLabelText('제목'), '재시도 계약');
    await user.upload(
      within(form).getByLabelText('원본 파일'),
      new File(['%PDF-1.7 retry'], 'retry.pdf', { type: 'application/pdf' }),
    );
    fireEvent.submit(form);
    await within(form).findByRole('alert');
    fireEvent.submit(form);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));

    const intents = requests.mock.calls
      .map(([input]) => input)
      .filter((input) => input.path === '/bff/v1/resources/uploads');
    expect(intents).toHaveLength(2);
    if (keepsKey) {
      expect(intents[1]?.idempotencyKey).toBe(intents[0]?.idempotencyKey);
    } else {
      expect(intents[1]?.idempotencyKey).not.toBe(intents[0]?.idempotencyKey);
    }
  },
);

it('shows an unparsed file descriptor and delegates authenticated opening for its pinned version', async () => {
  const user = userEvent.setup();
  const requests = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    if (input.path.startsWith(`/bff/v1/resources/${fileResourceId}`)) {
      return transportReplySchema.parse({ status: 200, body: fileRead, traceId: null });
    }
    return transportReplySchema.parse({
      status: 200,
      body: { items: [fileResource], total: 1 },
      traceId: null,
    });
  });
  const open = vi.fn<ResourceFileTransfer['open']>(async () => undefined);

  render(
    <ResourceWorkspace
      athleteId="owner"
      sessionId="owner-session"
      transport={{ request: requests }}
      resourceId={fileResourceId}
      fileTransfer={{ upload: vi.fn(), open }}
    />,
  );

  expect(await screen.findByText(fileDescriptor.originalFileName)).not.toBeNull();
  expect(screen.getAllByText(/원본 파일 저장됨 · 본문 파싱 안 됨/)).not.toHaveLength(0);
  expect(screen.queryByText('첫 문단입니다.')).toBeNull();
  await user.click(screen.getByRole('button', { name: '원본 파일 열기 또는 다운로드' }));
  expect(open).toHaveBeenCalledWith({
    resourceId: fileResourceId,
    versionId: fileVersionId,
    fileName: fileDescriptor.originalFileName,
    signal: expect.any(AbortSignal),
  });
});

it('reuses the URL create key after an uncertain error and polls to finalized without exposing its query', async () => {
  const user = userEvent.setup();
  let createCalls = 0;
  let listCalls = 0;
  const queued = ingestionRecord({
    contentStatus: 'queued',
    displayUrl,
    attempt: 1,
    retryAt: null,
    indexStatus: 'not_indexed',
  });
  const finalized = ingestionRecord(finalizedLifecycle);
  const requests = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    if (input.path.startsWith('/bff/v1/resources?')) {
      listCalls += 1;
      return transportReplySchema.parse({
        status: 200,
        body: { items: listCalls === 1 ? [] : [urlResource], total: listCalls === 1 ? 0 : 1 },
        traceId: null,
      });
    }
    if (input.path === '/bff/v1/resources/url-ingestions' && input.method === 'POST') {
      createCalls += 1;
      if (createCalls === 1) {
        return transportReplySchema.parse({
          status: 503,
          body: { error: { code: 'TEMPORARILY_UNAVAILABLE' } },
          traceId: null,
        });
      }
      return transportReplySchema.parse({ status: 202, body: queued, traceId: null });
    }
    if (input.path === `/bff/v1/resources/url-ingestions/${ingestionId}`) {
      return transportReplySchema.parse({ status: 200, body: finalized, traceId: null });
    }
    return transportReplySchema.parse({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
      traceId: null,
    });
  });

  render(
    <ResourceWorkspace
      athleteId="owner"
      sessionId="owner-session"
      transport={{ request: requests }}
    />,
  );
  const form = screen.getByRole('form', { name: 'URL 자료 가져오기' });
  await user.type(within(form).getByLabelText('제목'), 'URL 가져오기');
  await user.type(
    within(form).getByLabelText('자료 URL'),
    'https://example.com/article?token=private',
  );
  await user.click(within(form).getByRole('button', { name: 'URL 자료 가져오기' }));
  expect((await within(form).findByRole('alert')).textContent).toContain(
    '입력한 제목과 URL은 유지되었습니다',
  );
  expect(within(form).getByLabelText<HTMLInputElement>('자료 URL').value).toContain(
    'token=private',
  );

  await user.click(within(form).getByRole('button', { name: 'URL 자료 가져오기' }));
  expect(await screen.findByText(/본문 파싱 완료 · 검색 색인 안 됨/)).not.toBeNull();
  await vi.waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  expect(screen.getByText(displayUrl)).not.toBeNull();
  expect(screen.queryByText(/token=private/)).toBeNull();
  expect(within(form).getByLabelText<HTMLInputElement>('자료 URL').value).toBe('');

  const createRequests = requests.mock.calls
    .map(([input]) => input)
    .filter((input) => input.path === '/bff/v1/resources/url-ingestions');
  expect(createRequests).toHaveLength(2);
  expect(createRequests[1]?.idempotencyKey).toBe(createRequests[0]?.idempotencyKey);
  expect(createRequests[1]).toEqual(
    expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        sourceKind: 'url',
        title: 'URL 가져오기',
        url: 'https://example.com/article?token=private',
      }),
    }),
  );
});

it.each([
  [
    'failed',
    ingestionRecord({
      contentStatus: 'failed',
      displayUrl,
      attempt: 1,
      retryAt: null,
      indexStatus: 'not_indexed',
      failure: {
        stage: 'fetch',
        code: 'blocked_address',
        retryable: false,
        failedAt: createdAt,
      },
    }),
    '안전 정책에 따라 이 주소를 가져올 수 없습니다.',
  ],
  [
    'bookmark_only',
    ingestionRecord({
      contentStatus: 'bookmark_only',
      displayUrl,
      attempt: 1,
      retryAt: null,
      indexStatus: 'not_indexed',
    }),
    '북마크만 저장됨',
  ],
] as const)('shows the closed %s URL ingestion state', async (status, record, message) => {
  const user = userEvent.setup();
  let listCalls = 0;
  const requests = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    if (input.path.startsWith('/bff/v1/resources?')) {
      listCalls += 1;
      return transportReplySchema.parse({
        status: 200,
        body: { items: [], total: 0 },
        traceId: null,
      });
    }
    if (input.path === '/bff/v1/resources/url-ingestions') {
      return transportReplySchema.parse({ status: 202, body: record, traceId: null });
    }
    if (input.path === `/bff/v1/resources/url-ingestions/${ingestionId}`) {
      return transportReplySchema.parse({ status: 200, body: record, traceId: null });
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });
  render(
    <ResourceWorkspace
      athleteId="owner"
      sessionId="owner-session"
      transport={{ request: requests }}
    />,
  );
  const form = screen.getByRole('form', { name: 'URL 자료 가져오기' });
  await user.type(within(form).getByLabelText('제목'), '닫힌 상태');
  await user.type(within(form).getByLabelText('자료 URL'), 'https://example.com/article');
  await user.click(within(form).getByRole('button', { name: 'URL 자료 가져오기' }));
  expect(await screen.findByText(new RegExp(message))).not.toBeNull();
  expect(screen.queryByText('blocked_address')).toBeNull();
  if (status === 'bookmark_only') {
    await vi.waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  } else {
    expect(listCalls).toBe(1);
  }
});

it('keeps polling and exposes a retryable URL failure until the automatic retry finishes', async () => {
  const failedAt = new Date().toISOString();
  const retryAt = new Date(Date.now() + 100).toISOString();
  const retrying = ingestionRecord({
    contentStatus: 'failed',
    displayUrl,
    attempt: 1,
    retryAt,
    indexStatus: 'not_indexed',
    failure: {
      stage: 'fetch',
      code: 'network_error',
      retryable: true,
      failedAt,
    },
  });
  const finalized = ingestionRecord(finalizedLifecycle);
  let statusCalls = 0;
  const requests = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    if (input.path.startsWith('/bff/v1/resources?')) {
      return transportReplySchema.parse({
        status: 200,
        body: { items: statusCalls >= 2 ? [urlResource] : [], total: statusCalls >= 2 ? 1 : 0 },
        traceId: null,
      });
    }
    if (input.path === '/bff/v1/resources/url-ingestions') {
      return transportReplySchema.parse({ status: 202, body: retrying, traceId: null });
    }
    if (input.path === `/bff/v1/resources/url-ingestions/${ingestionId}`) {
      statusCalls += 1;
      return transportReplySchema.parse({
        status: 200,
        body: statusCalls >= 2 ? finalized : retrying,
        traceId: null,
      });
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });
  render(
    <ResourceWorkspace
      athleteId="owner"
      sessionId="owner-session"
      transport={{ request: requests }}
    />,
  );
  fireEvent.change(screen.getByLabelText('제목', { selector: '#url-create-title' }), {
    target: { value: '재시도 자료' },
  });
  fireEvent.change(screen.getByLabelText('자료 URL'), { target: { value: displayUrl } });
  fireEvent.submit(screen.getByRole('form', { name: 'URL 자료 가져오기' }));
  expect(await screen.findByText(/자동 재시도 대기 중/)).not.toBeNull();
  expect(screen.getByText(retryAt)).not.toBeNull();
  expect(screen.getByRole('button', { name: '가져오기 취소' })).not.toBeNull();

  expect(await screen.findByText(/본문 파싱 완료 · 검색 색인 안 됨/)).not.toBeNull();
  expect(statusCalls).toBeGreaterThanOrEqual(2);
});

it('labels a pinned historical URL version from that version lifecycle', async () => {
  const bookmarkLifecycle = {
    contentStatus: 'bookmark_only' as const,
    displayUrl,
    attempt: 1,
    retryAt: null,
    indexStatus: 'not_indexed' as const,
  };
  const historical = privateResourceReadResultSchema.parse({
    status: 'available',
    resource: urlResource,
    version: {
      ...urlRead.version,
      lifecycle: bookmarkLifecycle,
      parsedSnapshot: undefined,
    },
    reader: {
      ...urlRead.reader,
      lifecycle: bookmarkLifecycle,
      parsedSnapshot: undefined,
    },
  });
  const historicalBody = JSON.parse(JSON.stringify(historical)) as unknown;
  const requests = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    if (input.path.startsWith(`/bff/v1/resources/${urlResourceId}`)) {
      return transportReplySchema.parse({ status: 200, body: historicalBody, traceId: null });
    }
    if (input.path.startsWith('/bff/v1/resources?')) {
      return transportReplySchema.parse({
        status: 200,
        body: { items: [urlResource], total: 1 },
        traceId: null,
      });
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });
  render(
    <ResourceWorkspace
      athleteId="owner"
      sessionId="owner-session"
      transport={{ request: requests }}
      resourceId={urlResourceId}
      versionId={urlVersionId}
    />,
  );
  const versionStatus = await screen.findByText(/원문 버전 1 · 북마크만 저장됨/);
  const readerArticle = versionStatus.closest('article');
  expect(readerArticle).not.toBeNull();
  expect(
    within(readerArticle as HTMLElement).getByText(/원문 버전 1 · 북마크만 저장됨/),
  ).not.toBeNull();
});

it('cancels an active URL ingestion through its public endpoint', async () => {
  const user = userEvent.setup();
  const queued = ingestionRecord({
    contentStatus: 'queued',
    displayUrl,
    attempt: 1,
    retryAt: null,
    indexStatus: 'not_indexed',
  });
  const cancelled = ingestionRecord({
    contentStatus: 'cancelled',
    displayUrl,
    attempt: 1,
    retryAt: null,
    indexStatus: 'not_indexed',
  });
  const requests = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    if (input.path.startsWith('/bff/v1/resources?')) {
      return transportReplySchema.parse({
        status: 200,
        body: { items: [], total: 0 },
        traceId: null,
      });
    }
    if (input.path === '/bff/v1/resources/url-ingestions') {
      return transportReplySchema.parse({ status: 202, body: queued, traceId: null });
    }
    if (input.path === `/bff/v1/resources/url-ingestions/${ingestionId}`) {
      return transportReplySchema.parse({
        status: 200,
        body: input.method === 'DELETE' ? cancelled : queued,
        traceId: null,
      });
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });
  render(
    <ResourceWorkspace
      athleteId="owner"
      sessionId="owner-session"
      transport={{ request: requests }}
    />,
  );
  const form = screen.getByRole('form', { name: 'URL 자료 가져오기' });
  await user.type(within(form).getByLabelText('제목'), '취소할 자료');
  await user.type(within(form).getByLabelText('자료 URL'), displayUrl);
  await user.click(within(form).getByRole('button', { name: 'URL 자료 가져오기' }));
  await user.click(await screen.findByRole('button', { name: '가져오기 취소' }));
  expect(await screen.findByText('가져오기가 취소됨')).not.toBeNull();
  expect(requests).toHaveBeenCalledWith(
    expect.objectContaining({
      path: `/bff/v1/resources/url-ingestions/${ingestionId}`,
      method: 'DELETE',
    }),
  );
});

it('renders finalized URL fragments with version-pinned locators', async () => {
  const requests = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    if (input.path.startsWith(`/bff/v1/resources/${urlResourceId}`)) {
      return transportReplySchema.parse({ status: 200, body: urlRead, traceId: null });
    }
    return transportReplySchema.parse({
      status: 200,
      body: { items: [urlResource], total: 1 },
      traceId: null,
    });
  });
  render(
    <ResourceWorkspace
      athleteId="owner"
      sessionId="owner-session"
      transport={{ request: requests }}
      resourceId={urlResourceId}
    />,
  );
  expect(await screen.findByText(urlText)).not.toBeNull();
  expect(screen.getByRole('link', { name: '본문 조각 1 링크' }).getAttribute('href')).toBe(
    '#url-fragment-1',
  );
  expect(screen.getByText(/HTML 블록 · 훈련 · UTF-16 0–/)).not.toBeNull();
  expect(screen.getAllByText(displayUrl)).not.toHaveLength(0);
  expect(screen.getAllByText(/private · 검색 색인 안 됨 · 코치 사용 안 함/)).not.toHaveLength(0);
});

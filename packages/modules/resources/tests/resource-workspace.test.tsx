import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import {
  privateResourceReadResultSchema,
  privateTextResourceReadResultSchema,
} from '@workout/contracts/resources';
import { ResourceWorkspace, type ResourceFileTransfer } from '../src/resource-workspace';

afterEach(() => cleanup());

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
  expect(screen.getAllByText(/검색 색인 안 됨 · 코치 사용 안 함/)).toHaveLength(2);
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

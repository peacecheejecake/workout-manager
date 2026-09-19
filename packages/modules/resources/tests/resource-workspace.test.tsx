import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { privateTextResourceReadResultSchema } from '@workout/contracts/resources';
import { ResourceWorkspace } from '../src/resource-workspace';

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

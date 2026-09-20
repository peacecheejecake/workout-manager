import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { privateTextResourceReadResultSchema } from '@workout/contracts/resources';
import { ResourceWorkspace } from '../src/resource-workspace';

afterEach(cleanup);

const resourceId = '10000000-0000-4000-8000-000000000001';
const versionId = '10000000-0000-4000-8000-000000000002';
const createdAt = '2026-09-19T00:00:00.000Z';
const text = '첫 문단입니다.';
const paragraphs = [
  {
    locator: {
      kind: 'paragraph' as const,
      resourceVersionId: versionId,
      index: 0,
      startOffset: 0,
      endOffset: text.length,
      offsetUnit: 'utf16_code_unit' as const,
    },
    text,
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
  includeForCoach: false,
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
    version: 1,
    previousVersionId: null,
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

const accessState = {
  schemaVersion: 1 as const,
  resourceId,
  accessRevision: 1,
  currentVersionId: versionId,
  reviewedState: 'unreviewed' as const,
  reviewedAt: null,
  reviewedVersionId: null,
  includeForCoach: false,
  coachUseEnabledAt: null,
  aiConsentGranted: true,
  coachUseAuthorized: false,
  pendingCleanup: false,
  shares: [],
  revokedShares: [],
  revokedShareHistoryTruncated: false,
};

function accessTransport(state: Record<string, unknown>) {
  const calls: { path: string; method: string; body: unknown; idempotencyKey: unknown }[] = [];
  let current = state;
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    calls.push({
      path: input.path,
      method: input.method,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    });
    if (input.path === `/bff/v1/resources/${resourceId}/access`)
      return transportReplySchema.parse({ status: 200, body: current, traceId: null });
    if (input.path === `/bff/v1/resources/${resourceId}/reviewed`) {
      current = {
        ...current,
        reviewedState: 'reviewed',
        reviewedAt: createdAt,
        reviewedVersionId: versionId,
        accessRevision: 2,
      };
      return transportReplySchema.parse({ status: 200, body: current, traceId: null });
    }
    if (input.path === `/bff/v1/resources/${resourceId}/coach-use`)
      return transportReplySchema.parse({
        status: 409,
        body: { error: { code: 'COACH_USE_REVIEW_REQUIRED' } },
        traceId: null,
      });
    if (input.path === `/bff/v1/resources/${resourceId}/shares`) {
      current = {
        ...current,
        accessRevision: 3,
        revokedShares: [],
        revokedShareHistoryTruncated: false,
        shares: [
          {
            schemaVersion: 1,
            shareId: '60000000-0000-4000-8000-000000000001',
            resourceId,
            granteeKind: 'coach',
            granteePrincipalId: 'coach-1',
            state: 'active',
            grantedAccessRevision: 3,
            revokedAccessRevision: null,
            grantedAt: createdAt,
            revokedAt: null,
          },
        ],
      };
      return transportReplySchema.parse({ status: 200, body: current, traceId: null });
    }
    if (input.path === `/bff/v1/resources/${resourceId}`)
      return transportReplySchema.parse({ status: 200, body: read, traceId: null });
    if (input.path.startsWith('/bff/v1/resources?'))
      return transportReplySchema.parse({
        status: 200,
        body: { items: [resource], total: 1 },
        traceId: null,
      });
    return transportReplySchema.parse({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
      traceId: null,
    });
  });
  return { request, calls };
}

it('keeps review, coach use and explicit sharing as separate access commands', async () => {
  const user = userEvent.setup();
  const transport = accessTransport(accessState);
  render(
    <ResourceWorkspace
      athleteId="owner"
      sessionId="owner-session"
      transport={{ request: transport.request }}
      resourceId={resourceId}
    />,
  );

  const panel = await screen.findByRole('region', { name: '접근·검토·코치 사용' });
  expect(within(panel).getByText(/접근 revision 1 · 코치 사용 안 함/)).toBeTruthy();

  await user.click(within(panel).getByRole('button', { name: '검토됨으로 표시' }));
  await within(panel).findByRole('button', { name: '검토 표시 해제' });
  expect(within(panel).getByText(/접근 revision 2 · 검토됨 · 코치 사용 안 함/)).toBeTruthy();

  // The review command never carries a coach-use flag.
  const reviewed = transport.calls.find((call) =>
    call.path.endsWith(`/resources/${resourceId}/reviewed`),
  );
  expect(reviewed?.body).toEqual({
    reviewed: true,
    expectedAccessRevision: 1,
    expectedCurrentVersionId: versionId,
  });
  expect(reviewed?.idempotencyKey).toEqual(expect.any(String));

  await user.type(within(panel).getByLabelText('코치 계정 식별자'), 'coach-1');
  await user.click(within(panel).getByRole('button', { name: '코치에게 공유' }));
  await within(panel).findByRole('button', { name: '공유 철회' });
  // Sharing is its own command and does not enable coach use.
  expect(within(panel).getByText(/접근 revision 3 · 검토됨 · 코치 사용 안 함/)).toBeTruthy();
  expect(
    transport.calls.find((call) => call.path.endsWith(`/resources/${resourceId}/shares`))?.body,
  ).toEqual({ granteeKind: 'coach', granteePrincipalId: 'coach-1', expectedAccessRevision: 2 });

  await user.click(within(panel).getByRole('button', { name: '코치 사용 허용' }));
  expect(
    await within(panel).findByText('먼저 검토됨으로 표시해야 코치 사용을 켤 수 있습니다.'),
  ).toBeTruthy();
});

it('disables coach use when AI consent is missing and reports pending derived cleanup', async () => {
  const transport = accessTransport({
    ...accessState,
    reviewedState: 'reviewed',
    reviewedAt: createdAt,
    reviewedVersionId: versionId,
    aiConsentGranted: false,
    pendingCleanup: true,
  });
  render(
    <ResourceWorkspace
      athleteId="owner"
      sessionId="owner-session"
      transport={{ request: transport.request }}
      resourceId={resourceId}
    />,
  );

  const panel = await screen.findByRole('region', { name: '접근·검토·코치 사용' });
  expect(
    within(panel).getByRole('button', { name: '코치 사용 허용' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(
    within(panel).getByText(/파생 데이터·검색 색인·cache·인용 삭제가 진행 중입니다/),
  ).toBeTruthy();
});

it('tells the owner a replaced body needs its own review before coach use', async () => {
  const transport = accessTransport({
    ...accessState,
    accessRevision: 5,
    reviewedState: 'reviewed',
    reviewedAt: createdAt,
    // The review is pinned to the previous version, so the current body is
    // unreviewed content and the gate reports it as unauthorized.
    reviewedVersionId: '99999999-9999-4999-8999-999999999999',
    includeForCoach: true,
    coachUseEnabledAt: createdAt,
    coachUseAuthorized: false,
  });
  render(
    <ResourceWorkspace
      athleteId="owner"
      sessionId="owner-session"
      transport={{ request: transport.request }}
      resourceId={resourceId}
    />,
  );
  const panel = await screen.findByRole('region', { name: '접근·검토·코치 사용' });
  expect(
    within(panel).getByText(
      /현재 버전을 다시 검토해 표시하기 전까지 코치가 이 자료를 사용하지 않습니다/,
    ),
  ).toBeTruthy();
  // Coach use cannot be re-enabled while the review is stale, and the
  // re-review is reachable even though coach use is still on.
  const reReview = within(panel).getByRole('button', { name: '현재 버전 검토됨으로 표시' });
  expect(reReview.hasAttribute('disabled')).toBe(false);
  await userEvent.setup().click(reReview);
  await waitFor(() =>
    expect(
      transport.calls.some(
        (call) =>
          call.path === `/bff/v1/resources/${resourceId}/reviewed` &&
          typeof call.body === 'object' &&
          call.body !== null &&
          (call.body as { reviewed?: unknown }).reviewed === true,
      ),
    ).toBe(true),
  );
});

it('blocks review withdrawal until coach use is explicitly stopped', async () => {
  const transport = accessTransport({
    ...accessState,
    accessRevision: 4,
    reviewedState: 'reviewed',
    reviewedAt: createdAt,
    reviewedVersionId: versionId,
    includeForCoach: true,
    coachUseEnabledAt: createdAt,
    coachUseAuthorized: true,
  });
  render(
    <ResourceWorkspace
      athleteId="owner"
      sessionId="owner-session"
      transport={{ request: transport.request }}
      resourceId={resourceId}
    />,
  );

  const panel = await screen.findByRole('region', { name: '접근·검토·코치 사용' });
  expect(within(panel).getByText(/접근 revision 4 · 검토됨 · 코치 사용 함/)).toBeTruthy();
  expect(
    within(panel).getByRole('button', { name: '검토 표시 해제' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(
    within(panel).getByText('검토 표시를 해제하려면 먼저 코치 사용을 중지하세요.'),
  ).toBeTruthy();
  expect(within(panel).getByRole('button', { name: '코치 사용 중지' })).toBeTruthy();
});

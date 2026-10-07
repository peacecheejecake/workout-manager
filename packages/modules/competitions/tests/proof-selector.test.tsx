import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { transportReplySchema, type TransportRequest } from '@workout/contracts/core';
import { raceResultAttachmentReadSchema } from '@workout/contracts/race-result-v2';
import { RaceRequestError } from '../src/race-api';
import { createCompetitionsProofApi } from '../src/competitions-proof-api';
import { ProofSelector, selectedProofRefs, type ProofChoice } from '../src/proof-selector';
const firstId = 'abcdefab-1234-4123-8123-123456789abc';
const pdfId = 'bbcdefab-1234-4123-8123-123456789abc';
const versionId = 'cbcdefab-1234-4123-8123-123456789abc';
const createdAt = '2026-10-07T00:00:00.000Z';
const image = (id = firstId) => ({
  id,
  mediaKind: 'image',
  visibility: 'private',
  includeForCoach: false,
  album: null,
  caption: null,
  activityId: null,
  capturedAt: null,
  capturedLocalDate: null,
  file: {
    originalFileName: `finish-${id.slice(0, 2)}.png`,
    mediaType: 'image/png',
    byteSize: 10,
    sha256: 'a'.repeat(64),
  },
  preview: null,
  accessRevision: 2,
  createdAt,
  updatedAt: createdAt,
});
const lifecycle = { contentStatus: 'raw_stored', indexStatus: 'not_indexed' };
const file = {
  originalFileName: 'result.pdf',
  extension: 'pdf',
  mediaType: 'application/pdf',
  byteSize: 20,
  sha256: 'b'.repeat(64),
};
const resource = {
  schemaVersion: 1,
  id: pdfId,
  sourceKind: 'file',
  title: '대회 PDF',
  category: 'race_material',
  metadata: {},
  tags: [],
  visibility: 'private',
  favorite: false,
  includeForCoach: false,
  reviewedState: 'unreviewed',
  lifecycle,
  accessRevision: 3,
  currentVersionId: versionId,
  deletedAt: null,
  createdAt,
  updatedAt: createdAt,
};
const pdf = {
  status: 'available',
  resource,
  version: {
    schemaVersion: 1,
    id: versionId,
    resourceId: pdfId,
    version: 1,
    previousVersionId: null,
    contentHash: file.sha256,
    source: { kind: 'file', file },
    lifecycle,
    createdAt,
  },
  reader: {
    resourceId: pdfId,
    resourceVersionId: versionId,
    title: resource.title,
    sourceKind: 'file',
    lifecycle,
    file,
  },
};
afterEach(cleanup);
function setup(
  handler: (request: TransportRequest) => unknown,
  initial: readonly ProofChoice[] = [],
) {
  const calls: TransportRequest[] = [];
  const api = createCompetitionsProofApi({
    request: async (request) => {
      calls.push(request);
      return transportReplySchema.parse({ status: 200, traceId: null, body: handler(request) });
    },
  });
  let selected: readonly ProofChoice[] = initial;
  function Controlled() {
    const [choices, setChoices] = useState(initial);
    return (
      <ProofSelector
        api={api}
        scope={['actor', 'session']}
        choices={choices}
        onChange={(next) => {
          selected = next;
          setChoices(next);
        }}
      />
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <Controlled />
    </QueryClientProvider>,
  );
  return { calls, selected: () => selected, ...view };
}
function reply(request: TransportRequest) {
  if (request.path.startsWith('/bff/v1/gallery/media?')) return { items: [image()], total: 1 };
  if (request.path.startsWith('/bff/v1/resources?')) return { items: [resource], total: 1 };
  if (request.path.startsWith('/bff/v1/gallery/media/'))
    return { status: 'available', item: image() };
  return pdf;
}
it('selects exact image and PDF reads, retaining only client expected refs', async () => {
  const fixture = setup(reply);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '이미지 선택 · finish-ab.png' }));
  await user.click(await screen.findByRole('button', { name: 'PDF 정확 버전 선택 · 대회 PDF' }));
  expect(selectedProofRefs(fixture.selected())).toEqual([
    { kind: 'gallery-image', mediaItemId: firstId, expectedAccessRevision: 2 },
    { kind: 'resource-pdf', resourceId: pdfId, versionId, expectedAccessRevision: 3 },
  ]);
  expect(fixture.calls.map((call) => call.path)).toContain(
    `/bff/v1/resources/${pdfId}?versionId=${versionId}`,
  );
  expect(screen.getByRole('button', { name: '이미지 선택 · finish-ab.png' })).toBeDisabled();
  expect(screen.getByRole('link', { name: '갤러리에서 이미지 업로드' })).toHaveAttribute(
    'href',
    '/gallery',
  );
  expect(screen.getByRole('link', { name: '자료실에서 PDF 업로드' })).toHaveAttribute(
    'href',
    '/resources',
  );
  expect(JSON.stringify(fixture.selected())).not.toContain('sha256');
});
it('does not silently drop unavailable retained proof or substitute latest PDF version', async () => {
  const initial: ProofChoice[] = [
    {
      state: 'retained',
      attachment: { kind: 'resource-pdf', resourceId: pdfId, versionId, status: 'unavailable' },
    },
  ];
  const fixture = setup(
    (request) =>
      request.path.includes('?versionId=') ? { status: 'unavailable' } : reply(request),
    initial,
  );
  expect(() => selectedProofRefs(initial)).toThrow('PROOF_CONFIRMATION_REQUIRED');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '정확 버전 재확인 1' }));
  await screen.findByRole('alert');
  expect(fixture.selected()).toEqual(initial);
  expect(fixture.calls.map((call) => call.path)).toContain(
    `/bff/v1/resources/${pdfId}?versionId=${versionId}`,
  );
  expect(screen.queryByText(file.originalFileName)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '증빙 연결 해제 1' }));
  expect(selectedProofRefs(fixture.selected())).toEqual([]);
});
it('limits selections to four and supports explicit unlink with keyboard', async () => {
  const refs: ProofChoice[] = Array.from({ length: 4 }, (_, i) => ({
    state: 'selected',
    ref: {
      kind: 'gallery-image',
      mediaItemId: `${i + 1}0000000-0000-4000-8000-000000000001`,
      expectedAccessRevision: 1,
    },
    label: `image${i}`,
  }));
  const fixture = setup(reply, refs);
  const user = userEvent.setup();
  expect(await screen.findByRole('button', { name: '이미지 선택 · finish-ab.png' })).toBeDisabled();
  const unlink = screen.getByRole('button', { name: '증빙 연결 해제 1' });
  unlink.focus();
  await user.keyboard('{Enter}');
  expect(fixture.selected()).toHaveLength(3);
  expect(screen.getByRole('button', { name: '이미지 선택 · finish-ab.png' })).toBeEnabled();
});
it('exposes list failure without replacing chosen refs and refreshes public pages', async () => {
  let fail = true;
  const fixture = setup((request) => {
    if (fail) throw new Error('offline');
    return reply(request);
  });
  await screen.findByRole('alert');
  fail = false;
  await userEvent.setup().click(screen.getByRole('button', { name: '증빙 목록 새로고침' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '이미지 선택 · finish-ab.png' })).toBeEnabled(),
  );
  expect(fixture.selected()).toEqual([]);
});
it('aborts exact descriptor reads when the private selector lifetime ends', async () => {
  let release: ((body: unknown) => void) | undefined;
  const response = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const calls: TransportRequest[] = [];
  const api = createCompetitionsProofApi({
    request: async (request) => {
      calls.push(request);
      const body = request.path.startsWith('/bff/v1/gallery/media/')
        ? await response
        : reply(request);
      return transportReplySchema.parse({ status: 200, body, traceId: null });
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const changed = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <ProofSelector api={api} scope={['actor', 'session']} choices={[]} onChange={changed} />
    </QueryClientProvider>,
  );
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: '이미지 선택 · finish-ab.png' }));
  const exact = calls.find((call) => call.path === `/bff/v1/gallery/media/${firstId}`);
  view.unmount();
  expect(exact?.signal?.aborted).toBe(true);
  release?.({ status: 'available', item: image() });
  await waitFor(() => expect(changed).not.toHaveBeenCalled());
});

it('refreshes an available retained image descriptor into only exact write identity and current access revision', async () => {
  const initial: ProofChoice[] = [
    {
      state: 'retained',
      attachment: raceResultAttachmentReadSchema.parse({
        kind: 'gallery-image',
        mediaItemId: firstId,
        status: 'available',
        accessRevision: 1,
        mediaType: 'image/png',
        byteSize: 10,
        sha256: 'a'.repeat(64),
      }),
    },
  ];
  const fixture = setup(reply, initial);
  await userEvent.setup().click(screen.getByRole('button', { name: '정확 버전 재확인 1' }));
  await waitFor(() =>
    expect(fixture.selected()).toEqual([
      {
        state: 'selected',
        ref: { kind: 'gallery-image', mediaItemId: firstId, expectedAccessRevision: 2 },
        label: 'finish-ab.png',
      },
    ]),
  );
  expect(selectedProofRefs(fixture.selected())).toEqual([
    { kind: 'gallery-image', mediaItemId: firstId, expectedAccessRevision: 2 },
  ]);
  expect(screen.queryByRole('button', { name: '정확 버전 재확인 1' })).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(JSON.stringify(fixture.selected())).not.toContain('sha256');
});
it('refreshes a full retained PDF descriptor without substituting the latest version or copying readonly fields', async () => {
  const initial: ProofChoice[] = [
    {
      state: 'retained',
      attachment: raceResultAttachmentReadSchema.parse({
        kind: 'resource-pdf',
        resourceId: pdfId,
        versionId,
        status: 'available',
        accessRevision: 1,
        mediaType: 'application/pdf',
        byteSize: 20,
        contentHash: 'b'.repeat(64),
      }),
    },
  ];
  const latestVersionId = 'dbcdefab-1234-4123-8123-123456789abc';
  const fixture = setup(
    (request) =>
      request.path.includes('?versionId=')
        ? { ...pdf, resource: { ...resource, currentVersionId: latestVersionId } }
        : reply(request),
    initial,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: '정확 버전 재확인 1' }));
  await waitFor(() =>
    expect(fixture.selected()).toEqual([
      {
        state: 'selected',
        ref: { kind: 'resource-pdf', resourceId: pdfId, versionId, expectedAccessRevision: 3 },
        label: '대회 PDF',
      },
    ]),
  );
  expect(selectedProofRefs(fixture.selected())).toEqual([
    { kind: 'resource-pdf', resourceId: pdfId, versionId, expectedAccessRevision: 3 },
  ]);
  expect(
    fixture.calls.filter((call) => call.path.includes('?versionId=')).map((call) => call.path),
  ).toEqual([`/bff/v1/resources/${pdfId}?versionId=${versionId}`]);
  expect(JSON.stringify(fixture.selected())).not.toContain('contentHash');
  expect(JSON.stringify(fixture.selected())).not.toContain(latestVersionId);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('keeps retained choices when exact refresh reports an access revision conflict', async () => {
  const initial: ProofChoice[] = [
    {
      state: 'retained',
      attachment: { kind: 'resource-pdf', resourceId: pdfId, versionId, status: 'unavailable' },
    },
  ];
  const fixture = setup((request) => {
    if (request.path.includes('?versionId='))
      throw new RaceRequestError(409, 'STALE_RESOURCE_ACCESS');
    return reply(request);
  }, initial);
  await userEvent.setup().click(screen.getByRole('button', { name: '정확 버전 재확인 1' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('증빙 접근 버전이 변경되었습니다');
  expect(fixture.selected()).toEqual(initial);
  expect(() => selectedProofRefs(fixture.selected())).toThrow('PROOF_CONFIRMATION_REQUIRED');
});

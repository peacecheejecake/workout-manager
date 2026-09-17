import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { focusManager } from '@tanstack/react-query';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import type { Activity, ActivityImport } from '@workout/contracts/activity';
import { activityDetailLimits, activityDetailsSchema } from '@workout/contracts/activity-details';
import { ImportWorkspace } from '../src/import-workspace.js';

const original = {
  title: 'Imported run',
  kind: 'running' as const,
  startedAt: null,
  durationSeconds: null,
  durationKind: 'unknown' as const,
  timezone: null,
  distanceMeters: 0,
};
const source = {
  kind: 'fixture' as const,
  sourceId: 'source-one',
  revision: 1,
  contentHash: 'a'.repeat(64),
};
const activity: Activity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: 1,
  source,
  original,
  overlay: {},
  effective: original,
};
const command: ActivityImport = { idempotencyKey: 'fixture-import-1', source, activity: original };
const empty = { value: null, knownCount: 0 };
const summary = {
  count: 1,
  distanceMeters: { value: 0, knownCount: 1 },
  durationSeconds: {
    ...empty,
    byKind: { timer: empty, elapsed: empty, moving: empty, unknown: empty },
  },
};
function reply(body: unknown, status = 200) {
  return { status, traceId: null, body: z.json().parse(body) };
}
function file(name: string, commands: ActivityImport[], schemaVersion = 1) {
  const result = new File(['fixture'], name, { type: 'application/json' });
  Object.defineProperty(result, 'text', {
    value: async () => JSON.stringify({ schemaVersion, imports: commands }),
  });
  return result;
}
function view(request: AuthenticatedTransport['request']) {
  render(<ImportWorkspace athleteId="athlete-a" sessionId="session-a" transport={{ request }} />);
}
function read(request: TransportRequest, current = activity) {
  return request.path.endsWith('/summary') ? reply(summary) : reply({ total: 1, items: [current] });
}

it('ignores an older asynchronous file read after selecting a newer file', async () => {
  let resolveOld: ((text: string) => void) | undefined;
  const pending = new Promise<string>((resolve) => {
    resolveOld = resolve;
  });
  const old = new File(['old'], 'old.json', { type: 'application/json' });
  Object.defineProperty(old, 'text', { value: () => pending });
  view(async (request) => read(request));
  const control = screen.getByLabelText('가져올 활동 JSON');
  await userEvent.upload(control, old);
  await userEvent.upload(
    control,
    file('new.json', [{ ...command, activity: { ...original, title: 'New preview' } }]),
  );
  await screen.findByText(/New preview/);
  await act(async () => {
    resolveOld?.(
      JSON.stringify({
        schemaVersion: 1,
        imports: [{ ...command, activity: { ...original, title: 'Old preview' } }],
      }),
    );
    await pending;
  });
  expect(screen.queryByText(/Old preview/)).not.toBeInTheDocument();
  expect(screen.getByText(/New preview/)).toBeVisible();
});
it('refreshes committed rows after a partial upload failure and retries the original idempotency keys', async () => {
  const keys: (string | null)[] = [];
  let imports = 0;
  let reads = 0;
  view(async (request) => {
    if (request.method === 'POST') {
      keys.push(request.idempotencyKey);
      imports += 1;
      return imports === 2
        ? reply(null, 503)
        : reply({ outcome: 'imported', activityId: activity.id, revision: 1 });
    }
    if (!request.path.endsWith('/summary')) reads += 1;
    return read(request);
  });
  await userEvent.upload(
    screen.getByLabelText('가져올 활동 JSON'),
    file('sessions.json', [command, { ...command, idempotencyKey: 'fixture-import-2' }]),
  );
  await userEvent.click(await screen.findByRole('button', { name: '확인하고 가져오기' }));
  await screen.findByRole('alert');
  expect(reads).toBeGreaterThan(1);
  await userEvent.click(screen.getByRole('button', { name: '확인하고 가져오기' }));
  await waitFor(() => expect(keys).toHaveLength(4));
  expect(keys).toEqual([
    'fixture-import-1',
    'fixture-import-2',
    'fixture-import-1',
    'fixture-import-2',
  ]);
});
it('refreshes a conflicting revision without discarding the correction draft', async () => {
  let revision = 1;
  view(async (request) => {
    if (request.method === 'PATCH') {
      revision = 2;
      return reply(null, 409);
    }
    return read(request, { ...activity, revision });
  });
  await userEvent.click(await screen.findByRole('button', { name: 'Imported run' }));
  await userEvent.clear(screen.getByLabelText('정정 제목'));
  await userEvent.type(screen.getByLabelText('정정 제목'), 'My preserved draft');
  await userEvent.type(screen.getByLabelText('정정 사유'), 'Sensor correction');
  await userEvent.click(screen.getByRole('button', { name: '정정 저장' }));
  await screen.findByRole('button', { name: '최신 revision으로 재검토' });
  expect(screen.getByLabelText('정정 제목')).toHaveValue('My preserved draft');
  expect(screen.getByLabelText('정정 사유')).toHaveValue('Sensor correction');
  expect(screen.getByRole('button', { name: '정정 저장' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '최신 revision으로 재검토' }));
  expect(screen.getByRole('button', { name: '정정 저장' })).toBeEnabled();
});
it('locks edits during a pending correction and retries an uncertain command unchanged', async () => {
  let resolvePatch: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    resolvePatch = resolve;
  });
  const commands: TransportRequest[] = [];
  view(async (request) => {
    if (request.method === 'PATCH') {
      commands.push(request);
      await pending;
      return reply(null, 503);
    }
    return read(request);
  });
  await userEvent.click(await screen.findByRole('button', { name: 'Imported run' }));
  await userEvent.type(screen.getByLabelText('정정 사유'), 'Sensor correction');
  await userEvent.click(screen.getByRole('button', { name: '정정 저장' }));
  expect(screen.getByLabelText('정정 제목')).toBeDisabled();
  expect(screen.getByRole('button', { name: '로컬 삭제' })).toBeDisabled();
  await act(async () => {
    resolvePatch?.();
    await pending;
  });
  await screen.findByRole('alert');
  await userEvent.click(screen.getByRole('button', { name: '정정 저장' }));
  await waitFor(() => expect(commands).toHaveLength(2));
  expect(commands[0]?.idempotencyKey).toBe(commands[1]?.idempotencyKey);
  expect(commands[0]?.body).toEqual(commands[1]?.body);
});
it('shows a retryable summary error instead of inventing a zero total', async () => {
  const request = vi.fn(async (input: TransportRequest) =>
    input.path.endsWith('/summary') ? reply(null, 503) : reply({ items: [], total: 0 }),
  );
  view(request);
  await screen.findByText('활동 집계를 확인하지 못했습니다.');
  expect(screen.queryByText(/알려진 거리 합계/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '집계 다시 확인' }));
  await waitFor(() =>
    expect(request.mock.calls.filter(([input]) => input.path.endsWith('/summary')).length).toBe(2),
  );
});

it('never silently advances a delete confirmation after refetch or conflict', async () => {
  let revision = 1;
  const attempts: unknown[] = [];
  view(async (request) => {
    if (request.method === 'DELETE') {
      attempts.push(request.body);
      revision = 3;
      return reply(null, 409);
    }
    return read(request, { ...activity, revision });
  });
  await userEvent.click(await screen.findByRole('button', { name: 'Imported run' }));
  await userEvent.click(screen.getByRole('button', { name: '로컬 삭제' }));
  expect(screen.getByText('삭제 확인 revision: 1')).toBeVisible();
  revision = 2;
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: '삭제 확인' })).toBeDisabled());
  expect(screen.getByText('삭제 확인 revision: 1')).toBeVisible();
  expect(attempts).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: '취소' }));
  await userEvent.click(screen.getByRole('button', { name: '로컬 삭제' }));
  expect(screen.getByText('삭제 확인 revision: 2')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '삭제 확인' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: '삭제 확인' })).not.toBeInTheDocument(),
  );
  expect(attempts).toEqual([{ expectedRevision: 2 }]);
  await waitFor(() => expect(screen.getByRole('button', { name: '로컬 삭제' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: '로컬 삭제' }));
  expect(screen.getByText('삭제 확인 revision: 3')).toBeVisible();
  focusManager.setFocused(undefined);
});

const details = activityDetailsSchema.parse({
  schemaVersion: 1,
  streamIndex: 0,
  sessionIndex: 0,
  startedAt: null,
  recordedAt: null,
  elapsedSeconds: null,
  records: [
    { index: 0, timestamp: null, distanceMeters: 0, heartRateBpm: 0 },
    { index: 1, timestamp: '2023-01-01T00:00:01Z', distanceMeters: null, heartRateBpm: null },
  ],
  laps: [
    {
      index: 0,
      startedAt: null,
      recordedAt: null,
      elapsedSeconds: null,
      timerSeconds: 0,
      distanceMeters: null,
      averageHeartRateBpm: 0,
      maximumHeartRateBpm: null,
    },
  ],
});

it('previews v2 records and missing signals without counting zero as missing or posting before confirmation', async () => {
  const writes: TransportRequest[] = [];
  view(async (request) => {
    if (request.method === 'POST') {
      writes.push(request);
      return reply({ outcome: 'imported', activityId: activity.id, revision: 1 });
    }
    return read(request);
  });
  await userEvent.upload(
    screen.getByLabelText('가져올 활동 JSON'),
    file('details.json', [{ ...command, details }], 2),
  );
  expect(await screen.findByText('세부 기록: 레코드 2개 · 랩 1개')).toBeVisible();
  expect(screen.getByText('레코드 미확인: 시각 1개 · 거리 1개 · 심박수 1개')).toBeVisible();
  expect(
    screen.getByText(/랩 미확인: 시작 시각 1개 · 경과 시간 1개 · 타이머 시간 0개/),
  ).toBeVisible();
  expect(screen.getByText('가져오기 미리보기: 1개 세션')).toBeVisible();
  expect(writes).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: '확인하고 가져오기' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.body).toEqual({ source, activity: original, details });
  expect(writes[0]?.idempotencyKey).toBe(command.idempotencyKey);
});

it('uses the shared export versions instead of accepting details under v1 or omitting them under v2', async () => {
  view(async (request) => read(request));
  const control = screen.getByLabelText('가져올 활동 JSON');
  await userEvent.upload(control, file('legacy-details.json', [{ ...command, details }], 1));
  expect(await screen.findByRole('alert')).toHaveTextContent('지원하는 활동 JSON 파일이 아닙니다.');
  expect(screen.queryByRole('button', { name: '확인하고 가져오기' })).not.toBeInTheDocument();
  await userEvent.upload(control, file('missing-details.json', [command], 2));
  expect(await screen.findByRole('alert')).toHaveTextContent('지원하는 활동 JSON 파일이 아닙니다.');
  await userEvent.upload(control, file('legacy.json', [command]));
  expect(await screen.findByText('세부 기록 없음 · 요약만 제공된 활동입니다.')).toBeVisible();
});

it('accepts a valid file above the previous limit and rejects files above 16 MiB before reading', async () => {
  view(async (request) => read(request));
  const accepted = file('large.json', [{ ...command, details }], 2);
  Object.defineProperty(accepted, 'size', { value: 2 * 1024 * 1024 });
  await userEvent.upload(screen.getByLabelText('가져올 활동 JSON'), accepted);
  await screen.findByRole('button', { name: '확인하고 가져오기' });
  const oversized = new File(['synthetic'], 'oversized.json', { type: 'application/json' });
  const readFile = vi.fn(async () => '{}');
  Object.defineProperty(oversized, 'size', { value: activityDetailLimits.importFileBytes + 1 });
  Object.defineProperty(oversized, 'text', { value: readFile });
  await userEvent.upload(screen.getByLabelText('가져올 활동 JSON'), oversized);
  expect(await screen.findByRole('alert')).toHaveTextContent('파일은 16 MiB 이하여야 합니다.');
  expect(readFile).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '확인하고 가져오기' })).not.toBeInTheDocument();
});

it('drops a pending detailed file read when the authenticated account lifetime changes', async () => {
  let resolveFile: ((text: string) => void) | undefined;
  const pending = new Promise<string>((resolve) => {
    resolveFile = resolve;
  });
  const selected = new File(['synthetic'], 'delayed.json', { type: 'application/json' });
  Object.defineProperty(selected, 'text', { value: () => pending });
  const request = vi.fn(async (input: TransportRequest) => read(input));
  const { rerender } = render(
    <ImportWorkspace athleteId="athlete-a" sessionId="session-a" transport={{ request }} />,
  );
  await userEvent.upload(screen.getByLabelText('가져올 활동 JSON'), selected);
  rerender(<ImportWorkspace athleteId="athlete-b" sessionId="session-b" transport={{ request }} />);
  await act(async () => {
    resolveFile?.(JSON.stringify({ schemaVersion: 2, imports: [{ ...command, details }] }));
    await pending;
  });
  expect(screen.queryByRole('button', { name: '확인하고 가져오기' })).not.toBeInTheDocument();
  expect(screen.queryByText('세부 기록: 레코드 2개 · 랩 1개')).not.toBeInTheDocument();
  expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
});

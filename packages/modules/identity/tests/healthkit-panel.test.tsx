import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { HealthKitPanel, type HealthKitPanelProps } from '../src/healthkit-panel';

const account = { athleteId: 'athlete-one', scopeId: 'native-login-one' };
const capabilities = {
  'app.openSettings': true,
  'healthkit.read': false,
  'healthkit.workouts': true,
  'auth.transport': true,
} as const;
const consent = (granted: boolean, revision: number) => ({
  kind: 'healthkit' as const,
  granted,
  revision,
});
const reply = (body: ReturnType<typeof consent> | null, status = 200) => ({
  status,
  body,
  traceId: null,
});

function setup(
  read: AuthenticatedTransport['request'] = async () => reply(consent(false, 0)),
  overrides: Partial<NonNullable<HealthKitPanelProps['bridge']>> = {},
) {
  const transport = { request: vi.fn(read) } satisfies AuthenticatedTransport;
  const bridge = {
    getCapabilities: vi.fn(() => capabilities),
    writeHealthKitConsent: vi.fn(async () => ({
      ok: true as const,
      value: { status: 200 as const, body: consent(true, 1) },
    })),
    requestHealthKitWorkoutAccess: vi.fn(async () => ({
      ok: true as const,
      value: 'requested' as const,
    })),
    healthKitWorkoutStatus: vi.fn(async () => ({
      ok: true as const,
      value: { requestState: 'not_requested' as const, pendingCount: 0, pauseReason: null },
    })),
    selectHealthKitWorkouts: vi.fn(async () => ({
      ok: true as const,
      value: { status: 'opened' as const, selectionId: '11111111-1111-4111-8111-111111111111' },
    })),
    healthKitWorkoutSelectionStatus: vi.fn(async () => ({
      ok: true as const,
      value: { state: 'idle' as const, registeredCount: null, selectedCount: 0, resultCount: null },
    })),
    cancelHealthKitWorkoutSelection: vi.fn(async () => ({
      ok: true as const,
      value: 'cancelled' as const,
    })),
    ...overrides,
  } satisfies NonNullable<HealthKitPanelProps['bridge']>;
  const onUnauthorized = vi.fn();
  const props = { transport, bridge, account, onUnauthorized };
  const tree = (next: HealthKitPanelProps) => (
    <StrictMode>
      <HealthKitPanel {...next} />
    </StrictMode>
  );
  return { ...render(tree(props)), transport, bridge, onUnauthorized, props, tree };
}

afterEach(() => vi.clearAllMocks());

describe('HealthKit account panel', () => {
  it('shows the native companion boundary in a browser without reading consent', () => {
    render(<HealthKitPanel account={account} />);
    expect(screen.getByText(/iPhone 앱에서 사용할 수 있습니다/)).toBeVisible();
    expect(screen.getByText(/웹의 Apple 로그인만으로/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'HealthKit 운동 동의' })).not.toBeInTheDocument();
  });

  it('keeps server consent separate from OS request and never declares read permission', async () => {
    const user = userEvent.setup();
    let current = consent(false, 0);
    const { bridge, transport } = setup(async () => reply(current), {
      writeHealthKitConsent: vi.fn<
        NonNullable<HealthKitPanelProps['bridge']>['writeHealthKitConsent']
      >(async (payload) => {
        current = consent(payload.granted, current.revision + 1);
        return { ok: true, value: { status: 200, body: current } };
      }),
    });
    expect(await screen.findByText('앱 동의: 허용되지 않음')).toBeVisible();
    expect(screen.getByRole('button', { name: 'iPhone 운동 읽기 요청' })).toBeDisabled();
    expect(bridge.requestHealthKitWorkoutAccess).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'HealthKit 운동 동의' }));
    expect(await screen.findByText('앱 동의: 허용됨')).toBeVisible();
    expect(bridge.writeHealthKitConsent).toHaveBeenCalledWith(
      expect.objectContaining({ granted: true, expectedRevision: 0 }),
      expect.any(AbortSignal),
    );
    expect(bridge.requestHealthKitWorkoutAccess).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'iPhone 운동 읽기 요청' }));
    expect(
      await screen.findByText(/iPhone은 읽기 허용 여부를 앱에 알려주지 않습니다/),
    ).toBeVisible();
    expect(screen.getByText(/읽기 허용 여부: 알 수 없음/)).toBeVisible();
    expect(screen.queryByText(/읽기 허용됨|읽기 거부됨/)).not.toBeInTheDocument();
    expect(transport.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/bff/v1/consents/healthkit',
        method: 'GET',
        body: null,
        idempotencyKey: null,
      }),
    );
  });

  it('shows pending and paused delivery as partial without claiming there are no samples', async () => {
    setup(async () => reply(consent(true, 4)), {
      healthKitWorkoutStatus: vi.fn<
        NonNullable<HealthKitPanelProps['bridge']>['healthKitWorkoutStatus']
      >(async () => ({
        ok: true,
        value: { requestState: 'requested', pendingCount: 2, pauseReason: 'conflict' },
      })),
    });
    expect(await screen.findByText(/전송 대기 묶음: 2개/)).toBeVisible();
    expect(
      screen.getByText(/일부 운동 변경 내용이 아직 서버에 전달되지 않았을 수 있습니다/),
    ).toBeVisible();
    expect(screen.getByText(/읽기 허용 여부: 알 수 없음/)).toBeVisible();
  });

  it('refreshes the authoritative consent after a revision conflict', async () => {
    const user = userEvent.setup();
    let current = consent(false, 2);
    setup(async () => reply(current), {
      writeHealthKitConsent: vi.fn<
        NonNullable<HealthKitPanelProps['bridge']>['writeHealthKitConsent']
      >(async () => {
        current = consent(true, 3);
        return { ok: true, value: { status: 409, body: null } };
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'HealthKit 운동 동의' }));
    expect(await screen.findByText('앱 동의: 허용됨')).toBeVisible();
    expect(screen.getByText(/동의 상태가 변경되었습니다/)).toBeVisible();
  });

  it('stops on unauthorized and reports it to the account owner', async () => {
    const { onUnauthorized } = setup(async () => reply(null, 401));
    expect(await screen.findByText(/로그인 상태가 바뀌었습니다/)).toBeVisible();
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'HealthKit 운동 동의' })).not.toBeInTheDocument();
  });

  it('discards old account responses and aborts their transport request', async () => {
    const settlements: Array<
      (value: Awaited<ReturnType<AuthenticatedTransport['request']>>) => void
    > = [];
    const read = vi.fn<AuthenticatedTransport['request']>(
      () =>
        new Promise((resolve) => {
          settlements.push(resolve);
        }),
    );
    const { rerender, props, tree } = setup(read);
    await waitFor(() => expect(read).toHaveBeenCalled());
    const previousSignal = read.mock.calls[0]?.[0].signal;
    const oldSettlements = [...settlements];
    rerender(
      tree({ ...props, account: { athleteId: 'athlete-two', scopeId: 'native-login-two' } }),
    );
    expect(previousSignal?.aborted).toBe(true);
    await act(async () => {
      oldSettlements.forEach((settle) => settle(reply(consent(true, 1))));
    });
    expect(screen.queryByText('앱 동의: 허용됨')).not.toBeInTheDocument();
  });
});

const selectionId = '11111111-1111-4111-8111-111111111111';
const selectionCapabilities = { ...capabilities, 'healthkit.workouts.selection': true };
type SelectionBridge = NonNullable<HealthKitPanelProps['bridge']>;
function selectionSetup(overrides: Partial<SelectionBridge> = {}) {
  return setup(async () => reply(consent(true, 1)), {
    getCapabilities: vi.fn(() => selectionCapabilities),
    ...overrides,
  });
}

describe('native workout selection account UI', () => {
  it('shows the current account and unknown counts before an explicit native action', async () => {
    const { bridge } = selectionSetup();
    expect(await screen.findByText('현재 계정: athlete-one')).toBeVisible();
    expect(screen.getByText('현재 계정 등록 운동: 확인되지 않음')).toBeVisible();
    expect(screen.getByText('최근 등록 결과: 확인되지 않음')).toBeVisible();
    expect(screen.getByText(/귀속과 서버 업로드를 별도로 확인합니다/)).toBeVisible();
    expect(bridge.selectHealthKitWorkouts).not.toHaveBeenCalled();
    expect(bridge.healthKitWorkoutSelectionStatus).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '운동 등록 상태 다시 확인' })).toBeDisabled();
  });
  it('omits selection controls on older hosts', async () => {
    setup(async () => reply(consent(true, 1)));
    await screen.findByText('앱 동의: 허용됨');
    expect(screen.queryByRole('button', { name: 'iPhone 운동 선택·등록' })).not.toBeInTheDocument();
  });
  it.each([
    'offline',
    'conflict',
    'refresh_pending',
    'registered',
    'consent_required',
    'unavailable',
  ] as const)(
    'renders native %s without exposing candidate data or claiming read permission',
    async (state) => {
      const user = userEvent.setup();
      const { bridge } = selectionSetup({
        healthKitWorkoutSelectionStatus: vi.fn<SelectionBridge['healthKitWorkoutSelectionStatus']>(
          async () => ({
            ok: true,
            value: {
              state,
              registeredCount: state === 'registered' ? 0 : null,
              selectedCount: 1,
              resultCount: state === 'registered' ? 1 : null,
            },
          }),
        ),
      });
      await user.click(await screen.findByRole('button', { name: 'iPhone 운동 선택·등록' }));
      expect(bridge.healthKitWorkoutSelectionStatus).toHaveBeenCalledWith(
        selectionId,
        expect.any(AbortSignal),
      );
      expect(screen.getByText('선택 운동: 1개')).toBeVisible();
      expect(screen.getByText(/읽기 허용 여부: 알 수 없음/)).toBeVisible();
      expect(screen.queryByText(selectionId)).not.toBeInTheDocument();
      if (state === 'registered') {
        expect(screen.getByText(/등록 0개는 iPhone에 운동이 없다는 뜻이 아닙니다/)).toBeVisible();
        expect(screen.getByText('최근 등록 결과: 1개')).toBeVisible();
      }
    },
  );
  it('cancels only the old opaque screen handle on scope change and ignores stale status', async () => {
    const user = userEvent.setup();
    let settle:
      | ((value: Awaited<ReturnType<SelectionBridge['healthKitWorkoutSelectionStatus']>>) => void)
      | undefined;
    const status = vi.fn<SelectionBridge['healthKitWorkoutSelectionStatus']>(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const { bridge, rerender, props, tree } = selectionSetup({
      healthKitWorkoutSelectionStatus: status,
    });
    await user.click(await screen.findByRole('button', { name: 'iPhone 운동 선택·등록' }));
    await waitFor(() => expect(status).toHaveBeenCalled());
    const signal = status.mock.calls[0]?.[1];
    rerender(
      tree({ ...props, account: { athleteId: 'athlete-two', scopeId: 'native-login-two' } }),
    );
    expect(signal?.aborted).toBe(true);
    expect(bridge.cancelHealthKitWorkoutSelection).toHaveBeenCalledWith(selectionId);
    await act(async () =>
      settle?.({
        ok: true,
        value: { state: 'registered', registeredCount: 1, selectedCount: 1, resultCount: 1 },
      }),
    );
    expect(await screen.findByText('현재 계정: athlete-two')).toBeVisible();
    expect(screen.queryByText('최근 등록 결과: 1개')).not.toBeInTheDocument();
  });
  it('rejects a leaking status even from a custom bridge mock and allows retry', async () => {
    const user = userEvent.setup();
    const status = vi
      .fn<SelectionBridge['healthKitWorkoutSelectionStatus']>()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          state: 'choosing',
          registeredCount: null,
          selectedCount: 0,
          resultCount: null,
          ...{ sampleId: selectionId },
        },
      })
      .mockResolvedValue({
        ok: true,
        value: { state: 'cancelled', registeredCount: null, selectedCount: 0, resultCount: null },
      });
    selectionSetup({ healthKitWorkoutSelectionStatus: status });
    await user.click(await screen.findByRole('button', { name: 'iPhone 운동 선택·등록' }));
    expect(await screen.findByText('운동 등록 상태를 확인하지 못했습니다.')).toBeVisible();
    expect(screen.queryByText(selectionId)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '운동 등록 상태 다시 확인' }));
    expect(await screen.findByText(/운동 선택을 취소했습니다/)).toBeVisible();
  });
  it('cancels on unmount without applying a cancellation response to a replacement panel', async () => {
    const user = userEvent.setup();
    const { bridge, unmount } = selectionSetup({
      healthKitWorkoutSelectionStatus: vi.fn<SelectionBridge['healthKitWorkoutSelectionStatus']>(
        async () => ({
          ok: true,
          value: { state: 'choosing', registeredCount: null, selectedCount: 2, resultCount: null },
        }),
      ),
    });
    await user.click(await screen.findByRole('button', { name: 'iPhone 운동 선택·등록' }));
    expect(await screen.findByText('선택 운동: 2개')).toBeVisible();
    unmount();
    expect(bridge.cancelHealthKitWorkoutSelection).toHaveBeenCalledWith(selectionId);
  });
  it('stops polling after its bound and permits explicit status refresh', async () => {
    const { bridge, unmount } = selectionSetup({
      healthKitWorkoutSelectionStatus: vi.fn<SelectionBridge['healthKitWorkoutSelectionStatus']>(
        async () => ({
          ok: true,
          value: { state: 'choosing', registeredCount: null, selectedCount: 2, resultCount: null },
        }),
      ),
    });
    await screen.findByText('앱 동의: 허용됨');
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'iPhone 운동 선택·등록' }));
    });
    for (let count = 0; count < 30; count++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    expect(screen.getByText(/자동 확인을 멈췄습니다/)).toBeVisible();
    expect(bridge.healthKitWorkoutSelectionStatus).toHaveBeenCalledTimes(31);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(bridge.healthKitWorkoutSelectionStatus).toHaveBeenCalledTimes(31);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '운동 등록 상태 다시 확인' }));
    });
    expect(bridge.healthKitWorkoutSelectionStatus).toHaveBeenCalledTimes(32);
    unmount();
    vi.useRealTimers();
  });
  it('clears registered facts and cancels only the captured handle after committed withdrawal', async () => {
    const user = userEvent.setup();
    let current = consent(true, 1);
    let settle:
      | ((value: Awaited<ReturnType<SelectionBridge['healthKitWorkoutSelectionStatus']>>) => void)
      | undefined;
    const status = vi
      .fn<SelectionBridge['healthKitWorkoutSelectionStatus']>()
      .mockResolvedValueOnce({
        ok: true,
        value: { state: 'registered', registeredCount: 4, selectedCount: 1, resultCount: 1 },
      })
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      );
    const { bridge } = setup(async () => reply(current), {
      getCapabilities: vi.fn(() => selectionCapabilities),
      healthKitWorkoutSelectionStatus: status,
      writeHealthKitConsent: vi.fn<SelectionBridge['writeHealthKitConsent']>(async () => {
        current = consent(false, 2);
        return { ok: true, value: { status: 200, body: current } };
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'iPhone 운동 선택·등록' }));
    expect(await screen.findByText('현재 계정 등록 운동: 4개')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '운동 등록 상태 다시 확인' }));
    const oldSignal = status.mock.calls[1]?.[1];
    await user.click(screen.getByRole('button', { name: 'HealthKit 동의 철회' }));
    expect(await screen.findByText('앱 동의: 허용되지 않음')).toBeVisible();
    expect(oldSignal?.aborted).toBe(true);
    expect(bridge.cancelHealthKitWorkoutSelection).toHaveBeenCalledWith(selectionId);
    expect(screen.getByText('현재 계정 등록 운동: 확인되지 않음')).toBeVisible();
    expect(screen.getByText('최근 등록 결과: 확인되지 않음')).toBeVisible();
    await act(async () =>
      settle?.({
        ok: true,
        value: { state: 'registered', registeredCount: 4, selectedCount: 1, resultCount: 1 },
      }),
    );
    expect(screen.queryByText('현재 계정 등록 운동: 4개')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'iPhone 운동 선택·등록' })).toBeDisabled();
  });
});

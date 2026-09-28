import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
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

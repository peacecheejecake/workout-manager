'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  nativeBridgeHealthKitConsentSchema,
  type NativeBridgeHealthKitStatus,
} from '@workout/contracts/native-bridge';
import type { createNativeBridgeClient } from '@workout/platform/native-bridge-client';
import styles from './healthkit-panel.module.css';

type Bridge = Pick<
  ReturnType<typeof createNativeBridgeClient>,
  | 'getCapabilities'
  | 'writeHealthKitConsent'
  | 'requestHealthKitWorkoutAccess'
  | 'healthKitWorkoutStatus'
>;
type Consent = { granted: boolean; revision: number };
type WorkoutState =
  | { kind: 'ready'; value: NativeBridgeHealthKitStatus }
  | { kind: 'unavailable' }
  | { kind: 'error' };
type PanelState =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'error' }
  | { kind: 'ready'; consent: Consent; workouts: WorkoutState };
type Action = 'refresh' | 'grant' | 'revoke' | 'requestAccess';
const pauseMessages: Record<NonNullable<NativeBridgeHealthKitStatus['pauseReason']>, string> = {
  forbidden: '서버가 전송을 허용하지 않아 동기화가 멈췄습니다.',
  conflict: '서버 자료 충돌로 동기화가 멈췄습니다.',
  rejected: '전송 내용이 거절되어 동기화가 멈췄습니다.',
};

interface AccountScope {
  /** A new scopeId must be supplied after even a same-account native sign-in. */
  account: { athleteId: string; scopeId: string };
  onUnauthorized?(): void;
}
export type HealthKitPanelProps = AccountScope &
  ({ transport?: never; bridge?: never } | { transport: AuthenticatedTransport; bridge: Bridge });

/** Server consent, OS request history, and delivery progress are distinct facts. */
export function HealthKitPanel(props: HealthKitPanelProps) {
  if (!props.bridge) {
    return <HealthKitBrowserPanel />;
  }
  return (
    <HealthKitPanelLifetime
      key={JSON.stringify([props.account.athleteId, props.account.scopeId])}
      {...props}
      bridge={props.bridge}
    />
  );
}

function HealthKitBrowserPanel() {
  const headingId = useId();
  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h2 id={headingId}>Apple 건강</h2>
      <p>HealthKit 운동 연동은 iPhone 앱에서 사용할 수 있습니다.</p>
      <p>웹의 Apple 로그인만으로 운동 데이터에 접근할 수 없습니다.</p>
    </section>
  );
}

function HealthKitPanelLifetime({
  transport,
  bridge,
  onUnauthorized,
}: AccountScope & { transport: AuthenticatedTransport; bridge: Bridge }) {
  const headingId = useId();
  const [state, setState] = useState<PanelState>({ kind: 'loading' });
  const [pending, setPending] = useState<Action | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);

  const begin = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    return controller;
  }, []);
  const isCurrent = useCallback(
    (controller: AbortController) =>
      active.current && request.current === controller && !controller.signal.aborted,
    [],
  );
  const unauthorized = useCallback(() => {
    request.current?.abort();
    setPending(null);
    setNotice(null);
    setState({ kind: 'unauthorized' });
    onUnauthorized?.();
  }, [onUnauthorized]);

  const refresh = useCallback(async () => {
    const controller = begin();
    setPending('refresh');
    setNotice(null);
    setState({ kind: 'loading' });
    try {
      const reply = await transport.request({
        path: '/bff/v1/consents/healthkit',
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal: controller.signal,
      });
      if (!isCurrent(controller)) return;
      if (reply.status === 401) {
        unauthorized();
        return;
      }
      const parsed = nativeBridgeHealthKitConsentSchema.safeParse(reply.body);
      if (reply.status !== 200 || !parsed.success) {
        setState({ kind: 'error' });
        return;
      }

      let workouts: WorkoutState = { kind: 'unavailable' };
      if (bridge?.getCapabilities()?.['healthkit.workouts']) {
        const result = await bridge.healthKitWorkoutStatus(controller.signal);
        if (!isCurrent(controller)) return;
        workouts =
          result.ok && typeof result.value !== 'string'
            ? { kind: 'ready', value: result.value }
            : { kind: 'error' };
      }
      setState({
        kind: 'ready',
        consent: { granted: parsed.data.granted, revision: parsed.data.revision },
        workouts,
      });
    } catch {
      if (isCurrent(controller)) setState({ kind: 'error' });
    } finally {
      if (isCurrent(controller)) setPending(null);
    }
  }, [begin, bridge, isCurrent, transport, unauthorized]);

  useEffect(() => {
    active.current = true;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    return () => {
      cancelled = true;
      active.current = false;
      request.current?.abort();
      request.current = null;
    };
  }, [refresh]);

  async function writeConsent(granted: boolean) {
    if (state.kind !== 'ready' || pending !== null || !bridge) return;
    const controller = begin();
    setPending(granted ? 'grant' : 'revoke');
    setNotice(null);
    try {
      const result = await bridge.writeHealthKitConsent(
        {
          granted,
          expectedRevision: state.consent.revision,
          idempotencyKey: crypto.randomUUID(),
        },
        controller.signal,
      );
      if (!isCurrent(controller)) return;
      if (!result.ok) {
        setNotice('동의 변경 결과를 확인하지 못했습니다. 현재 상태를 다시 확인하세요.');
        return;
      }
      if (result.value.status === 401) {
        unauthorized();
        return;
      }
      if (result.value.status === 409) {
        await refresh();
        if (active.current) setNotice('동의 상태가 변경되었습니다. 다시 확인한 뒤 선택하세요.');
        return;
      }
      // A command receipt may describe an earlier write; reload the current consent head.
      await refresh();
    } catch {
      if (isCurrent(controller)) {
        setNotice('동의 변경 결과를 확인하지 못했습니다. 현재 상태를 다시 확인하세요.');
      }
    } finally {
      if (isCurrent(controller)) setPending(null);
    }
  }

  async function requestAccess() {
    if (
      state.kind !== 'ready' ||
      !state.consent.granted ||
      pending !== null ||
      !bridge?.getCapabilities()?.['healthkit.workouts']
    )
      return;
    const controller = begin();
    setPending('requestAccess');
    setNotice(null);
    try {
      const result = await bridge.requestHealthKitWorkoutAccess(controller.signal);
      if (!isCurrent(controller)) return;
      if (!result.ok || result.value !== 'requested') {
        setNotice('운동 읽기 요청 결과를 확인하지 못했습니다. 상태를 다시 확인하세요.');
        return;
      }
      await refresh();
      if (active.current) {
        setNotice('운동 읽기를 요청했습니다. iPhone은 읽기 허용 여부를 앱에 알려주지 않습니다.');
      }
    } catch {
      if (isCurrent(controller)) {
        setNotice('운동 읽기 요청 결과를 확인하지 못했습니다. 상태를 다시 확인하세요.');
      }
    } finally {
      if (isCurrent(controller)) setPending(null);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby={headingId} aria-busy={pending !== null}>
      <h2 id={headingId}>Apple 건강</h2>
      {state.kind === 'loading' ? <p role="status">HealthKit 상태를 확인하고 있습니다.</p> : null}
      {state.kind === 'unauthorized' ? (
        <p role="alert">로그인 상태가 바뀌었습니다. 다시 로그인해 주세요.</p>
      ) : null}
      {state.kind === 'error' ? (
        <p role="alert">HealthKit 동의 상태를 확인하지 못했습니다.</p>
      ) : null}
      {state.kind === 'ready' ? (
        <>
          <p>앱 동의: {state.consent.granted ? '허용됨' : '허용되지 않음'}</p>
          <p>앱 동의와 iPhone 운동 읽기 요청은 별개입니다.</p>
          <p>iPhone 운동 읽기 허용 여부: 알 수 없음</p>
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void writeConsent(!state.consent.granted)}
          >
            {state.consent.granted ? 'HealthKit 동의 철회' : 'HealthKit 운동 동의'}
          </button>
          {state.workouts.kind === 'unavailable' ? (
            <p>이 기기에서 HealthKit 운동 기능을 사용할 수 없습니다.</p>
          ) : state.workouts.kind === 'error' ? (
            <p role="alert">iPhone 운동 상태를 확인하지 못했습니다.</p>
          ) : (
            <>
              <p>
                운동 읽기 요청:{' '}
                {state.workouts.value.requestState === 'requested' ? '요청함' : '요청 전'}
              </p>
              <p>전송 대기 묶음: {state.workouts.value.pendingCount}개</p>
              {state.workouts.value.pauseReason === null ? null : (
                <p role="alert">{pauseMessages[state.workouts.value.pauseReason]}</p>
              )}
              {state.workouts.value.pendingCount > 0 ? (
                <p>일부 운동 변경 내용이 아직 서버에 전달되지 않았을 수 있습니다.</p>
              ) : (
                <p>대기 묶음 0개는 전송 완료나 접근 가능한 운동이 없다는 뜻이 아닙니다.</p>
              )}
            </>
          )}
          <button
            type="button"
            disabled={
              pending !== null ||
              !state.consent.granted ||
              !bridge.getCapabilities()?.['healthkit.workouts']
            }
            onClick={() => void requestAccess()}
          >
            iPhone 운동 읽기 요청
          </button>
        </>
      ) : null}
      {notice ? <p role="alert">{notice}</p> : null}
      {state.kind !== 'unauthorized' ? (
        <button type="button" disabled={pending !== null} onClick={() => void refresh()}>
          상태 다시 확인
        </button>
      ) : null}
    </section>
  );
}

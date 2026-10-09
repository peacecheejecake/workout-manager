'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  nativeBridgeHealthKitConsentSchema,
  nativeBridgeHealthKitSelectionStatusSchema,
  nativeBridgeHealthKitManagementStatusSchema,
  type NativeBridgeHealthKitManagementStatus,
  type NativeBridgeHealthKitSelectionStatus,
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
  | 'selectHealthKitWorkouts'
  | 'healthKitWorkoutSelectionStatus'
  | 'cancelHealthKitWorkoutSelection'
  | 'manageHealthKitWorkouts'
  | 'healthKitWorkoutManagementStatus'
  | 'cancelHealthKitWorkoutManagement'
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
  account,
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
          <p>현재 계정: {account.athleteId}</p>
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
      {state.kind !== 'unauthorized' &&
      bridge.getCapabilities()?.['healthkit.workouts.selection'] ? (
        <HealthKitSelectionPanel
          key={
            state.kind === 'ready' && !state.consent.granted
              ? 'selection-without-consent'
              : 'selection-with-consent'
          }
          bridge={bridge}
          consentGranted={state.kind === 'ready' ? state.consent.granted : null}
          onUnauthorized={unauthorized}
        />
      ) : null}
      {state.kind !== 'unauthorized' &&
      bridge.getCapabilities()?.['healthkit.workouts.management'] ? (
        <HealthKitManagementPanel
          key={
            state.kind === 'ready' && !state.consent.granted
              ? 'management-without-consent'
              : 'management-with-consent'
          }
          bridge={bridge}
          consentGranted={state.kind === 'ready' ? state.consent.granted : null}
          onUnauthorized={unauthorized}
        />
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

const selectionMessages: Record<NativeBridgeHealthKitSelectionStatus['state'], string> = {
  idle: '등록할 운동을 iPhone 화면에서 선택하세요.',
  loading: 'iPhone에서 운동 후보를 확인하고 있습니다.',
  choosing: 'iPhone 화면에서 운동을 선택하고 있습니다.',
  confirming: '현재 계정 귀속과 서버 업로드 범위를 iPhone에서 확인하세요.',
  registering: '선택한 운동의 서버 등록 결과를 기다리고 있습니다.',
  registered: '선택한 운동의 서버 등록을 확인했습니다.',
  refresh_pending: '서버 등록 후 현재 목록을 확인하지 못해 수집 재개를 기다리고 있습니다.',
  cancelled: '운동 선택을 취소했습니다. 등록 결과는 상태에서 다시 확인하세요.',
  offline: '연결을 확인하지 못했습니다. 온라인에서 다시 확인하세요.',
  conflict: '운동 등록 상태가 변경되었거나 등록이 충돌했습니다. 다시 확인하세요.',
  consent_required: 'HealthKit 동의를 확인한 뒤 운동을 선택하세요.',
  unauthorized: '로그인 상태가 바뀌었습니다. 다시 로그인해 주세요.',
  unavailable: '현재 iPhone에서 운동 선택 기능을 사용할 수 없습니다.',
};
const managementMessages: Record<NativeBridgeHealthKitManagementStatus['state'], string> = {
  idle: '등록된 운동의 개별 해제는 iPhone에서 확인합니다.',
  loading: '현재 계정의 등록 운동을 iPhone에서 확인하고 있습니다.',
  choosing: 'iPhone에서 등록 해제할 운동 하나를 선택하세요.',
  confirming: '관련 제품 기록 삭제와 등록 해제를 iPhone에서 명시적으로 확인하세요.',
  deregistering: '등록 해제 요청의 서버 결과를 기다리고 있습니다.',
  pending_cleanup: '관련 기록을 정리하고 있습니다. 등록 귀속은 아직 해제되지 않았습니다.',
  released: '관련 기록 정리와 등록 귀속 해제를 확인했습니다.',
  cancelled: '운동 관리 화면을 닫았습니다. 이미 보낸 해제 요청은 처리됐을 수 있습니다.',
  offline: '연결을 확인하지 못했습니다. 이미 보낸 해제 요청의 결과는 온라인에서 다시 확인하세요.',
  conflict: '등록 해제 상태가 변경되었거나 충돌했습니다. 다시 확인하세요.',
  consent_required: 'HealthKit 동의를 확인한 뒤 등록 운동을 관리하세요.',
  unauthorized: '로그인 상태가 바뀌었습니다. 다시 로그인해 주세요.',
  unavailable: '현재 iPhone에서 등록 운동 관리 기능을 사용할 수 없습니다.',
  legacy_blocked:
    '과거 전송 자료의 운동 범위를 확인하지 못해 등록 해제를 진행할 수 없습니다. 기존 자료의 안전한 정리가 필요합니다.',
};
type OperationStatus = NativeBridgeHealthKitSelectionStatus | NativeBridgeHealthKitManagementStatus;
const messagesByOperation = {
  selection: { ...managementMessages, ...selectionMessages },
  management: { ...selectionMessages, ...managementMessages },
};
const activeOperationStates = new Set<OperationStatus['state']>([
  'loading',
  'choosing',
  'confirming',
  'registering',
  'deregistering',
  'pending_cleanup',
]);
const selectionPollLimit = 30;
const selectionPollDelayMs = 2000;
type SelectionView = { kind: 'error' } | { kind: 'ready'; status: OperationStatus };
interface OperationPanelProps {
  bridge: Bridge;
  consentGranted: boolean | null;
  onUnauthorized(): void;
}
function HealthKitSelectionPanel(props: OperationPanelProps) {
  return <HealthKitOperationPanel {...props} operation="selection" />;
}
function HealthKitManagementPanel(props: OperationPanelProps) {
  return <HealthKitOperationPanel {...props} operation="management" />;
}

/** Candidate data stays in the native sheet; this component receives only bounded facts. */
function HealthKitOperationPanel({
  operation,
  bridge,
  consentGranted,
  onUnauthorized,
}: OperationPanelProps & { operation: 'selection' | 'management' }) {
  const headingId = useId();
  const isManagement = operation === 'management';
  const [view, setView] = useState<SelectionView>({
    kind: 'ready',
    status: { state: 'idle', registeredCount: null, selectedCount: 0, resultCount: null },
  });
  const [selectionId, setSelectionId] = useState<string | null>(null);
  const selectionHandle = useRef<string | null>(null);
  const [pending, setPending] = useState<'open' | 'refresh' | 'cancel' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);
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

  const refreshSelection = useCallback(async () => {
    const handle = selectionHandle.current;
    if (!handle) return;
    const controller = begin();
    setPending('refresh');
    try {
      const result =
        operation === 'selection'
          ? await bridge.healthKitWorkoutSelectionStatus(handle, controller.signal)
          : await bridge.healthKitWorkoutManagementStatus(handle, controller.signal);
      if (!isCurrent(controller)) return;
      const status = result.ok
        ? (operation === 'selection'
            ? nativeBridgeHealthKitSelectionStatusSchema
            : nativeBridgeHealthKitManagementStatusSchema
          ).safeParse(result.value)
        : null;
      if (!status?.success) {
        setView({ kind: 'error' });
        return;
      }
      if (status.data.state === 'unauthorized') {
        onUnauthorized();
        return;
      }
      setView({ kind: 'ready', status: status.data });
    } catch {
      if (isCurrent(controller)) setView({ kind: 'error' });
    } finally {
      if (isCurrent(controller)) setPending(null);
    }
  }, [begin, bridge, isCurrent, onUnauthorized, operation]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
      request.current = null;
      const handle = selectionHandle.current;
      if (handle) {
        // Best effort only. Never apply old-scope results to this or a replacement panel.
        void (
          operation === 'selection'
            ? bridge.cancelHealthKitWorkoutSelection(handle)
            : bridge.cancelHealthKitWorkoutManagement(handle)
        ).catch(() => undefined);
      }
    };
  }, [bridge, operation]);

  const selecting = view.kind === 'ready' && activeOperationStates.has(view.status.state);
  useEffect(() => {
    if (!selecting || pending !== null || pollCount >= selectionPollLimit) return;
    const timer = setTimeout(() => {
      setPollCount((count) => count + 1);
      void refreshSelection();
    }, selectionPollDelayMs);
    return () => clearTimeout(timer);
  }, [selecting, pending, pollCount, refreshSelection]);

  async function openSelection() {
    if (consentGranted !== true || pending !== null || selecting) return;
    const controller = begin();
    setPending('open');
    setNotice(null);
    setPollCount(0);
    try {
      const result =
        operation === 'selection'
          ? await bridge.selectHealthKitWorkouts(controller.signal)
          : await bridge.manageHealthKitWorkouts(controller.signal);
      if (!isCurrent(controller)) return;
      if (!result.ok || result.value.status !== 'opened') {
        setNotice(
          isManagement
            ? '운동 관리 화면의 결과를 확인하지 못했습니다. 이미 보낸 해제 요청이 있다면 iPhone에서 다시 확인하세요.'
            : '운동 선택 화면의 결과를 확인하지 못했습니다. 상태를 다시 확인하세요.',
        );
        return;
      }
      const handle =
        'selectionId' in result.value ? result.value.selectionId : result.value.managementId;
      selectionHandle.current = handle;
      setSelectionId(handle);
      await refreshSelection();
    } catch {
      if (isCurrent(controller))
        setNotice(
          isManagement
            ? '운동 관리 화면을 열지 못했습니다. 다시 확인하세요.'
            : '운동 선택 화면을 열지 못했습니다. 다시 확인하세요.',
        );
    } finally {
      if (isCurrent(controller)) setPending(null);
    }
  }

  async function cancelSelection() {
    const handle = selectionHandle.current;
    if (!handle) return;
    const controller = begin();
    setPending('cancel');
    setNotice(null);
    try {
      const result =
        operation === 'selection'
          ? await bridge.cancelHealthKitWorkoutSelection(handle, controller.signal)
          : await bridge.cancelHealthKitWorkoutManagement(handle, controller.signal);
      if (!isCurrent(controller)) return;
      if (!result.ok || result.value !== 'cancelled') {
        setNotice(
          isManagement
            ? '관리 화면 닫기 결과를 확인하지 못했습니다. 해제 요청의 결과는 다시 확인하세요.'
            : '선택 취소 결과를 확인하지 못했습니다. iPhone 화면과 상태를 다시 확인하세요.',
        );
        return;
      }
      await refreshSelection();
    } catch {
      if (isCurrent(controller))
        setNotice(
          isManagement
            ? '관리 화면 닫기 결과를 확인하지 못했습니다. 다시 확인하세요.'
            : '선택 취소 결과를 확인하지 못했습니다. 다시 확인하세요.',
        );
    } finally {
      if (isCurrent(controller)) setPending(null);
    }
  }

  return (
    <section className={styles.selection} aria-labelledby={headingId} aria-busy={pending !== null}>
      <h3 id={headingId}>{isManagement ? '등록 운동 관리·해제' : '계정별 운동 등록'}</h3>
      <p>
        {isManagement
          ? '등록 운동 목록과 해제 대상은 iPhone 안에서만 표시됩니다. 관련 제품 기록 삭제를 명시 확인한 뒤 해제를 요청합니다. HealthKit 원본은 삭제하지 않습니다.'
          : '운동 목록은 iPhone 안에서만 표시됩니다. 선택 후 해당 계정 귀속과 서버 업로드를 별도로 확인합니다.'}
      </p>
      {isManagement ? (
        <p>
          화면을 닫아도 이미 보낸 해제 요청은 취소되지 않습니다. 정리 완료 후에만 다른 계정의 새
          명시 등록이 가능합니다.
        </p>
      ) : null}
      {view.kind === 'error' ? (
        <p role="alert">
          {isManagement
            ? '운동 해제 상태를 확인하지 못했습니다.'
            : '운동 등록 상태를 확인하지 못했습니다.'}
        </p>
      ) : null}
      {view.kind === 'ready' ? (
        <>
          <p role="status">{messagesByOperation[operation][view.status.state]}</p>
          <p>
            현재 계정 등록 운동:{' '}
            {view.status.registeredCount === null
              ? '확인되지 않음'
              : `${view.status.registeredCount}개`}
          </p>
          <p>
            {isManagement ? '해제 선택 운동' : '선택 운동'}: {view.status.selectedCount}개
          </p>
          <p>
            {isManagement ? '최근 해제 완료 결과' : '최근 등록 결과'}:{' '}
            {view.status.resultCount === null ? '확인되지 않음' : `${view.status.resultCount}개`}
          </p>
          {view.status.registeredCount === 0 ? (
            <p>등록 0개는 iPhone에 운동이 없다는 뜻이 아닙니다.</p>
          ) : null}
        </>
      ) : null}
      <button
        type="button"
        disabled={consentGranted !== true || pending !== null || selecting}
        onClick={() => void openSelection()}
      >
        {isManagement ? 'iPhone 등록 운동 관리·해제' : 'iPhone 운동 선택·등록'}
      </button>
      {selectionId && (isManagement || selecting || view.kind === 'error') ? (
        <button type="button" disabled={pending !== null} onClick={() => void cancelSelection()}>
          {isManagement ? '운동 관리 화면 닫기' : '운동 선택 취소'}
        </button>
      ) : null}
      <button
        type="button"
        disabled={pending !== null || selectionId === null}
        onClick={() => {
          setNotice(null);
          setPollCount(0);
          void refreshSelection();
        }}
      >
        {isManagement ? '운동 해제 상태 다시 확인' : '운동 등록 상태 다시 확인'}
      </button>
      {selecting && pollCount >= selectionPollLimit ? (
        <p>
          {isManagement
            ? '자동 확인을 멈췄습니다. 정리 완료를 뜻하지 않습니다. iPhone에서 해제 상태를 다시 확인하세요.'
            : '자동 확인을 멈췄습니다. iPhone에서 확인 후 등록 상태를 다시 확인하세요.'}
        </p>
      ) : null}
      {notice ? <p role="alert">{notice}</p> : null}
    </section>
  );
}

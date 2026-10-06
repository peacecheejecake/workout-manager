'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import styles from './app-consent-panel.module.css';

const appConsentSchema = z
  .strictObject({
    kind: z.literal('app'),
    granted: z.boolean(),
    revision: z.number().int().min(0).max(2147483647),
  })
  .refine((value) => value.revision !== 0 || !value.granted);
const sessionChangedSchema = z.object({ error: z.object({ code: z.literal('SESSION_CHANGED') }) });
const commandSchema = z.strictObject({
  granted: z.boolean(),
  expectedRevision: z.number().int().min(0).max(2147483646),
  idempotencyKey: z.uuid(),
});
type Command = z.infer<typeof commandSchema>;
type ActionError = 'conflict' | 'uncertain' | null;

export interface AppConsentPanelProps {
  session: { athleteId: string; sessionId: string; csrfToken: string };
  onSignedOut(): void;
  onSessionChanged(): void;
}

/** This lifetime never carries an old account's head or pending command into a new session. */
export function AppConsentPanel(props: AppConsentPanelProps) {
  return (
    <AppConsentLifetime
      key={JSON.stringify([props.session.athleteId, props.session.sessionId])}
      {...props}
    />
  );
}

function AppConsentLifetime({ session, onSignedOut, onSessionChanged }: AppConsentPanelProps) {
  const headingId = useId();
  const client = useQueryClient();
  const [key] = useState(() => [
    'users',
    session.athleteId,
    'sessions',
    session.sessionId,
    'consent',
    'app',
  ]);
  const active = useRef(true);
  const requests = useRef(new Set<AbortController>());
  const command = useRef<Command | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<ActionError>(null);
  const [sessionUnavailable, setSessionUnavailable] = useState(false);

  useEffect(() => {
    active.current = true;
    const ownedRequests = requests.current;
    return () => {
      active.current = false;
      command.current = null;
      for (const controller of ownedRequests) controller.abort();
      ownedRequests.clear();
      void client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
    };
  }, [client, key]);

  function requireActive(signal: AbortSignal) {
    if (!active.current || signal.aborted)
      throw new DOMException('Inactive consent request', 'AbortError');
  }
  function endSession(changed: boolean) {
    if (!active.current) return;
    active.current = false;
    command.current = null;
    for (const controller of requests.current) controller.abort();
    requests.current.clear();
    setSessionUnavailable(true);
    client.clear();
    if (changed) onSessionChanged();
    else onSignedOut();
  }
  async function requireSession(response: Response, signal: AbortSignal) {
    requireActive(signal);
    if (response.status === 401) {
      endSession(false);
      throw new DOMException('Session expired', 'AbortError');
    }
    if (response.status === 409) {
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      requireActive(signal);
      if (sessionChangedSchema.safeParse(body).success) {
        endSession(true);
        throw new DOMException('Session changed', 'AbortError');
      }
    }
  }
  const consent = useQuery({
    queryKey: key,
    enabled: !sessionUnavailable,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch('/bff/v1/consents/app', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'x-workout-session-id': session.sessionId },
        signal,
      });
      await requireSession(response, signal);
      if (!response.ok) throw new Error('APP_CONSENT_UNAVAILABLE');
      const parsed = appConsentSchema.parse(await response.json());
      requireActive(signal);
      return parsed;
    },
  });
  const current =
    consent.isSuccess && !consent.isFetching && !pending && !actionError && !sessionUnavailable
      ? consent.data
      : undefined;

  async function refresh() {
    if (!active.current || pending) return;
    command.current = null;
    setActionError(null);
    await consent.refetch();
  }
  async function change(input: Command) {
    if (!active.current || requests.current.size || pending) return;
    const controller = new AbortController();
    requests.current.add(controller);
    command.current = input;
    setPending(true);
    setActionError(null);
    let receivedReceipt = false;
    try {
      await client.cancelQueries({ queryKey: key, exact: true });
      requireActive(controller.signal);
      const response = await fetch('/bff/v1/consents/app', {
        method: 'PUT',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': session.csrfToken,
          'x-workout-session-id': session.sessionId,
          'idempotency-key': input.idempotencyKey,
        },
        body: JSON.stringify({ granted: input.granted, expectedRevision: input.expectedRevision }),
        signal: controller.signal,
      });
      await requireSession(response, controller.signal);
      if (response.status === 409) {
        setActionError('conflict');
        command.current = null;
        return;
      }
      if (!response.ok) throw new Error('APP_CONSENT_UNAVAILABLE');
      const receipt = appConsentSchema.parse(await response.json());
      requireActive(controller.signal);
      if (receipt.granted !== input.granted || receipt.revision <= input.expectedRevision)
        throw new Error('APP_CONSENT_RECEIPT_MISMATCH');
      receivedReceipt = true;
      command.current = null;
      // The receipt describes this command; only a fresh GET describes the current head.
      await consent.refetch();
      requireActive(controller.signal);
    } catch {
      if (active.current && !controller.signal.aborted && !receivedReceipt)
        setActionError('uncertain');
    } finally {
      requests.current.delete(controller);
      if (active.current && !controller.signal.aborted) setPending(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h3 id={headingId}>앱 저장·처리 동의</h3>
      <p>
        계획·실제 기록·대화를 새로 저장하거나 처리하기 위한 허용입니다. AI에 정보를 전달하는 동의 및
        HealthKit 접근 허용과는 별개입니다.
      </p>
      <p>
        허용을 철회하면 새로운 저장·처리를 중단합니다. 이미 저장한 데이터의 조회·내보내기·삭제는
        계속 이용할 수 있습니다.
      </p>
      {sessionUnavailable ? (
        <p role="status">로그인 상태가 변경되었습니다. 계정을 다시 확인하세요.</p>
      ) : (
        <>
          {consent.isPending || consent.isFetching || pending ? (
            <p role="status">앱 저장·처리 허용 상태를 확인하고 있습니다.</p>
          ) : null}
          {consent.isError && !pending ? (
            <div role="alert">
              <p>현재 앱 이용 허용 상태를 확인하지 못했습니다.</p>
              <button type="button" onClick={() => void refresh()}>
                앱 이용 허용 다시 확인
              </button>
            </div>
          ) : null}
          {current ? (
            <>
              <p>현재 앱 저장·처리: {current.granted ? '허용' : '허용하지 않음'}</p>
              {current.revision === 2147483647 ? (
                <p>현재 허용 상태를 변경할 수 없습니다.</p>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    void change(
                      commandSchema.parse({
                        granted: !current.granted,
                        expectedRevision: current.revision,
                        idempotencyKey: crypto.randomUUID(),
                      }),
                    )
                  }
                >
                  {current.granted ? '앱 처리 동의 철회' : '앱 저장·처리에 동의'}
                </button>
              )}
            </>
          ) : null}
          {actionError ? (
            <div role="alert">
              <p>
                {actionError === 'conflict'
                  ? '다른 변경과 충돌했습니다. 현재 앱 이용 허용 상태를 다시 확인하세요.'
                  : '앱 이용 허용 변경의 결과를 확인하지 못했습니다.'}
              </p>
              <button type="button" onClick={() => void refresh()}>
                현재 앱 이용 허용 다시 확인
              </button>
              {actionError === 'uncertain' ? (
                <button
                  type="button"
                  onClick={() => {
                    if (command.current) void change(command.current);
                  }}
                >
                  같은 앱 이용 변경 재시도
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

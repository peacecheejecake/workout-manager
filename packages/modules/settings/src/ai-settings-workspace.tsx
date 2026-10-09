import { useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  aiSettingsV1Schema,
  aiSettingsWriteV1Schema,
  inspectSavedAiSelectionV1,
  validateAiSettingsChoicesV1,
  type AiExecutionCatalogV1,
  type AiSelectionV1,
  type AiSettingsV1,
} from '@workout/contracts/ai-settings';
import {
  AiSettingsPortError,
  readCatalog,
  readSettings,
  type AiSettingsPort,
} from './ai-settings-port';
import styles from './ai-settings.module.css';

export type { AiSettingsPort, AiSettingsPortContext } from './ai-settings-port';
export { AiSettingsPortError } from './ai-settings-port';
export interface AiSettingsWorkspaceProps {
  athleteId: string | null;
  sessionId: string | null;
  port: AiSettingsPort;
}
type Scope = { athleteId: string; sessionId: string; port: AiSettingsPort };
type Choices = Pick<AiSettingsV1, 'defaultSelection' | 'syntheticComparison'>;
const choices = (settings: AiSettingsV1): Choices => ({
  defaultSelection: settings.defaultSelection,
  syntheticComparison: settings.syntheticComparison,
});
const equal = (left: Choices, right: Choices) => JSON.stringify(left) === JSON.stringify(right);

export function AiSettingsWorkspace(props: AiSettingsWorkspaceProps) {
  if (!props.athleteId || !props.sessionId)
    return (
      <section className={styles.workspace}>
        <h2>AI 설정</h2>
        <p>로그인 후 AI 설정을 확인할 수 있습니다.</p>
      </section>
    );
  return (
    <ScopedWorkspace
      key={JSON.stringify([props.athleteId, props.sessionId])}
      athleteId={props.athleteId}
      sessionId={props.sessionId}
      port={props.port}
    />
  );
}
function ScopedWorkspace(scope: Scope) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
        },
      }),
  );
  useEffect(
    () => () => {
      void client.cancelQueries();
      client.clear();
    },
    [client],
  );
  return (
    <QueryClientProvider client={client}>
      <WorkspaceData {...scope} />
    </QueryClientProvider>
  );
}
function WorkspaceData(scope: Scope) {
  const catalog = useQuery({
    queryKey: ['ai-settings-catalog', scope.athleteId, scope.sessionId],
    queryFn: ({ signal }) =>
      readCatalog(scope.port, { athleteId: scope.athleteId, sessionId: scope.sessionId, signal }),
  });
  const settings = useQuery({
    queryKey: ['ai-settings', scope.athleteId, scope.sessionId],
    queryFn: ({ signal }) =>
      readSettings(scope.port, { athleteId: scope.athleteId, sessionId: scope.sessionId, signal }),
  });
  const reload = async () => {
    await Promise.all([catalog.refetch(), settings.refetch()]);
  };
  return (
    <section className={styles.workspace} aria-label="AI 설정">
      <h2>AI 설정</h2>
      <p>전체 사용자·모델 합산 월 50,000원 한도 · Asia/Seoul 기준</p>
      <p>
        새 요청에 사용할 선택을 저장합니다. 저장만으로 정보를 전송하거나 전송에 동의하지 않으며,
        AI를 호출하거나 기존 코칭·계획을 변경하지 않습니다.
      </p>
      {catalog.data && settings.data ? (
        <SettingsForm
          {...scope}
          catalog={catalog.data}
          settings={settings.data}
          blocked={catalog.isFetching || settings.isFetching || catalog.isError || settings.isError}
          reload={reload}
        />
      ) : catalog.isError || settings.isError ? (
        <>
          <p role="alert">설정을 불러오지 못했습니다. 다시 확인해 주세요.</p>
          <button type="button" onClick={() => void reload()}>
            다시 불러오기
          </button>
        </>
      ) : (
        <p role="status">AI 설정을 불러오는 중입니다.</p>
      )}
      {catalog.data && settings.data && (catalog.isError || settings.isError) ? (
        <p role="alert">최신 설정을 확인하지 못했습니다. 초안은 유지됩니다.</p>
      ) : null}
    </section>
  );
}
function SettingsForm({
  catalog,
  settings,
  blocked,
  reload,
  ...scope
}: Scope & {
  catalog: AiExecutionCatalogV1;
  settings: AiSettingsV1;
  blocked: boolean;
  reload: () => Promise<void>;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(() => choices(settings));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const providerRef = useRef<HTMLSelectElement>(null);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  const receipt = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  const commandBase = {
    schemaVersion: 1,
    expectedRevision: settings.revision,
    catalogRevision: catalog.catalogRevision,
    policyVersion: catalog.policyVersion,
    disclosureVersion: catalog.disclosureVersion,
    ...draft,
  };
  const candidate = aiSettingsWriteV1Schema.safeParse({
    ...commandBase,
    idempotencyKey: 'settings-preview',
  });
  const allowed = candidate.success && validateAiSettingsChoicesV1(catalog, candidate.data).ok;
  async function save() {
    if (!allowed || saving || blocked || equal(draft, choices(settings))) return;
    const signature = JSON.stringify(commandBase);
    if (receipt.current?.signature !== signature)
      receipt.current = { signature, key: crypto.randomUUID() };
    const command = aiSettingsWriteV1Schema.parse({
      ...commandBase,
      idempotencyKey: receipt.current.key,
    });
    const request = new AbortController();
    controller.current = request;
    setSaving(true);
    setMessage('');
    try {
      const result = aiSettingsV1Schema.safeParse(
        await scope.port.save(
          { athleteId: scope.athleteId, sessionId: scope.sessionId, signal: request.signal },
          command,
        ),
      );
      request.signal.throwIfAborted();
      if (
        !result.success ||
        result.data.revision !== command.expectedRevision + 1 ||
        !equal(choices(result.data), draft)
      )
        throw new AiSettingsPortError('INVALID_RESPONSE');
      if (!active.current) return;
      client.setQueryData(['ai-settings', scope.athleteId, scope.sessionId], result.data);
      setDraft(choices(result.data));
      receipt.current = null;
      setMessage('AI 설정을 저장했습니다.');
    } catch (error: unknown) {
      if (!active.current || request.signal.aborted) return;
      setMessage(
        error instanceof AiSettingsPortError &&
          ['REVISION_CONFLICT', 'STALE_CATALOG', 'STALE_POLICY', 'STALE_DISCLOSURE'].includes(
            error.code,
          )
          ? '설정이 변경되었습니다. 초안을 유지했으니 최신 설정을 다시 확인해 주세요.'
          : error instanceof AiSettingsPortError && error.code === 'CSRF_REJECTED'
            ? '요청을 확인하지 못했습니다. 페이지를 새로 열어 다시 시도해 주세요. 선택한 초안은 유지됩니다.'
            : '설정을 저장하지 못했습니다. 선택한 초안은 유지됩니다.',
      );
    } finally {
      if (active.current && !request.signal.aborted) setSaving(false);
    }
  }
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {catalog.providers.length === 0 ? <p>현재 선택할 수 있는 AI 제공자가 없습니다.</p> : null}
      <fieldset disabled={saving}>
        <legend>기본 AI 모델</legend>
        <SelectionFields
          catalog={catalog}
          purpose="coaching"
          prefix="기본"
          selection={draft.defaultSelection}
          providerRef={providerRef}
          onChange={(selection) =>
            setDraft((current) => ({ ...current, defaultSelection: selection }))
          }
        />
      </fieldset>
      <fieldset disabled={saving}>
        <legend>합성 비교 설정</legend>
        <label>
          합성 비교 사용
          <select
            value={draft.syntheticComparison.kind}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                syntheticComparison:
                  event.target.value === 'selected'
                    ? { kind: 'selected', selection: { providerId: '', modelId: '' } }
                    : { kind: 'off' },
              }))
            }
          >
            <option value="off">사용 안 함</option>
            <option value="selected">모델 선택</option>
          </select>
        </label>
        {draft.syntheticComparison.kind === 'selected' ? (
          <SelectionFields
            catalog={catalog}
            purpose="synthetic_comparison"
            prefix="합성 비교"
            selection={draft.syntheticComparison.selection}
            onChange={(selection) =>
              setDraft((current) => ({
                ...current,
                syntheticComparison: {
                  kind: 'selected',
                  selection: selection ?? { providerId: '', modelId: '' },
                },
              }))
            }
          />
        ) : null}
        <p className={styles.hint}>
          합성 비교용 선택만 저장합니다. 비교는 자동으로 실행되지 않습니다.
        </p>
      </fieldset>
      <div className={styles.actions}>
        <button
          type="submit"
          disabled={saving || blocked || !allowed || equal(draft, choices(settings))}
        >
          {saving ? '저장 중…' : '설정 저장'}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setDraft(choices(settings));
            setMessage('');
            receipt.current = null;
            providerRef.current?.focus();
          }}
        >
          변경 취소
        </button>
        <button type="button" disabled={saving || blocked} onClick={() => void reload()}>
          최신 설정 다시 확인
        </button>
      </div>
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
function SelectionFields({
  catalog,
  selection,
  purpose,
  prefix,
  providerRef,
  onChange,
}: {
  catalog: AiExecutionCatalogV1;
  selection: AiSelectionV1 | null;
  purpose: 'coaching' | 'synthetic_comparison';
  prefix: string;
  providerRef?: React.Ref<HTMLSelectElement>;
  onChange: (selection: AiSelectionV1 | null) => void;
}) {
  const provider = catalog.providers.find((entry) => entry.providerId === selection?.providerId);
  const model = provider?.models.find((entry) => entry.modelId === selection?.modelId);
  const status = inspectSavedAiSelectionV1(catalog, selection?.modelId ? selection : null, purpose);
  let notice = '선택하지 않았습니다.';
  if (status.kind === 'available') notice = '실행에는 별도 동의와 확인이 필요합니다.';
  else if (status.kind === 'unavailable')
    notice =
      status.reasonCode === 'unconfigured'
        ? '선택은 저장할 수 있지만 AI 연결이 준비되지 않아 실행할 수 없습니다.'
        : '선택한 모델을 지금 사용할 수 없습니다.';
  else if (status.kind !== 'not_selected')
    notice = '이전에 선택한 모델은 현재 선택할 수 없습니다. 다른 모델을 직접 선택하세요.';
  return (
    <div className={styles.selection}>
      <label>
        {prefix} 제공자
        <select
          ref={providerRef}
          value={selection?.providerId ?? ''}
          onChange={(event) =>
            onChange(event.target.value ? { providerId: event.target.value, modelId: '' } : null)
          }
        >
          <option value="">선택 안 함</option>
          {selection?.providerId && !provider ? (
            <option value={selection.providerId} disabled>
              이전에 저장한 제공자 · 현재 선택 불가
            </option>
          ) : null}
          {catalog.providers.map((entry) => (
            <option
              key={entry.providerId}
              value={entry.providerId}
              disabled={
                !entry.selectable ||
                !entry.models.some((item) => item.selectable && item.purposes.includes(purpose))
              }
            >
              {entry.displayName}
              {entry.selectable ? '' : ' · 현재 선택 불가'}
            </option>
          ))}
        </select>
      </label>
      <label>
        {prefix} 모델
        <select
          value={selection?.modelId ?? ''}
          disabled={!provider}
          onChange={(event) => {
            if (selection) onChange({ ...selection, modelId: event.target.value });
          }}
        >
          <option value="">모델을 선택하세요</option>
          {selection?.modelId && !model ? (
            <option value={selection.modelId} disabled>
              이전에 저장한 모델 · 현재 선택 불가
            </option>
          ) : null}
          {provider?.models.map((entry) => (
            <option
              key={entry.modelId}
              value={entry.modelId}
              disabled={
                !provider.selectable || !entry.selectable || !entry.purposes.includes(purpose)
              }
            >
              {entry.displayName}
              {entry.selectable && entry.purposes.includes(purpose) ? '' : ' · 현재 선택 불가'}
            </option>
          ))}
        </select>
      </label>
      {provider ? (
        <div aria-label={`${prefix} 정보 전송 안내`}>
          <p>정보를 받는 곳: {provider.recipient.displayName}</p>
          <p>별도 전송 동의를 확인할 정보 범위:</p>
          <ul>
            {catalog.approvedScopes.map((scope) => (
              <li key={scope}>{scopeLabels[scope]}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className={styles.hint}>{notice}</p>
    </div>
  );
}

const scopeLabels = {
  plan_summary: '계획 요약',
  actual_summary: '실제 기록 요약',
  check_in: '체크인',
  resource_excerpt: '참고 자료 발췌',
} as const;

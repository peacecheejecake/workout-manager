import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { checkInSchema } from '@workout/contracts/check-ins';
import type {
  CheckInTemplateField,
  SaveCheckInTemplate,
} from '@workout/contracts/check-in-templates';
import { Button } from '@workout/ui-foundation/button';
import { CheckInTemplateRequestError, type CheckInTemplateApi } from './check-in-template-api';
import styles from './routine.module.css';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const labels: Record<CheckInTemplateField, string> = {
  fatigue: '피로',
  discomfort: '불편감',
  bodyLocation: '부위',
  note: '메모',
};
function message(error: unknown) {
  if (error instanceof CheckInTemplateRequestError && error.code === 'APP_CONSENT_REQUIRED')
    return '앱 데이터 처리 동의가 필요합니다. 입력은 유지됩니다.';
  return '체크인 정보를 확인하지 못했습니다. 다시 시도하세요.';
}
export function CheckInTemplateEditor({
  api,
  scope,
  value,
  disabled,
  onSelect,
}: {
  api: CheckInTemplateApi;
  scope: readonly string[];
  value: { id: string; versionId: string };
  disabled: boolean;
  onSelect: (ref: { id: string; versionId: string }) => void;
}) {
  const client = useQueryClient();
  const [offset, setOffset] = useState(0),
    [candidate, setCandidate] = useState<{ id: string; versionId: string } | null>(null);
  const [title, setTitle] = useState(''),
    [instructions, setInstructions] = useState('');
  const [fields, setFields] = useState<CheckInTemplateField[]>(['fatigue', 'discomfort']);
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [notice, setNotice] = useState('');
  const pending = useRef<SaveCheckInTemplate | null>(null),
    alive = useRef(true),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const list = useQuery({
    queryKey: [...scope, 'check-in-templates', offset],
    queryFn: ({ signal }) => api.list({ limit: 100, offset }, signal),
  });
  const requested =
    candidate ??
    (uuid.safeParse(value.id).success && uuid.safeParse(value.versionId).success ? value : null);
  const exact = useQuery({
    queryKey: [...scope, 'check-in-template-version', requested?.id, requested?.versionId],
    enabled: requested !== null,
    queryFn: ({ signal }) => {
      if (!requested) throw Error('TEMPLATE_REQUIRED');
      return api.readExact(requested.id, requested.versionId, signal);
    },
  });
  async function save() {
    if (busy || disabled) return;
    const command = pending.current ?? {
      idempotencyKey: crypto.randomUUID(),
      templateId: crypto.randomUUID(),
      expectedVersion: 0,
      content: {
        definitionVersion: 'checkin-v1' as const,
        source: 'user' as const,
        method: 'self_report' as const,
        title,
        instructions: instructions.trim() || null,
        fields,
      },
    };
    pending.current = command;
    setBusy(true);
    setNotice('');
    controller.current = new AbortController();
    try {
      const saved = await api.save(command, controller.current.signal);
      if (!alive.current) return;
      pending.current = null;
      setUncertain(false);
      setCandidate({ id: saved.templateId, versionId: saved.versionId });
      setNotice('입력 항목을 저장했습니다. 내용을 확인하고 이 고정 버전을 선택하세요.');
      await client.invalidateQueries({ queryKey: [...scope, 'check-in-templates'] });
    } catch (error) {
      if (!alive.current) return;
      if (
        error instanceof z.ZodError ||
        (error instanceof CheckInTemplateRequestError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 425, 429].includes(error.status))
      ) {
        pending.current = null;
        setUncertain(false);
        setNotice(
          error instanceof z.ZodError
            ? '제목과 하나 이상의 입력 항목을 확인하세요.'
            : message(error),
        );
      } else {
        setUncertain(true);
        setNotice('저장 결과가 불확실합니다. 같은 입력과 요청으로 재시도하세요.');
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const locked = disabled || busy || uncertain;
  return (
    <div className={styles.stack}>
      <p>
        체크인 템플릿은 직접 보고할 입력 항목입니다. 저장해도 날짜가 있는 실제 체크인이 생성되지
        않습니다.
      </p>
      {list.isPending ? (
        <p role="status">내 체크인 템플릿을 불러오는 중입니다.</p>
      ) : list.isError ? (
        <div role="alert">
          {message(list.error)}{' '}
          <Button variant="secondary" onClick={() => void list.refetch()}>
            템플릿 목록 재시도
          </Button>
        </div>
      ) : (
        <>
          <label className={styles.field}>
            내 체크인 템플릿
            <select
              disabled={locked}
              value={candidate?.versionId ?? ''}
              onChange={(event) => {
                const item = list.data.items.find((item) => item.versionId === event.target.value);
                setCandidate(item ? { id: item.templateId, versionId: item.versionId } : null);
              }}
            >
              <option value="">확인할 템플릿 선택</option>
              {list.data.items.map((item) => (
                <option key={item.templateId} value={item.versionId}>
                  {item.content.title} · 버전 {item.version}
                </option>
              ))}
            </select>
          </label>
          {list.data.items.length === 0 ? (
            <p>이 페이지에 저장된 체크인 템플릿이 없습니다.</p>
          ) : null}
          <div className={styles.actions}>
            <Button
              variant="secondary"
              disabled={locked || offset === 0}
              onClick={() => setOffset(offset - 100)}
            >
              이전 템플릿
            </Button>
            <Button
              variant="secondary"
              disabled={locked || list.data.items.length < 100 || offset >= 10000}
              onClick={() => setOffset(offset + 100)}
            >
              다음 템플릿
            </Button>
          </div>
        </>
      )}
      {requested ? (
        exact.isPending ? (
          <p role="status">고정 버전을 확인하는 중입니다.</p>
        ) : exact.isError ? (
          <div role="alert">
            {message(exact.error)}{' '}
            <Button variant="secondary" onClick={() => void exact.refetch()}>
              고정 버전 재시도
            </Button>
          </div>
        ) : exact.data ? (
          <div>
            <p>
              {exact.data.content.title} · 고정 버전 {exact.data.version} · 사용자 직접 보고
              (self_report)
            </p>
            <p>입력 항목: {exact.data.content.fields.map((field) => labels[field]).join(', ')}</p>
            {exact.data.content.instructions ? <p>{exact.data.content.instructions}</p> : null}
            <p>
              템플릿 ID: {exact.data.templateId} / 고정 버전 ID: {exact.data.versionId}
            </p>
            <p>새 템플릿 버전이 생겨도 이 참조는 자동 변경되지 않습니다.</p>
            <Button
              variant="secondary"
              disabled={locked}
              onClick={() =>
                onSelect({ id: exact.data.templateId, versionId: exact.data.versionId })
              }
            >
              이 고정 버전 선택
            </Button>
          </div>
        ) : null
      ) : null}
      <fieldset disabled={locked}>
        <legend>새 체크인 입력 항목 저장</legend>
        <label className={styles.field}>
          체크인 템플릿 제목
          <input maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className={styles.field}>
          체크인 안내 (선택)
          <textarea
            maxLength={2000}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        {(['fatigue', 'discomfort', 'bodyLocation', 'note'] satisfies CheckInTemplateField[]).map(
          (field) => (
            <label key={field}>
              <input
                type="checkbox"
                checked={fields.includes(field)}
                onChange={(event) =>
                  setFields((previous) =>
                    event.target.checked
                      ? [...previous, field]
                      : previous.filter((item) => item !== field),
                  )
                }
              />
              {labels[field]}
            </label>
          ),
        )}
      </fieldset>
      <Button
        variant="secondary"
        disabled={disabled || busy || (!uncertain && (!title.trim() || fields.length === 0))}
        onClick={() => void save()}
      >
        {uncertain ? '같은 템플릿 저장 재시도' : '체크인 입력 항목 저장'}
      </Button>
      <p role="status" aria-live="polite">
        {notice}
      </p>
    </div>
  );
}
export function CheckInActualSelector({
  transport,
  scope,
  disabled,
  onSelect,
}: {
  transport: AuthenticatedTransport;
  scope: readonly string[];
  disabled: boolean;
  onSelect: (ref: { id: string; revisionId: string } | null) => void;
}) {
  const [input, setInput] = useState(''),
    [requested, setRequested] = useState<string | null>(null),
    [error, setError] = useState(''),
    [selected, setSelected] = useState(false);
  const actual = useQuery({
    queryKey: [...scope, 'check-in-actual', requested],
    enabled: requested !== null,
    queryFn: async ({ signal }) => {
      if (!requested) throw Error('CHECKIN_REQUIRED');
      signal.throwIfAborted();
      const reply = transportReplySchema.parse(
        await transport.request({
          path: `/bff/v1/check-ins/${encodeURIComponent(requested)}`,
          method: 'GET',
          body: null,
          idempotencyKey: null,
          signal,
        }),
      );
      signal.throwIfAborted();
      if (reply.status !== 200) throw Error('CHECKIN_UNAVAILABLE');
      const record = checkInSchema.parse(reply.body);
      if (record.id.toLowerCase() !== requested) throw Error('CHECKIN_MISMATCH');
      return record;
    },
  });
  return (
    <div className={styles.stack}>
      <p>
        날짜가 있는 실제 체크인을 확인한 뒤 연결합니다. 템플릿 ID를 실제 기록 ID로 사용하지 마세요.
      </p>
      <a href="/wellbeing">체크인 기록 작성·확인</a>
      <label className={styles.field}>
        실제 체크인 ID (UUID)
        <input
          value={input}
          disabled={disabled}
          onChange={(event) => {
            setInput(event.target.value);
            setRequested(null);
            setSelected(false);
            setError('');
            onSelect(null);
          }}
        />
      </label>
      <Button
        variant="secondary"
        disabled={disabled || !input.trim() || actual.isFetching}
        onClick={() => {
          const id = uuid.safeParse(input.trim());
          if (!id.success) {
            setError('실제 체크인 UUID를 입력하세요.');
            return;
          }
          setError('');
          setSelected(false);
          onSelect(null);
          if (requested === id.data) void actual.refetch();
          else setRequested(id.data);
        }}
      >
        실제 체크인 확인
      </Button>
      {actual.isFetching ? <p role="status">실제 체크인을 확인하는 중입니다.</p> : null}
      {error || actual.isError ? (
        <p role="alert">
          {error || '실제 체크인을 확인하지 못했습니다. 삭제·권한·기록 ID를 확인하세요.'}
        </p>
      ) : null}
      {actual.data && !actual.isError && !actual.isFetching ? (
        <div>
          <p>
            관측 시각: {actual.data.values.observedAt} · {actual.data.values.timezone}
          </p>
          <p>
            피로: {actual.data.values.fatigue === null ? '미상' : actual.data.values.fatigue} /
            불편감:{' '}
            {actual.data.values.discomfort === null ? '미상' : actual.data.values.discomfort}
          </p>
          <p>
            실제 체크인 ID: {actual.data.id} · 숫자 revision: {actual.data.revision}
          </p>
          <p>사용자 직접 보고이며 측정·진위 검토 완료를 뜻하지 않습니다.</p>
          <Button
            variant="secondary"
            disabled={disabled || selected}
            onClick={() => {
              onSelect({ id: actual.data.id, revisionId: String(actual.data.revision) });
              setSelected(true);
            }}
          >
            이 실제 체크인 연결
          </Button>
          {selected ? (
            <p role="status">연결할 기록을 선택했습니다. 수행 확인을 눌러 서버에 저장하세요.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

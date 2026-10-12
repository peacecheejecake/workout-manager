import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  nutritionPlanVersionCompatibleV4Schema,
  type NutritionPlanVersionCompatibleV4,
} from '@workout/contracts/nutrition-race-plan-v4';
import {
  nutritionPlanDraftV3Schema,
  type NutritionPlanDraftV3,
} from '@workout/contracts/nutrition-race-plan-v3';
import {
  nutritionPlanPublicPreviewV4RequestSchema,
  nutritionPlanPublicApproveV4RequestSchema,
  type NutritionPlanPublicPreviewV4,
  type NutritionPlanPublicPreviewV4Request,
  type NutritionPlanPublicApproveV4Request,
  type NutritionPlanPublicTimingV4,
} from '@workout/contracts/nutrition-race-plan-public-v4';
import { expectedRaceHeadsSchema } from '@workout/contracts/nutrition-race-timing';
import { raceEventSchema, type RaceEvent } from '@workout/contracts/races';
import type { RaceListCursor } from '@workout/contracts/race-queries';
import { Button } from '@workout/ui-foundation/button';
import { NutritionRequestError, RECONNECT_RACE_PAGE_SIZE } from './nutrition-api';
import type { NutritionApi, NutritionScope } from './nutrition-workspace';
import styles from './nutrition-race-reconnect-editor.module.css';

/** Lossless manual draft projection. Unsupported approved provenance is blocked,
 * never rewritten as user_confirmed. Pins/approval metadata stay in the record. */
export function retainedNutritionReconnectDraft(raw: unknown): NutritionPlanDraftV3 | null {
  const parsed = nutritionPlanVersionCompatibleV4Schema.safeParse(raw);
  if (!parsed.success) return null;
  const record = parsed.data;
  const draft = nutritionPlanDraftV3Schema.safeParse({
    period: record.period,
    timezone: record.timezone,
    purpose: record.purpose,
    linkedTrainingPlanVersionId: record.linkedTrainingPlanVersionId,
    items: record.items.map(({ planVersionId, ...item }) => {
      void planVersionId;
      return item;
    }),
  });
  return draft.success ? draft.data : null;
}
type Selection = {
  eventId: string;
  point: 'start' | 'end';
  offset: string;
  race: RaceEvent | null;
};
type Attempt = { body: NutritionPlanPublicApproveV4Request; key: string };
function timing(value: NutritionPlanPublicTimingV4 | null) {
  if (value === null) return '항목 없음';
  if (value.state === 'suspended') return '연결 해제 · 시각 사용 중단';
  if (value.state === 'unresolved') return `미해결 · ${value.reason}`;
  return `${value.date} · ${value.localTime ?? '시각 미상'} · ${value.timezone}`;
}
function failure(error: unknown): string {
  if (error instanceof NutritionRequestError) {
    if (error.status === 409)
      return '기준 버전·대회 또는 앱 동의가 변경됐습니다. 입력을 유지했습니다. 최신 자료를 확인하고 다시 검토하세요.';
    if (error.status === 401) return '로그인이 필요합니다. 저장되지 않았습니다.';
    if (error.status === 404)
      return '본인 대회 또는 계획을 확인할 수 없습니다. 입력을 유지했습니다.';
  }
  return '재연결 입력 또는 지원 상태를 확인할 수 없습니다. 원 승인본과 입력은 유지됩니다.';
}
export function NutritionRaceReconnectEditor({
  api,
  scope,
  record,
  latestRecord,
  onCommitted,
  newKey = () => crypto.randomUUID(),
}: {
  api: NutritionApi;
  scope: NutritionScope;
  record: NutritionPlanVersionCompatibleV4;
  latestRecord: NutritionPlanVersionCompatibleV4 | null;
  onCommitted: () => void;
  newKey?: () => string;
}) {
  const [baseline, setBaseline] = useState(record);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Record<string, Selection>>({});
  const [preview, setPreview] = useState<NutritionPlanPublicPreviewV4 | null>(null);
  const [previewInput, setPreviewInput] = useState<NutritionPlanPublicPreviewV4Request | null>(
    null,
  );
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState<Attempt | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true),
    controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    alive.current = true;
    const pending = controllers.current;
    return () => {
      alive.current = false;
      for (const c of pending) c.abort();
      pending.clear();
    };
  }, []);
  const capabilities = useQuery({
    queryKey: [...scope, 'public-v4-capabilities'],
    queryFn: ({ signal }) => api.capabilitiesV4(signal),
  });
  const races = useInfiniteQuery({
    queryKey: [...scope, 'reconnect-races', baseline.versionId],
    initialPageParam: null as RaceListCursor | null,
    queryFn: ({ pageParam, signal }) => api.listReconnectRaces(pageParam, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open,
  });
  // Pages are appended only on an explicit request; IDs are deduplicated so a repeated
  // position can never duplicate or silently replace a candidate.
  const raceOptions = [
    ...new Map(
      (races.data?.pages ?? []).flatMap((page) => page.items).map((race) => [race.id, race]),
    ).values(),
  ];
  const staleRaceCursor =
    races.isFetchNextPageError &&
    races.error instanceof NutritionRequestError &&
    (races.error.status === 409 || races.error.status === 404);
  const supported =
    capabilities.data?.readV4 === true &&
    capabilities.data.previewV4 &&
    capabilities.data.standaloneApprovalV4;
  const draft = retainedNutritionReconnectDraft(baseline);
  const disconnected = baseline.items.filter((item) => item.anchor.kind === 'disconnected');
  const stale =
    latestRecord !== null &&
    latestRecord.version >= baseline.version &&
    latestRecord.versionId !== baseline.versionId;
  function invalidate() {
    setPreview(null);
    setPreviewInput(null);
    setConfirmed(false);
    setNotice(null);
  }
  function change(id: string, next: Selection | null) {
    invalidate();
    setSelected((current) => {
      return next === null
        ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== id))
        : { ...current, [id]: next };
    });
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController();
    controllers.current.add(controller);
    setBusy(true);
    try {
      await action(controller.signal);
    } catch (error) {
      if (alive.current) setNotice(failure(error));
    } finally {
      controllers.current.delete(controller);
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function confirmRace(id: string, choice: Selection) {
    invalidate();
    void run(async (signal) => {
      const race = raceEventSchema.parse(await api.readReconnectRace(choice.eventId, signal));
      if (!alive.current) return;
      setSelected((current) => ({ ...current, [id]: { ...choice, race } }));
    });
  }
  async function prepare() {
    invalidate();
    if (!draft || stale || !supported || Object.keys(selected).length === 0) return;
    await run(async (signal) => {
      const items = draft.items.map((item) => {
        const choice = Object.hasOwn(selected, item.id) ? selected[item.id] : undefined;
        if (!choice) return item;
        if (
          item.anchor.kind !== 'disconnected' ||
          choice.race === null ||
          choice.race.id !== choice.eventId ||
          choice.offset.trim() === ''
        )
          throw Error('INPUT');
        return {
          ...item,
          anchor: {
            kind: 'relative' as const,
            entity: 'race' as const,
            entityId: choice.race.id,
            point: choice.point,
            offsetMinutes: Number(choice.offset),
          },
        };
      });
      const updated = nutritionPlanDraftV3Schema.parse({ ...draft, items });
      const ids = [
        ...new Set(
          items.flatMap((item) =>
            item.anchor.kind === 'relative' && item.anchor.entity === 'race'
              ? [item.anchor.entityId]
              : [],
          ),
        ),
      ].sort();
      const heads = [];
      for (const id of ids) {
        const chosen = Object.values(selected).find((choice) => choice.race?.id === id)?.race;
        const race = chosen ?? (await api.readReconnectRace(id, signal));
        heads.push({ namespace: 'race-event' as const, eventId: race.id, revision: race.revision });
      }
      const input = nutritionPlanPublicPreviewV4RequestSchema.parse({
        schemaVersion: 4,
        expectedHeadVersionId: baseline.versionId,
        draft: updated,
        expectedRaceHeads: expectedRaceHeadsSchema.parse(heads),
        reconnectItemIds: Object.keys(selected).sort(),
      });
      const result = await api.previewPlanV4(baseline.planId, input, signal);
      if (!alive.current) return;
      setPreview(result);
      setPreviewInput(input);
    });
  }
  async function approve(attempt: Attempt) {
    await run(async (signal) => {
      try {
        const result = await api.approvePlanV4(baseline.planId, attempt.body, attempt.key, signal);
        if (!alive.current) return;
        setBaseline(result.plan);
        setSelected({});
        setPreview(null);
        setPreviewInput(null);
        setConfirmed(false);
        setUncertain(null);
        setOpen(false);
        setNotice(
          `재연결과 재승인이 서버에 반영되었습니다. 승인 버전 ${result.plan.version}. 실제 섭취 기록은 생성되지 않습니다.${result.notices.length ? ` 유지 안내 ${result.notices.length}개` : ''}`,
        );
        onCommitted();
      } catch (error) {
        if (!alive.current) return;
        if (error instanceof NutritionRequestError && error.status >= 400 && error.status < 500) {
          setUncertain(null);
          setPreview(null);
          setPreviewInput(null);
          setConfirmed(false);
          setNotice(failure(error));
        } else {
          setUncertain(attempt);
          setNotice(
            '승인 결과를 확인할 수 없습니다. 입력을 잠갔습니다. 같은 요청·키로 결과를 다시 확인하세요.',
          );
        }
      }
    });
  }
  function save() {
    if (!confirmed || !previewInput || preview?.status !== 'projected' || stale || !supported)
      return;
    const body = nutritionPlanPublicApproveV4RequestSchema.parse({
      schemaVersion: 4,
      intent: {
        schemaVersion: 3,
        command: {
          kind: 'update',
          expectedHeadVersionId: previewInput.expectedHeadVersionId,
          confirmed: true,
          draft: previewInput.draft,
        },
        expectedRaceHeads: previewInput.expectedRaceHeads,
        reconnectItemIds: previewInput.reconnectItemIds,
      },
    });
    void approve({ body, key: newKey() });
  }
  return (
    <section className={styles.editor} aria-label="대회 연결 해제 항목 재연결">
      <h2>대회 항목 재연결과 별도 재승인</h2>
      <p>
        음식·수량·섭취 기록과 선택하지 않은 항목은 유지됩니다. 지원 여부는 처리 동의나 승인 권한을
        뜻하지 않습니다.
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {capabilities.isPending ? (
        <p role="status">재연결 지원 확인 중</p>
      ) : capabilities.isError ? (
        <p role="alert">재연결 지원을 확인하지 못했습니다. 원 승인본은 읽기 전용으로 보존됩니다.</p>
      ) : !supported ? (
        <p role="status">현재 연결은 V4 재연결·미저장 검토·승인을 모두 지원하지 않습니다.</p>
      ) : null}
      {draft === null ? (
        <p role="status">
          이 승인본에는 수동 재연결 계약 밖의 출처가 있습니다. 출처를 직접 입력으로 바꾸지 않고
          원본을 보존합니다.
        </p>
      ) : disconnected.length === 0 ? (
        <p>연결 해제 항목이 없습니다.</p>
      ) : (
        <Button disabled={!supported || busy || uncertain !== null} onClick={() => setOpen(true)}>
          연결 해제 항목 재연결 열기
        </Button>
      )}
      {stale ? (
        <div>
          <p role="alert">
            서버 기준 버전이 바뀌었습니다. 재연결 입력을 유지했으며 승인할 수 없습니다.
          </p>
          <Button
            disabled={busy || uncertain !== null}
            onClick={() => {
              if (latestRecord) {
                setBaseline(latestRecord);
                setSelected({});
                invalidate();
                setOpen(false);
              }
            }}
          >
            최신 승인본으로 입력 초기화
          </Button>
        </div>
      ) : null}
      {open && draft ? (
        <div className={styles.form}>
          {races.isPending ? (
            <p role="status">본인 대회 목록 확인 중</p>
          ) : races.isError && !races.isFetchNextPageError ? (
            <div>
              <p role="alert">대회 목록을 불러오지 못했습니다. 선택한 입력은 유지됩니다.</p>
              <Button
                variant="secondary"
                disabled={races.isFetching}
                onClick={() => {
                  void races.refetch();
                }}
              >
                대회 목록 다시 불러오기
              </Button>
            </div>
          ) : null}
          {disconnected.map((item) => {
            const choice = Object.hasOwn(selected, item.id) ? selected[item.id] : undefined;
            return (
              <fieldset key={item.id} disabled={busy || uncertain !== null}>
                <legend>{item.title}</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={choice !== undefined}
                    onChange={(e) =>
                      change(
                        item.id,
                        e.target.checked
                          ? { eventId: '', point: 'start', offset: '0', race: null }
                          : null,
                      )
                    }
                  />
                  이 항목을 명시적으로 재연결
                </label>
                {choice ? (
                  <>
                    <label>
                      재연결할 본인 대회
                      <select
                        value={choice.eventId}
                        onChange={(e) =>
                          change(item.id, { ...choice, eventId: e.target.value, race: null })
                        }
                      >
                        <option value="">대회 선택</option>
                        {choice.eventId !== '' &&
                        !raceOptions.some((race) => race.id === choice.eventId) ? (
                          <option value={choice.eventId}>
                            {choice.race
                              ? `${choice.race.title} · ${choice.race.localDate} · ${choice.race.timezone}`
                              : '선택한 대회 · 현재 목록에 없음'}
                          </option>
                        ) : null}
                        {raceOptions.map((race) => (
                          <option key={race.id} value={race.id}>
                            {race.title} · {race.localDate} · {race.timezone}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      disabled={choice.eventId === ''}
                      onClick={() => confirmRace(item.id, choice)}
                    >
                      선택 대회 현재 버전 확인
                    </Button>
                    {choice.race ? (
                      <p>
                        확인한 대회 {choice.race.title} · revision {choice.race.revision} ·{' '}
                        {choice.race.localDate} · {choice.race.localStartTime ?? '시작 시각 미상'} ·{' '}
                        {choice.race.timezone}. 원 승인 pin은 변경하지 않습니다.
                      </p>
                    ) : null}
                    <label>
                      기준 지점
                      <select
                        value={choice.point}
                        onChange={(e) => {
                          const point = e.target.value;
                          if (point === 'start' || point === 'end')
                            change(item.id, { ...choice, point });
                        }}
                      >
                        <option value="start">시작</option>
                        <option value="end">종료 · 미해결 가능</option>
                      </select>
                    </label>
                    <label>
                      전후 분 (이전은 음수)
                      <input
                        type="number"
                        step="1"
                        value={choice.offset}
                        onChange={(e) => change(item.id, { ...choice, offset: e.target.value })}
                      />
                    </label>
                  </>
                ) : null}
              </fieldset>
            );
          })}
          {races.data ? (
            <div className={styles.paging}>
              <p role="status" aria-live="polite">
                {races.isFetchingNextPage
                  ? `불러온 본인 대회 ${raceOptions.length}개 · 다음 ${RECONNECT_RACE_PAGE_SIZE}개 불러오는 중`
                  : races.hasNextPage
                    ? `불러온 본인 대회 ${raceOptions.length}개 · 더 있습니다. 전체 목록이 아닙니다.`
                    : `본인 대회 ${raceOptions.length}개를 모두 불러왔습니다.`}
              </p>
              {races.isFetchNextPageError ? (
                <p role="alert">
                  {staleRaceCursor
                    ? '대회 목록이 바뀌어 다음 대회를 이어서 불러올 수 없습니다. 선택한 입력은 유지됩니다. 목록을 처음부터 다시 불러오세요.'
                    : '다음 대회를 불러오지 못했습니다. 이미 불러온 대회와 선택한 입력은 유지됩니다.'}
                </p>
              ) : null}
              {races.isFetchNextPageError && staleRaceCursor ? (
                <Button
                  variant="secondary"
                  disabled={races.isFetching}
                  onClick={() => {
                    void races.refetch();
                  }}
                >
                  대회 목록 처음부터 다시 불러오기
                </Button>
              ) : races.hasNextPage ? (
                <Button
                  variant="secondary"
                  disabled={races.isFetching}
                  onClick={() => {
                    void races.fetchNextPage();
                  }}
                >
                  {races.isFetchNextPageError
                    ? '다음 대회 다시 불러오기'
                    : `대회 더 보기 (최대 ${RECONNECT_RACE_PAGE_SIZE}개)`}
                </Button>
              ) : null}
            </div>
          ) : null}
          <Button
            disabled={
              busy ||
              stale ||
              uncertain !== null ||
              Object.keys(selected).length === 0 ||
              Object.values(selected).some((choice) => choice.race === null)
            }
            onClick={() => {
              void prepare();
            }}
          >
            재연결 영향 미저장 검토
          </Button>
          {preview ? (
            <section aria-label="재연결 미저장 비교">
              <h3>검토 결과 · 저장되지 않음</h3>
              <p>현재성 재검증 전이며 이 결과 자체는 승인 권한이 아닙니다.</p>
              {preview.status === 'unavailable' ? (
                <p>원본 또는 처리 기준 확인 불가</p>
              ) : (
                <>
                  <ul>
                    {preview.items.map((row) => (
                      <li key={row.itemId}>
                        {row.itemId} · {row.change} · 이전 {timing(row.before)} → 이후{' '}
                        {timing(row.after)}
                      </li>
                    ))}
                  </ul>
                  <p>
                    기간 {preview.after.period.from} ~ {preview.after.period.toInclusive} ·{' '}
                    {preview.after.timezone}
                  </p>
                  <ul>
                    {preview.after.items.map((item) => (
                      <li key={item.id}>
                        {item.title}
                        <p>{item.instructions}</p>
                        <ul>
                          {item.targets.map((target) => (
                            <li key={target.metric}>
                              {target.metric} 목표 {target.amount.min}–{target.amount.max}{' '}
                              {target.amount.unit} · {target.amount.basis}
                            </li>
                          ))}
                        </ul>
                        <ul>
                          {item.foods.map((food, index) => (
                            <li key={index}>
                              {food.description} · {food.quantity ?? '수량 미상'} {food.unit}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {preview.status !== 'unavailable' && preview.notices.length ? (
                <ul aria-label="유지된 미해결 안내">
                  {preview.notices.map((n) => (
                    <li key={`${n.itemId}:${n.code}`}>{n.code}</li>
                  ))}
                </ul>
              ) : null}
              {preview.blocks.length ? (
                <ul aria-label="재연결 차단 사유">
                  {preview.blocks.map((block, index) => (
                    <li key={index}>{block.code}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || stale || uncertain !== null || preview?.status !== 'projected'}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            미저장 비교와 재연결 항목을 확인했고 이 영양 계획을 별도로 재승인합니다. 실제 섭취
            확인이 아닙니다.
          </label>
          <Button
            disabled={
              busy || stale || !confirmed || uncertain !== null || preview?.status !== 'projected'
            }
            onClick={save}
          >
            {busy ? '승인 확인 중' : '재연결 영양 계획 명시 재승인'}
          </Button>
        </div>
      ) : null}
      {uncertain ? (
        <Button
          disabled={busy}
          onClick={() => {
            void approve(uncertain);
          }}
        >
          같은 요청과 키로 승인 결과 확인
        </Button>
      ) : null}
    </section>
  );
}

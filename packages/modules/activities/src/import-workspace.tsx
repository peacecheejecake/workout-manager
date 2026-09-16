'use client';

import { useEffect, useRef, useState } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  activityListSchema,
  activitySummarySchema,
  activityImportResultSchema,
  importActivitySchema,
  type Activity,
  type ActivityImport,
} from '@workout/contracts/activity';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import { StatusNotice } from '@workout/ui-foundation/status-notice';
import styles from './import-workspace.module.css';

interface Props {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
}
export function ImportWorkspace(props: Props) {
  return <Lifetime key={`${props.athleteId}:${props.sessionId}`} {...props} />;
}
function Lifetime(props: Props) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <Workspace {...props} />
    </QueryClientProvider>
  );
}
const exportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  imports: z.array(importActivitySchema).min(1).max(100),
});
function Workspace({ athleteId, sessionId, transport }: Props) {
  const client = useQueryClient();
  const fileRead = useRef(0);
  useEffect(
    () => () => {
      fileRead.current += 1;
    },
    [],
  );
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [imports, setImports] = useState<ActivityImport[]>([]);
  const [fileError, setFileError] = useState('');
  const [report, setReport] = useState<string[]>([]);
  const key = ['users', athleteId, 'sessions', sessionId, 'imported-activities'];
  const list = useQuery({
    queryKey: [...key, 'list', offset],
    queryFn: async ({ signal }) => {
      const result = await transport.request({
        path: `/bff/v1/activities?limit=20&offset=${offset}`,
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal,
      });
      if (result.status !== 200) throw new Error('LIST_UNAVAILABLE');
      return activityListSchema.parse(result.body);
    },
  });
  const summary = useQuery({
    queryKey: [...key, 'summary'],
    queryFn: async ({ signal }) => {
      const result = await transport.request({
        path: '/bff/v1/activities/summary',
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal,
      });
      if (result.status !== 200) throw new Error('SUMMARY_UNAVAILABLE');
      return activitySummarySchema.parse(result.body);
    },
  });
  const upload = useMutation({
    mutationFn: async (commands: ActivityImport[]) => {
      const results: string[] = [];
      for (const item of commands) {
        const { idempotencyKey, ...body } = item;
        const result = await transport.request({
          path: '/bff/v1/activity-imports',
          method: 'POST',
          body,
          idempotencyKey,
        });
        if (result.status !== 200) throw new Error('IMPORT_UNCONFIRMED');
        const receipt = activityImportResultSchema.parse(result.body);
        results.push(
          (
            {
              imported: '저장',
              unchanged: '중복 유지',
              stale: '이전 revision 유지',
              suppressed: '삭제 억제',
            } as const
          )[receipt.outcome],
        );
        setReport([...results]);
      }
    },
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: key });
    },
  });
  const current = list.data?.items.find((item) => item.id === selected);
  return (
    <div className={styles.workspace}>
      <section aria-labelledby="import-heading">
        <h2 id="import-heading">활동 가져오기</h2>
        <p>
          FIT 변환 도구의 활동 JSON을 선택하고 확인 후 저장하세요. 공식 자동 동기화는 연결되지
          않았습니다.
        </p>
        <label>
          가져올 활동 JSON{' '}
          <input
            type="file"
            accept="application/json,.json"
            disabled={upload.isPending}
            onChange={(event) => {
              const generation = ++fileRead.current;
              const file = event.target.files?.[0];
              setImports([]);
              setReport([]);
              setFileError('');
              upload.reset();
              if (!file) return;
              if (file.size > 1024 * 1024) {
                setFileError('파일은 1 MiB 이하여야 합니다.');
                return;
              }
              void file
                .text()
                .then((text) => {
                  if (generation !== fileRead.current) return;
                  const parsed = exportSchema.parse(JSON.parse(text));
                  setImports(parsed.imports);
                })
                .catch(() => {
                  if (generation === fileRead.current)
                    setFileError('지원하는 활동 JSON 파일이 아닙니다.');
                });
            }}
          />
        </label>
        {fileError ? <p role="alert">{fileError}</p> : null}
        {imports.length ? (
          <>
            <p>가져오기 미리보기: {imports.length}개 세션</p>
            <ul>
              {imports.map((item, index) => (
                <li key={`${item.idempotencyKey}:${index}`}>
                  {item.activity.title ?? '제목 미확인'} ·{' '}
                  {item.activity.durationSeconds === null
                    ? '시간 미확인'
                    : `${item.activity.durationSeconds}초`}{' '}
                  · {item.source.kind}
                </li>
              ))}
            </ul>
            <Button disabled={upload.isPending} onClick={() => upload.mutate(imports)}>
              확인하고 가져오기
            </Button>
          </>
        ) : null}
        {upload.isPending ? <p role="status">활동을 저장하고 있습니다.</p> : null}
        {upload.isError ? (
          <p role="alert">
            일부 저장 결과를 확인하지 못했습니다. 같은 파일로 재시도하면 이미 저장한 세션은 중복
            생성하지 않습니다.
          </p>
        ) : null}
        {report.length ? <p role="status">처리 결과: {report.join(', ')}</p> : null}
      </section>
      <section aria-labelledby="records-heading">
        <h2 id="records-heading">가져온 활동</h2>
        {summary.isError ? (
          <StatusNotice
            state="error"
            action={<Button onClick={() => void summary.refetch()}>집계 다시 확인</Button>}
          >
            활동 집계를 확인하지 못했습니다.
          </StatusNotice>
        ) : null}
        {summary.data && !summary.isError ? (
          <p>
            기록 {summary.data.count}개 · 알려진 거리 합계{' '}
            {summary.data.distanceMeters.value === null
              ? '미확인'
              : `${summary.data.distanceMeters.value}m`}{' '}
            ({summary.data.distanceMeters.knownCount}개 관측)
          </p>
        ) : null}
        {list.isPending ? <StatusNotice state="loading">활동을 불러옵니다.</StatusNotice> : null}
        {list.isError ? (
          <StatusNotice
            state="error"
            action={<Button onClick={() => void list.refetch()}>다시 불러오기</Button>}
          >
            활동을 확인하지 못했습니다.
          </StatusNotice>
        ) : null}
        {list.data?.items.length === 0 ? (
          <StatusNotice state="empty">가져온 활동이 없습니다.</StatusNotice>
        ) : null}
        <ul className={styles.records}>
          {list.data?.items.map((item) => (
            <li key={item.id}>
              <Button
                variant="secondary"
                aria-pressed={selected === item.id}
                onClick={() => setSelected(item.id)}
              >
                {item.effective.title ?? '제목 미확인'}
              </Button>
              <p>
                {item.effective.startedAt ?? '시작 시각 미확인'} ·{' '}
                {item.effective.durationSeconds === null
                  ? '시간 미확인'
                  : `${item.effective.durationSeconds}초`}{' '}
                ({item.effective.durationKind}) ·{' '}
                {item.effective.distanceMeters === null
                  ? '거리 미확인'
                  : `${item.effective.distanceMeters}m`}
              </p>
            </li>
          ))}
        </ul>
        <Button
          variant="secondary"
          disabled={offset === 0}
          onClick={() => {
            setOffset(Math.max(0, offset - 20));
            setSelected(null);
          }}
        >
          이전 활동
        </Button>
        <Button
          variant="secondary"
          disabled={!list.data || offset + 20 >= list.data.total}
          onClick={() => {
            setOffset(offset + 20);
            setSelected(null);
          }}
        >
          다음 활동
        </Button>
      </section>
      {current ? (
        <Correction
          key={current.id}
          activity={current}
          transport={transport}
          changed={async () => {
            await client.invalidateQueries({ queryKey: key });
          }}
        />
      ) : null}
    </div>
  );
}
function Correction({
  activity,
  transport,
  changed,
}: {
  activity: Activity;
  transport: AuthenticatedTransport;
  changed: () => Promise<void>;
}) {
  const [title, setTitle] = useState(activity.effective.title ?? '');
  const [distance, setDistance] = useState(activity.effective.distanceMeters?.toString() ?? '');
  const [reason, setReason] = useState('');
  const [revision, setRevision] = useState(activity.revision);
  const [pendingCommand, setPendingCommand] = useState<{
    key: string;
    title: string | null;
    distanceMeters: number | null;
    reason: string;
    expectedRevision: number;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const correction = useMutation({
    mutationFn: async (command: NonNullable<typeof pendingCommand>) => {
      const { key, ...body } = command;
      const result = await transport.request({
        path: `/bff/v1/activities/${activity.id}`,
        method: 'PATCH',
        body,
        idempotencyKey: key,
      });
      if (result.status !== 200)
        throw new Error(result.status === 409 ? 'CONFLICT' : 'UNCONFIRMED');
    },
    onSuccess: async () => {
      setPendingCommand(null);
      await changed();
    },
    onError: changed,
  });
  const deletion = useMutation({
    mutationFn: async (expectedRevision: number) => {
      const result = await transport.request({
        path: `/bff/v1/activities/${activity.id}`,
        method: 'DELETE',
        body: { expectedRevision },
        idempotencyKey: null,
      });
      if (result.status !== 204)
        throw new Error(result.status === 409 ? 'DELETE_CONFLICT' : 'DELETE_UNCONFIRMED');
    },
    onSuccess: changed,
    onError: async (error) => {
      if (error.message === 'DELETE_CONFLICT') setConfirmDelete(null);
      await changed();
    },
  });
  const busy = correction.isPending || deletion.isPending;
  return (
    <section aria-labelledby="correction-heading">
      <h2 id="correction-heading">활동 정정과 출처</h2>
      <p>
        출처 {activity.source.kind} · 원본 revision {activity.source.revision} · 정정 revision{' '}
        {activity.revision}
      </p>
      <p>
        원본 거리:{' '}
        {activity.original.distanceMeters === null
          ? '미확인'
          : `${activity.original.distanceMeters}m`}
        . 정정은 원본을 덮어쓰지 않습니다.
      </p>
      <TextField
        disabled={busy}
        label="정정 제목"
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          setPendingCommand(null);
        }}
      />
      <TextField
        disabled={busy}
        label="정정 거리 (m)"
        type="number"
        min="0"
        value={distance}
        onChange={(event) => {
          setDistance(event.target.value);
          setPendingCommand(null);
        }}
        description="빈 값은 미확인, 0은 관측된 0입니다."
      />
      <TextField
        disabled={busy}
        label="정정 사유"
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
          setPendingCommand(null);
        }}
      />
      <Button
        disabled={
          busy ||
          revision !== activity.revision ||
          !reason.trim() ||
          (distance !== '' && (!Number.isFinite(Number(distance)) || Number(distance) < 0))
        }
        onClick={() => {
          const command = pendingCommand ?? {
            key: crypto.randomUUID(),
            title: title.trim() || null,
            distanceMeters: distance === '' ? null : Number(distance),
            reason,
            expectedRevision: revision,
          };
          setPendingCommand(command);
          correction.mutate(command);
        }}
      >
        정정 저장
      </Button>
      {correction.isSuccess ? (
        <p role="status">정정 요청이 저장되었습니다. 최신 원본과 정정을 다시 확인하세요.</p>
      ) : null}
      {correction.isError ? (
        <p role="alert">
          정정 결과를 확인하지 못했습니다. 충돌 시 초안을 유지한 채 최신 revision으로 다시
          검토하세요.
        </p>
      ) : null}
      {revision !== activity.revision ? (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setRevision(activity.revision);
            setPendingCommand(null);
            correction.reset();
          }}
        >
          최신 revision으로 재검토
        </Button>
      ) : null}
      <Button
        variant="danger"
        disabled={busy}
        onClick={() => {
          deletion.reset();
          setConfirmDelete(activity.revision);
        }}
      >
        로컬 삭제
      </Button>
      {confirmDelete !== null ? (
        <div>
          <p>이 앱에서 삭제하고 같은 출처의 재수집을 막습니다. 공급자 원본은 삭제하지 않습니다.</p>
          <p>삭제 확인 revision: {confirmDelete}</p>
          {confirmDelete !== activity.revision ? (
            <p role="alert">활동이 변경되었습니다. 취소 후 최신 내용을 검토하고 다시 삭제하세요.</p>
          ) : null}
          <Button
            variant="danger"
            disabled={busy || confirmDelete !== activity.revision}
            onClick={() => deletion.mutate(confirmDelete)}
          >
            삭제 확인
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setConfirmDelete(null)}>
            취소
          </Button>
        </div>
      ) : null}
      {deletion.isError ? (
        <p role="alert">삭제를 확인하지 못했습니다. 최신 활동을 확인하고 재시도하세요.</p>
      ) : null}
    </section>
  );
}

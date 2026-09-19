'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { QueryClient, QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import type {
  PrivateTextResourceCategory,
  PrivateTextResourceCreate,
  PrivateTextResourceReadResult,
} from '@workout/contracts/resources';
import { AdaptiveWorkspace } from '@workout/ui-foundation/adaptive-workspace';
import { createResourceApi, ResourceRequestError } from './resource-api';
import styles from './resources.module.css';

export interface ResourceWorkspaceProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  resourceId?: string | null;
  versionId?: string | null;
}

export function ResourceWorkspace(props: ResourceWorkspaceProps) {
  return <Lifetime key={`${props.athleteId}:${props.sessionId}`} {...props} />;
}

function Lifetime(props: ResourceWorkspaceProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <Workspace {...props} />
    </QueryClientProvider>
  );
}

function useIdempotencyKeys() {
  const keys = useRef(new Map<string, string>());
  return {
    get(payload: unknown) {
      const fingerprint = JSON.stringify(payload);
      const current = keys.current.get(fingerprint);
      if (current) return current;
      const created = crypto.randomUUID();
      keys.current.set(fingerprint, created);
      return created;
    },
    clear(payload: unknown) {
      keys.current.delete(JSON.stringify(payload));
    },
  };
}

function readableError(error: unknown) {
  if (!(error instanceof ResourceRequestError)) return '요청을 완료하지 못했습니다.';
  if (error.status === 409) return '다른 변경이 먼저 저장되었습니다. 최신 버전을 다시 확인하세요.';
  if (error.status === 413) return '본문이 허용된 64 KiB 범위를 넘었습니다.';
  if (error.status === 404) return '자료를 찾을 수 없거나 열람 권한이 없습니다.';
  return '입력을 확인한 뒤 다시 시도하세요.';
}

function Workspace({
  athleteId,
  sessionId,
  transport,
  resourceId = null,
  versionId = null,
}: ResourceWorkspaceProps) {
  const api = useMemo(() => createResourceApi(transport), [transport]);
  const scope = ['users', athleteId, 'sessions', sessionId, 'resources'] as const;
  const list = useQuery({
    queryKey: [...scope, 'list'],
    queryFn: ({ signal }) => api.list({ limit: 50, offset: 0 }, signal),
  });
  const detail = useQuery({
    queryKey: [...scope, 'detail', resourceId, versionId],
    queryFn: ({ signal }) => api.read(resourceId ?? '', versionId ?? undefined, signal),
    enabled: resourceId !== null,
  });
  return (
    <section className={styles.workspace} aria-label="개인 자료 작업 공간">
      <header className={styles.header}>
        <p className={styles.eyebrow}>자료실 · private text 기반</p>
        <h1>자료실</h1>
        <p>
          직접 입력한 원문을 불변 버전으로 보관합니다. 현재 단위는 검색·RAG에 연결되지 않으며 코치
          사용도 꺼져 있습니다.
        </p>
      </header>
      <AdaptiveWorkspace requestedView="split">
        <section className={styles.panel} aria-labelledby="resource-list-title">
          <h2 id="resource-list-title">내 자료</h2>
          <CreateForm api={api} />
          {list.isPending ? <p role="status">자료 목록을 불러오는 중</p> : null}
          {list.isError ? (
            <div role="alert" className={styles.notice}>
              <p>자료 목록을 불러오지 못했습니다.</p>
              <button onClick={() => void list.refetch()}>다시 시도</button>
            </div>
          ) : null}
          {list.data?.items.length === 0 ? <p>저장한 자료가 없습니다.</p> : null}
          <div className={styles.stack}>
            {list.data?.items.map((resource) => (
              <article
                key={resource.id}
                className={styles.card}
                aria-current={resource.id === resourceId ? 'page' : undefined}
              >
                <h3>
                  <a href={`/resources/${resource.id}`}>{resource.title}</a>
                </h3>
                <p className={styles.meta}>
                  {categoryLabel(resource.category)} · 버전 고정 가능 ·{' '}
                  {resource.favorite ? '별표' : '별표 없음'}
                </p>
                <p className={styles.status}>파싱 완료 · 검색 색인 안 됨 · 코치 사용 안 함</p>
              </article>
            ))}
          </div>
        </section>
        <section className={styles.panel} aria-labelledby="resource-reader-title">
          <h2 id="resource-reader-title">자료 읽기</h2>
          {resourceId === null ? (
            <p>목록에서 자료를 선택하면 고정된 원문 버전과 문단 위치를 확인할 수 있습니다.</p>
          ) : detail.isPending ? (
            <p role="status">자료 원문을 불러오는 중</p>
          ) : detail.isError ? (
            <div role="alert" className={styles.notice}>
              <p>{readableError(detail.error)}</p>
              <button onClick={() => void detail.refetch()}>다시 시도</button>
            </div>
          ) : detail.data ? (
            <Reader read={detail.data} api={api} requestedVersionId={versionId} />
          ) : null}
        </section>
      </AdaptiveWorkspace>
    </section>
  );
}

type ResourceApi = ReturnType<typeof createResourceApi>;

function CreateForm({ api }: { api: ResourceApi }) {
  const keys = useIdempotencyKeys();
  const mutation = useMutation({
    mutationFn: (input: PrivateTextResourceCreate) => api.create(input),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const payload = {
      sourceKind: 'text' as const,
      title: String(fields.get('title') ?? ''),
      category: String(fields.get('category') ?? 'note') as PrivateTextResourceCategory,
      metadata: {},
      tags: [],
      favorite: false,
      text: String(fields.get('text') ?? ''),
    };
    const input = { ...payload, idempotencyKey: keys.get(payload) };
    mutation.mutate(input, {
      onSuccess(result) {
        keys.clear(payload);
        if (result.status === 'available')
          window.location.assign(`/resources/${result.resource.id}`);
      },
    });
  }
  return (
    <form className={styles.form} onSubmit={submit} aria-label="텍스트 자료 만들기">
      <label>
        제목
        <input name="title" required maxLength={200} />
      </label>
      <label>
        분류
        <select name="category" defaultValue="note">
          <option value="note">개인 메모</option>
          <option value="paper">논문</option>
          <option value="guide">가이드</option>
          <option value="race_material">대회 자료</option>
        </select>
      </label>
      <label>
        원문
        <textarea name="text" required maxLength={65_536} />
      </label>
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? '저장 중' : 'private 자료 저장'}
      </button>
      {mutation.isError ? <p role="alert">{readableError(mutation.error)}</p> : null}
    </form>
  );
}

function Reader({
  read,
  api,
  requestedVersionId,
}: {
  read: PrivateTextResourceReadResult;
  api: ResourceApi;
  requestedVersionId: string | null;
}) {
  if (read.status === 'unavailable') {
    return <p role="alert">자료를 찾을 수 없거나 열람 권한이 없습니다.</p>;
  }
  if (read.status === 'deleted') {
    return <p role="alert">삭제된 자료입니다. 이전 버전 원문도 더 이상 열 수 없습니다.</p>;
  }
  return (
    <article>
      <h3>{read.resource.title}</h3>
      <p className={styles.status}>
        원문 버전 {read.version.version} · 파싱 완료 · 검색 색인 안 됨 · 코치 사용 안 함
      </p>
      <p className={styles.meta}>
        이 화면은 AI 요약이나 인용이 아닙니다. 문단 위치는 이 버전에만 고정됩니다.
      </p>
      {requestedVersionId === null && read.version.previousVersionId ? (
        <p>
          <a href={`/resources/${read.resource.id}?version=${read.version.previousVersionId}`}>
            이전 버전 열기
          </a>
        </p>
      ) : (
        <p>
          <a href={`/resources/${read.resource.id}`}>현재 버전 열기</a>
        </p>
      )}
      <ol className={styles.paragraphs}>
        {read.reader.paragraphs.map((paragraph) => (
          <li
            className={styles.paragraph}
            id={`paragraph-${paragraph.locator.index + 1}`}
            key={paragraph.locator.index}
          >
            <a
              href={`#paragraph-${paragraph.locator.index + 1}`}
              aria-label={`문단 ${paragraph.locator.index + 1} 링크`}
            >
              ¶{paragraph.locator.index + 1}
            </a>{' '}
            {paragraph.text}
          </li>
        ))}
      </ol>
      <AppendForm read={read} api={api} />
      <DeleteForm read={read} api={api} />
    </article>
  );
}

function AppendForm({
  read,
  api,
}: {
  read: Extract<PrivateTextResourceReadResult, { status: 'available' }>;
  api: ResourceApi;
}) {
  const keys = useIdempotencyKeys();
  const mutation = useMutation({
    mutationFn: (input: { text: string; idempotencyKey: string }) =>
      api.append(read.resource.id, {
        expectedCurrentVersionId: read.resource.currentVersionId,
        ...input,
      }),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get('text') ?? '');
    const payload = { expectedCurrentVersionId: read.resource.currentVersionId, text };
    mutation.mutate(
      { text, idempotencyKey: keys.get(payload) },
      {
        onSuccess(result) {
          keys.clear(payload);
          if (result.status === 'available')
            window.location.assign(`/resources/${result.resource.id}`);
        },
      },
    );
  }
  return (
    <form className={styles.form} onSubmit={submit} aria-label="새 자료 버전 저장">
      <h4>새 버전</h4>
      <label>
        수정한 원문
        <textarea name="text" required defaultValue={read.reader.originalText} maxLength={65_536} />
      </label>
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? '버전 저장 중' : '새 버전 저장'}
      </button>
      {mutation.isError ? <p role="alert">{readableError(mutation.error)}</p> : null}
    </form>
  );
}

function DeleteForm({
  read,
  api,
}: {
  read: Extract<PrivateTextResourceReadResult, { status: 'available' }>;
  api: ResourceApi;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const keys = useIdempotencyKeys();
  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        expectedAccessRevision: read.resource.accessRevision,
        expectedCurrentVersionId: read.resource.currentVersionId,
      };
      return api.delete(read.resource.id, { ...payload, idempotencyKey: keys.get(payload) });
    },
  });
  return (
    <section className={styles.notice} aria-labelledby="resource-delete-title">
      <h4 id="resource-delete-title">자료 삭제</h4>
      <p>삭제하면 현재 원문과 모든 과거 버전 reader가 즉시 차단됩니다.</p>
      <div className={styles.actions}>
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.currentTarget.checked)}
          />{' '}
          삭제 결과를 확인했습니다
        </label>
        <button
          type="button"
          disabled={!confirmed || mutation.isPending}
          onClick={() =>
            mutation.mutate(undefined, { onSuccess: () => window.location.assign('/resources') })
          }
        >
          {mutation.isPending ? '삭제 중' : '자료 삭제'}
        </button>
      </div>
      {mutation.isError ? <p role="alert">{readableError(mutation.error)}</p> : null}
    </section>
  );
}

function categoryLabel(category: PrivateTextResourceCategory) {
  return {
    paper: '논문',
    guide: '가이드',
    note: '개인 메모',
    race_material: '대회 자료',
  }[category];
}

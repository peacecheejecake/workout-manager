'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  PRIVATE_RESOURCE_MARKDOWN_MAX_BYTES,
  PRIVATE_RESOURCE_PDF_MAX_BYTES,
  type PrivateFileResourceMediaType,
  type PrivateFileResourceReadResult,
  type PrivateResourceListItem,
  type PrivateResourceAccessState,
  type PrivateResourceReadResult,
  type PrivateTextResourceCategory,
  type PrivateTextResourceCreate,
  type PrivateTextResourceReadResult,
  type PrivateUrlResourceFailure,
  type PrivateUrlResourceIngestion,
  type PrivateUrlResourceIngestionRecord,
  type PrivateUrlResourceReadResult,
} from '@workout/contracts/resources';
import { AdaptiveWorkspace } from '@workout/ui-foundation/adaptive-workspace';
import { createResourceApi, ResourceRequestError } from './resource-api';
import styles from './resources.module.css';

export interface ResourceFileUploadInput {
  uploadId: string;
  file: File;
  mediaType: PrivateFileResourceMediaType;
  signal: AbortSignal;
  onProgress: (uploadedBytes: number, totalBytes: number) => void;
}

export interface ResourceFileOpenInput {
  resourceId: string;
  versionId: string;
  fileName: string;
  signal: AbortSignal;
}

export interface ResourceFileTransfer {
  upload(input: ResourceFileUploadInput): Promise<void>;
  open(input: ResourceFileOpenInput): Promise<void>;
}

export interface ResourceWorkspaceProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  fileTransfer?: ResourceFileTransfer;
  resourceId?: string | null;
  versionId?: string | null;
}

type ResourceApi = ReturnType<typeof createResourceApi>;
type TextAvailableRead = Extract<PrivateTextResourceReadResult, { status: 'available' }>;
type FileAvailableRead = Extract<PrivateFileResourceReadResult, { status: 'available' }>;
type UrlAvailableRead = Extract<PrivateUrlResourceReadResult, { status: 'available' }>;
type AvailableRead = Extract<PrivateResourceReadResult, { status: 'available' }>;
type UploadStage = 'idle' | 'reserving' | 'uploading' | 'finalizing';

const FILE_ACCEPT = '.pdf,.md,.markdown,application/pdf,text/markdown';
const byteFormatter = new Intl.NumberFormat('ko-KR');

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

function useRequestAbortController() {
  const current = useRef<AbortController | null>(null);
  useEffect(() => () => current.current?.abort(), []);
  return () => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    return controller;
  };
}

function readableError(error: unknown, kind: 'text' | 'file' | 'url' = 'text') {
  if (!(error instanceof ResourceRequestError)) return '요청을 완료하지 못했습니다.';
  if (error.status === 409) return '다른 변경이 먼저 저장되었습니다. 최신 버전을 다시 확인하세요.';
  if (error.status === 413) {
    if (kind === 'file')
      return '파일이 허용된 크기를 넘었습니다. PDF는 10 MiB, Markdown은 1 MiB까지 저장할 수 있습니다.';
    if (kind === 'url') return '가져올 URL 자료가 허용된 처리 범위를 넘었습니다.';
    return '본문이 허용된 64 KiB 범위를 넘었습니다.';
  }
  if (error.status === 404) return '자료를 찾을 수 없거나 열람 권한이 없습니다.';
  return '입력을 확인한 뒤 다시 시도하세요.';
}

function requiresFreshUploadIntent(error: unknown) {
  return error instanceof Error && error.message === 'UPLOAD_RETRY_REQUIRED';
}

function Workspace({
  athleteId,
  sessionId,
  transport,
  fileTransfer,
  resourceId = null,
  versionId = null,
}: ResourceWorkspaceProps) {
  const api = useMemo(() => createResourceApi(transport), [transport]);
  const scope = useMemo(
    () => ['users', athleteId, 'sessions', sessionId, 'resources'] as const,
    [athleteId, sessionId],
  );
  const listQueryKey = useMemo(() => [...scope, 'list'] as const, [scope]);
  const list = useQuery({
    queryKey: listQueryKey,
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
        <p className={styles.eyebrow}>자료실 · private 원문 보관</p>
        <h1>자료실</h1>
        <p>
          직접 입력한 원문, PDF·Markdown 파일, HTTPS 자료를 불변 버전으로 보관합니다. 저장이나 파싱
          완료는 검토·검색 색인·코치 사용 승격을 뜻하지 않습니다.
        </p>
      </header>
      <AdaptiveWorkspace requestedView="split">
        <section className={styles.panel} aria-labelledby="resource-list-title">
          <h2 id="resource-list-title">내 자료</h2>
          <div className={styles.modeGrid}>
            <TextCreateForm api={api} />
            <FileCreateForm api={api} fileTransfer={fileTransfer} />
            <UrlIngestionPanel api={api} resourceScope={scope} />
          </div>
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
                  {sourceKindLabel(resource.sourceKind)} · {categoryLabel(resource.category)} · 버전
                  고정 가능 · {resource.favorite ? '별표' : '별표 없음'}
                </p>
                <p className={styles.status}>{lifecycleLabel(resource)}</p>
              </article>
            ))}
          </div>
        </section>
        <section className={styles.panel} aria-labelledby="resource-reader-title">
          <h2 id="resource-reader-title">자료 읽기</h2>
          {resourceId === null ? (
            <p>
              목록에서 자료를 선택하면 고정된 원문, 파일 설명 또는 URL 처리 상태를 확인할 수
              있습니다.
            </p>
          ) : detail.isPending ? (
            <p role="status">자료를 불러오는 중</p>
          ) : detail.isError ? (
            <div role="alert" className={styles.notice}>
              <p>{readableError(detail.error)}</p>
              <button onClick={() => void detail.refetch()}>다시 시도</button>
            </div>
          ) : detail.data ? (
            <>
              <Reader
                read={detail.data}
                api={api}
                fileTransfer={fileTransfer}
                requestedVersionId={versionId}
              />
              {detail.data.status === 'available' ? (
                <AccessPanel resourceId={detail.data.resource.id} api={api} scope={scope} />
              ) : null}
            </>
          ) : null}
        </section>
      </AdaptiveWorkspace>
    </section>
  );
}

function TextCreateForm({ api }: { api: ResourceApi }) {
  const keys = useIdempotencyKeys();
  const mutation = useMutation({
    mutationFn: (input: PrivateTextResourceCreate) => api.createText(input),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const payload = {
      sourceKind: 'text' as const,
      title: String(fields.get('title') ?? ''),
      category: String(fields.get('category') ?? 'note') as PrivateTextResourceCategory,
      metadata: {},
      tags: [],
      favorite: false,
      text: String(fields.get('text') ?? ''),
    };
    mutation.mutate(
      { ...payload, idempotencyKey: keys.get(payload) },
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
    <form className={styles.form} onSubmit={submit} aria-label="텍스트 자료 만들기">
      <h3>텍스트 원문</h3>
      <ResourceMetadataFields idPrefix="text-create" />
      <label>
        원문
        <textarea name="text" required maxLength={65_536} />
      </label>
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? '저장 중' : '텍스트 자료 저장'}
      </button>
      {mutation.isError ? <p role="alert">{readableError(mutation.error)}</p> : null}
    </form>
  );
}

function FileCreateForm({
  api,
  fileTransfer,
}: {
  api: ResourceApi;
  fileTransfer: ResourceFileTransfer | undefined;
}) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [stage, setStage] = useState<UploadStage>('idle');
  const [progress, setProgress] = useState(0);
  const keys = useIdempotencyKeys();
  const nextController = useRequestAbortController();
  const form = useRef<HTMLFormElement | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!fileTransfer || !selectedFile || !form.current) throw new Error('UPLOAD_UNAVAILABLE');
      const fields = new FormData(form.current);
      const metadata = {
        sourceKind: 'file' as const,
        title: String(fields.get('title') ?? ''),
        category: String(fields.get('category') ?? 'note') as PrivateTextResourceCategory,
        metadata: {},
        tags: [],
        favorite: false,
      };
      const fingerprint = { ...metadata, file: fileFingerprint(selectedFile) };
      const controller = nextController();
      setStage('reserving');
      setProgress(0);
      let reservation = await api.reserveCreateUpload({
        ...metadata,
        idempotencyKey: keys.get(fingerprint),
      });
      if (reservation.state === 'failed') {
        keys.clear(fingerprint);
        reservation = await api.reserveCreateUpload({
          ...metadata,
          idempotencyKey: keys.get(fingerprint),
        });
      }
      if (reservation.state === 'reserved' || reservation.state === 'prepared') {
        setStage('uploading');
        try {
          await fileTransfer.upload({
            uploadId: reservation.uploadId,
            file: selectedFile,
            mediaType: fileMediaType(selectedFile),
            signal: controller.signal,
            onProgress: (uploadedBytes, totalBytes) => {
              if (!controller.signal.aborted)
                setProgress(
                  totalBytes === 0 ? 0 : Math.min(100, (uploadedBytes / totalBytes) * 100),
                );
            },
          });
        } catch (error) {
          if (requiresFreshUploadIntent(error)) keys.clear(fingerprint);
          throw error;
        }
      }
      setStage('finalizing');
      const result = await api.finalizeUpload(reservation.uploadId);
      keys.clear(fingerprint);
      return result;
    },
  });

  function selectFile(file: File | null) {
    mutation.reset();
    setStage('idle');
    setProgress(0);
    const issue = file ? fileSelectionError(file) : null;
    setSelectionError(issue);
    setSelectedFile(issue ? null : file);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile) {
      setSelectionError('PDF 또는 Markdown 파일을 선택하세요.');
      return;
    }
    mutation.mutate(undefined, {
      onSuccess(result) {
        if (result.status === 'available')
          window.location.assign(`/resources/${result.resource.id}`);
      },
    });
  }

  return (
    <form ref={form} className={styles.form} onSubmit={submit} aria-label="파일 자료 만들기">
      <h3>PDF·Markdown 파일</h3>
      <ResourceMetadataFields idPrefix="file-create" />
      <label>
        원본 파일
        <input
          name="file"
          type="file"
          accept={FILE_ACCEPT}
          required
          disabled={fileTransfer === undefined || mutation.isPending}
          onChange={(event) => selectFile(event.currentTarget.files?.[0] ?? null)}
        />
      </label>
      <p className={styles.hint}>PDF는 10 MiB, Markdown은 1 MiB까지 선택할 수 있습니다.</p>
      {fileTransfer === undefined ? (
        <p role="status" className={styles.notice}>
          현재 실행 환경에서는 인증된 파일 전송을 지원하지 않습니다.
        </p>
      ) : null}
      {selectionError ? <p role="alert">{selectionError}</p> : null}
      <button type="submit" disabled={fileTransfer === undefined || mutation.isPending}>
        {mutation.isPending
          ? uploadStageLabel(stage, progress)
          : mutation.isError
            ? '파일 업로드 다시 시도'
            : '원본 파일 업로드'}
      </button>
      {mutation.isPending && stage === 'uploading' ? (
        <progress aria-label="원본 파일 업로드 진행률" max={100} value={progress}>
          {Math.round(progress)}%
        </progress>
      ) : null}
      {mutation.isError ? (
        <p role="alert">
          {readableError(mutation.error, 'file')} 선택한 파일은 유지되었습니다. 같은 작업을 다시
          시도할 수 있습니다.
        </p>
      ) : null}
      <p className={styles.status}>
        업로드 후 상태: 원본 저장됨 · 본문 파싱 안 됨 · 검색 색인 안 됨
      </p>
    </form>
  );
}

function UrlIngestionPanel({
  api,
  resourceScope,
}: {
  api: ResourceApi;
  resourceScope: readonly unknown[];
}) {
  const [selectedIngestionId, setSelectedIngestionId] = useState<string | null>(null);
  return (
    <section className={styles.urlPanel} aria-labelledby="url-ingestion-title">
      <UrlCreateForm api={api} resourceScope={resourceScope} onCreated={setSelectedIngestionId} />
      {selectedIngestionId ? (
        <UrlIngestionStatus
          key={selectedIngestionId}
          api={api}
          ingestionId={selectedIngestionId}
          resourceScope={resourceScope}
        />
      ) : null}
    </section>
  );
}

function UrlCreateForm({
  api,
  resourceScope,
  onCreated,
}: {
  api: ResourceApi;
  resourceScope: readonly unknown[];
  onCreated: (ingestionId: string) => void;
}) {
  const form = useRef<HTMLFormElement | null>(null);
  const keys = useIdempotencyKeys();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: Parameters<ResourceApi['createUrlIngestion']>[0]) =>
      api.createUrlIngestion(input),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const payload = {
      sourceKind: 'url' as const,
      title: String(fields.get('title') ?? ''),
      category: String(fields.get('category') ?? 'note') as PrivateTextResourceCategory,
      metadata: {},
      tags: [],
      favorite: false,
      url: String(fields.get('url') ?? ''),
    };
    mutation.mutate(
      { ...payload, idempotencyKey: keys.get(payload) },
      {
        onSuccess(record) {
          keys.clear(payload);
          queryClient.setQueryData([...resourceScope, 'url-ingestion', record.ingestionId], record);
          onCreated(record.ingestionId);
          form.current?.reset();
          mutation.reset();
        },
      },
    );
  }

  return (
    <form ref={form} className={styles.form} onSubmit={submit} aria-label="URL 자료 가져오기">
      <h3 id="url-ingestion-title">HTTPS URL</h3>
      <ResourceMetadataFields idPrefix="url-create" />
      <label htmlFor="url-create-url">
        자료 URL
        <input
          id="url-create-url"
          name="url"
          type="url"
          inputMode="url"
          required
          pattern="https://.*"
          maxLength={2048}
          placeholder="https://example.com/article"
        />
      </label>
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'URL 등록 중' : 'URL 자료 가져오기'}
      </button>
      {mutation.isError ? (
        <p role="alert">
          {readableError(mutation.error, 'url')} 입력한 제목과 URL은 유지되었습니다.
        </p>
      ) : null}
      <p className={styles.status}>
        등록 후에도 private · 미검토 · 검색 색인 안 됨 · 코치 사용 안 함 상태를 유지합니다.
      </p>
    </form>
  );
}

const ACTIVE_URL_INGESTION_STATES = new Set(['queued', 'fetching', 'parsing']);
const MAX_URL_STATUS_REQUESTS = 3000;
const MAX_URL_RETRY_POLL_INTERVAL_MS = 30_000;

function isUrlIngestionActive(lifecycle: PrivateUrlResourceIngestion) {
  return (
    ACTIVE_URL_INGESTION_STATES.has(lifecycle.contentStatus) ||
    (lifecycle.contentStatus === 'failed' && lifecycle.failure.retryable)
  );
}

function UrlIngestionStatus({
  api,
  ingestionId,
  resourceScope,
}: {
  api: ResourceApi;
  ingestionId: string;
  resourceScope: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const requestCount = useRef(0);
  const invalidatedTerminal = useRef<string | null>(null);
  const status = useQuery({
    queryKey: [...resourceScope, 'url-ingestion', ingestionId],
    queryFn: async ({ signal }) => {
      requestCount.current += 1;
      return api.getUrlIngestion(ingestionId, signal);
    },
    refetchInterval(query) {
      const record = query.state.data;
      if (
        !record ||
        !isUrlIngestionActive(record.lifecycle) ||
        requestCount.current >= MAX_URL_STATUS_REQUESTS
      )
        return false;
      if (record.lifecycle.contentStatus !== 'failed') return 1000;
      const retryAt = record.lifecycle.retryAt
        ? Date.parse(record.lifecycle.retryAt) - Date.now()
        : 1000;
      return Math.min(Math.max(retryAt, 1000), MAX_URL_RETRY_POLL_INTERVAL_MS);
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelUrlIngestion(ingestionId),
    onSuccess(record) {
      queryClient.setQueryData([...resourceScope, 'url-ingestion', ingestionId], record);
    },
  });
  const terminalStatus = status.data?.lifecycle.contentStatus;
  useEffect(() => {
    if (terminalStatus !== 'finalized' && terminalStatus !== 'bookmark_only') return;
    const terminalKey = `${ingestionId}:${terminalStatus}`;
    if (invalidatedTerminal.current === terminalKey) return;
    invalidatedTerminal.current = terminalKey;
    void queryClient.invalidateQueries({ queryKey: [...resourceScope, 'list'] });
  }, [ingestionId, queryClient, resourceScope, terminalStatus]);

  if (status.isPending) return <p role="status">URL 처리 상태를 확인하는 중</p>;
  if (status.isError) {
    return (
      <div role="alert" className={styles.notice}>
        <p>URL 처리 상태를 확인하지 못했습니다.</p>
        <button type="button" onClick={() => void status.refetch()}>
          상태 다시 확인
        </button>
      </div>
    );
  }
  if (!status.data) return null;
  const active = isUrlIngestionActive(status.data.lifecycle);
  return (
    <div className={styles.ingestionStatus} aria-live="polite">
      <UrlIngestionState record={status.data} />
      {active ? (
        <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
          {cancel.isPending ? '가져오기 취소 중' : '가져오기 취소'}
        </button>
      ) : null}
      {cancel.isError ? <p role="alert">가져오기를 취소하지 못했습니다.</p> : null}
    </div>
  );
}

function UrlIngestionState({ record }: { record: PrivateUrlResourceIngestionRecord }) {
  const lifecycle = record.lifecycle;
  switch (lifecycle.contentStatus) {
    case 'queued':
      return <UrlStateMessage lifecycle={lifecycle} message="가져오기 대기 중" />;
    case 'fetching':
      return <UrlStateMessage lifecycle={lifecycle} message="안전한 URL 원문 확인 중" />;
    case 'parsing':
      return <UrlStateMessage lifecycle={lifecycle} message="본문 파싱 중" />;
    case 'finalized':
      return (
        <UrlStateMessage
          lifecycle={lifecycle}
          message="본문 파싱 완료 · 검색 색인 안 됨 · 코치 사용 안 함"
        />
      );
    case 'bookmark_only':
      return (
        <UrlStateMessage
          lifecycle={lifecycle}
          message="북마크만 저장됨 · 읽을 본문 없음 · 검색 색인 안 됨"
        />
      );
    case 'failed':
      if (lifecycle.failure.retryable) {
        return (
          <UrlStateMessage
            lifecycle={lifecycle}
            message={`자동 재시도 대기 중 · ${urlFailureLabel(lifecycle.failure)}`}
          />
        );
      }
      return (
        <UrlStateMessage
          lifecycle={lifecycle}
          message={`가져오기 실패 · ${urlFailureLabel(lifecycle.failure)}`}
        />
      );
    case 'cancelled':
      return <UrlStateMessage lifecycle={lifecycle} message="가져오기가 취소됨" />;
  }
}

function UrlStateMessage({
  lifecycle,
  message,
}: {
  lifecycle: PrivateUrlResourceIngestion;
  message: string;
}) {
  return (
    <div className={styles.notice}>
      <p className={styles.status}>{message}</p>
      <p className={styles.safeUrl}>{lifecycle.displayUrl}</p>
      <p className={styles.hint}>처리 시도 {lifecycle.attempt}회</p>
      {lifecycle.contentStatus === 'failed' && lifecycle.failure.retryable && lifecycle.retryAt ? (
        <p className={styles.hint}>
          다음 자동 재시도 <time dateTime={lifecycle.retryAt}>{lifecycle.retryAt}</time>
        </p>
      ) : null}
    </div>
  );
}

function AccessPanel({
  resourceId,
  api,
  scope,
}: {
  resourceId: string;
  api: ResourceApi;
  scope: readonly string[];
}) {
  const queryClient = useQueryClient();
  const keys = useIdempotencyKeys();
  const accessQueryKey = useMemo(
    () => [...scope, 'access', resourceId] as const,
    [scope, resourceId],
  );
  const access = useQuery({
    queryKey: accessQueryKey,
    queryFn: ({ signal }) => api.readAccess(resourceId, signal),
  });
  const [failure, setFailure] = useState<string | null>(null);

  function apply(run: (state: PrivateResourceAccessState) => Promise<PrivateResourceAccessState>) {
    const current = access.data;
    if (!current) return;
    setFailure(null);
    void run(current)
      .then((next) => {
        queryClient.setQueryData(accessQueryKey, next);
        void queryClient.invalidateQueries({ queryKey: [...scope, 'list'] });
        void queryClient.invalidateQueries({ queryKey: [...scope, 'detail'] });
      })
      .catch((error: unknown) => setFailure(accessError(error)));
  }

  if (access.isPending) return <p role="status">접근 설정을 불러오는 중</p>;
  if (access.isError || !access.data) {
    return (
      <div role="alert" className={styles.notice}>
        <p>접근 설정을 불러오지 못했습니다.</p>
        <button onClick={() => void access.refetch()}>다시 시도</button>
      </div>
    );
  }

  const state = access.data;
  const activeShares = state.shares;
  const coachUseBlocked = !state.reviewedState.startsWith('reviewed') || !state.aiConsentGranted;

  return (
    <section className={styles.notice} aria-labelledby="resource-access-title">
      <h4 id="resource-access-title">접근·검토·코치 사용</h4>
      <p className={styles.status}>
        접근 revision {state.accessRevision} · {accessLabel(state)}
      </p>
      <p>
        검토 표시와 코치 사용은 서로 다른 전환입니다. 저장·파싱 성공이나 공유 요청만으로 자동
        활성화되지 않습니다.
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          disabled={state.reviewedState === 'reviewed' && state.includeForCoach}
          onClick={() =>
            apply((current) => {
              const payload = {
                reviewed: current.reviewedState !== 'reviewed',
                expectedAccessRevision: current.accessRevision,
                expectedCurrentVersionId: current.currentVersionId,
              };
              return api.setReviewed(resourceId, {
                ...payload,
                idempotencyKey: keys.get(payload),
              });
            })
          }
        >
          {state.reviewedState === 'reviewed' ? '검토 표시 해제' : '검토됨으로 표시'}
        </button>
        <button
          type="button"
          disabled={!state.includeForCoach && coachUseBlocked}
          onClick={() =>
            apply((current) => {
              const payload = {
                includeForCoach: !current.includeForCoach,
                expectedAccessRevision: current.accessRevision,
                expectedCurrentVersionId: current.currentVersionId,
              };
              return api.setCoachUse(resourceId, {
                ...payload,
                idempotencyKey: keys.get(payload),
              });
            })
          }
        >
          {state.includeForCoach ? '코치 사용 중지' : '코치 사용 허용'}
        </button>
      </div>
      {state.reviewedState === 'reviewed' && state.includeForCoach ? (
        <p>검토 표시를 해제하려면 먼저 코치 사용을 중지하세요.</p>
      ) : null}
      {!state.includeForCoach && coachUseBlocked ? (
        <p>
          코치 사용은 검토 표시와 AI 전송 동의가 모두 있어야 켤 수 있고, 사용할 때마다 다시
          확인합니다.
        </p>
      ) : null}
      {state.pendingCleanup ? (
        <p role="status">
          파생 데이터·검색 색인·cache·인용 삭제가 진행 중입니다. 완료 전까지 코치 사용이 차단됩니다.
        </p>
      ) : null}
      <h5>명시적 공유</h5>
      {activeShares.length === 0 ? (
        <p>공유한 대상이 없습니다.</p>
      ) : (
        <ul>
          {activeShares.map((share) => (
            <li key={share.shareId}>
              코치 {share.granteePrincipalId} · revision {share.grantedAccessRevision}에 공유{' '}
              <button
                type="button"
                onClick={() =>
                  apply((current) => {
                    const payload = { expectedAccessRevision: current.accessRevision };
                    return api.revokeShare(resourceId, share.shareId, {
                      ...payload,
                      idempotencyKey: keys.get({ ...payload, shareId: share.shareId }),
                    });
                  })
                }
              >
                공유 철회
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className={styles.form}
        aria-label="코치에게 자료 공유"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = event.currentTarget;
          const granteePrincipalId = String(new FormData(form).get('granteePrincipalId') ?? '');
          apply((current) => {
            const payload = {
              granteeKind: 'coach' as const,
              granteePrincipalId,
              expectedAccessRevision: current.accessRevision,
            };
            return api
              .grantShare(resourceId, { ...payload, idempotencyKey: keys.get(payload) })
              .then((next) => {
                form.reset();
                return next;
              });
          });
        }}
      >
        <label htmlFor="resource-share-grantee">
          코치 계정 식별자
          <input id="resource-share-grantee" name="granteePrincipalId" required maxLength={200} />
        </label>
        <button type="submit">코치에게 공유</button>
      </form>
      {failure ? <p role="alert">{failure}</p> : null}
    </section>
  );
}

function accessError(error: unknown) {
  if (!(error instanceof ResourceRequestError)) return '요청을 처리하지 못했습니다.';
  switch (error.code) {
    case 'COACH_USE_REVIEW_REQUIRED':
      return '먼저 검토됨으로 표시해야 코치 사용을 켤 수 있습니다.';
    case 'COACH_USE_CONSENT_REQUIRED':
      return 'AI 전송 동의가 없어 코치 사용을 켤 수 없습니다.';
    case 'REVIEW_WITHDRAWAL_BLOCKED':
      return '먼저 코치 사용을 중지해야 검토 표시를 해제할 수 있습니다.';
    case 'COACH_USE_MANIFEST_TOO_LARGE':
      return '코치 사용 자료가 허용된 의존성 범위를 넘었습니다.';
    case 'SHARE_GRANTEE_INVALID':
      return '본인 계정에는 공유할 수 없습니다.';
    case 'SHARE_LIMIT_EXCEEDED':
      return '이 자료에 허용된 공유 수를 넘었습니다.';
    case 'SHARE_NOT_FOUND':
      return '이미 철회되었거나 존재하지 않는 공유입니다.';
    case 'REVISION_CONFLICT':
      return '다른 변경이 먼저 반영되었습니다. 최신 상태를 다시 불러오세요.';
    case 'RESOURCE_NOT_FOUND':
      return '자료를 찾을 수 없거나 접근 권한이 없습니다.';
    default:
      return '요청을 처리하지 못했습니다.';
  }
}

function ResourceMetadataFields({ idPrefix }: { idPrefix: string }) {
  return (
    <>
      <label htmlFor={`${idPrefix}-title`}>
        제목
        <input id={`${idPrefix}-title`} name="title" required maxLength={200} />
      </label>
      <label htmlFor={`${idPrefix}-category`}>
        분류
        <select id={`${idPrefix}-category`} name="category" defaultValue="note">
          <option value="note">개인 메모</option>
          <option value="paper">논문</option>
          <option value="guide">가이드</option>
          <option value="race_material">대회 자료</option>
        </select>
      </label>
    </>
  );
}

function Reader({
  read,
  api,
  fileTransfer,
  requestedVersionId,
}: {
  read: PrivateResourceReadResult;
  api: ResourceApi;
  fileTransfer: ResourceFileTransfer | undefined;
  requestedVersionId: string | null;
}) {
  if (read.status === 'unavailable') {
    return <p role="alert">자료를 찾을 수 없거나 열람 권한이 없습니다.</p>;
  }
  if (read.status === 'deleted') {
    return <p role="alert">삭제된 자료입니다. 이전 버전 원문도 더 이상 열 수 없습니다.</p>;
  }
  if (isTextRead(read)) {
    return <TextReader read={read} api={api} requestedVersionId={requestedVersionId} />;
  }
  if (isFileRead(read)) {
    return (
      <FileReader
        read={read}
        api={api}
        fileTransfer={fileTransfer}
        requestedVersionId={requestedVersionId}
      />
    );
  }
  return <UrlReader read={read} api={api} requestedVersionId={requestedVersionId} />;
}

function TextReader({
  read,
  api,
  requestedVersionId,
}: {
  read: TextAvailableRead;
  api: ResourceApi;
  requestedVersionId: string | null;
}) {
  return (
    <article>
      <ReaderHeader read={read} requestedVersionId={requestedVersionId} />
      <p className={styles.meta}>
        이 화면은 AI 요약이나 인용이 아닙니다. 문단 위치는 이 버전에만 고정됩니다.
      </p>
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
      <TextAppendForm read={read} api={api} />
      <DeleteForm read={read} api={api} />
    </article>
  );
}

function FileReader({
  read,
  api,
  fileTransfer,
  requestedVersionId,
}: {
  read: FileAvailableRead;
  api: ResourceApi;
  fileTransfer: ResourceFileTransfer | undefined;
  requestedVersionId: string | null;
}) {
  const nextController = useRequestAbortController();
  const open = useMutation({
    mutationFn: () => {
      if (!fileTransfer) throw new Error('DOWNLOAD_UNAVAILABLE');
      return fileTransfer.open({
        resourceId: read.resource.id,
        versionId: read.version.id,
        fileName: read.reader.file.originalFileName,
        signal: nextController().signal,
      });
    },
  });
  const file = read.reader.file;
  return (
    <article>
      <ReaderHeader read={read} requestedVersionId={requestedVersionId} />
      <p className={styles.meta}>
        이 화면은 저장된 원본 파일의 설명입니다. 본문 파싱과 페이지 인용은 아직 제공되지 않습니다.
      </p>
      <dl className={styles.fileDetails}>
        <div>
          <dt>파일명</dt>
          <dd>{file.originalFileName}</dd>
        </div>
        <div>
          <dt>형식</dt>
          <dd>{file.mediaType}</dd>
        </div>
        <div>
          <dt>크기</dt>
          <dd>{byteFormatter.format(file.byteSize)} bytes</dd>
        </div>
        <div>
          <dt>SHA-256</dt>
          <dd className={styles.digest}>{file.sha256}</dd>
        </div>
      </dl>
      <button
        type="button"
        disabled={fileTransfer === undefined || open.isPending}
        onClick={() => open.mutate()}
      >
        {open.isPending ? '원본 파일 여는 중' : '원본 파일 열기 또는 다운로드'}
      </button>
      {fileTransfer === undefined ? (
        <p role="status">현재 실행 환경에서는 인증된 파일 열기를 지원하지 않습니다.</p>
      ) : null}
      {open.isError ? <p role="alert">원본 파일을 열지 못했습니다. 다시 시도하세요.</p> : null}
      <FileAppendForm read={read} api={api} fileTransfer={fileTransfer} />
      <DeleteForm read={read} api={api} />
    </article>
  );
}

function UrlReader({
  read,
  api,
  requestedVersionId,
}: {
  read: UrlAvailableRead;
  api: ResourceApi;
  requestedVersionId: string | null;
}) {
  const lifecycle = read.reader.lifecycle;
  return (
    <article>
      <ReaderHeader read={read} requestedVersionId={requestedVersionId} />
      <p className={styles.meta}>private · 검색 색인 안 됨 · {accessLabel(read.resource)}</p>
      <p className={styles.safeUrl}>{lifecycle.displayUrl}</p>
      <UrlReaderContent read={read} />
      <DeleteForm read={read} api={api} />
    </article>
  );
}

function UrlReaderContent({ read }: { read: UrlAvailableRead }) {
  const lifecycle = read.reader.lifecycle;
  switch (lifecycle.contentStatus) {
    case 'queued':
      return <p role="status">가져오기 대기 중입니다. 아직 읽을 본문이 없습니다.</p>;
    case 'fetching':
      return <p role="status">URL 원문을 확인하고 있습니다. 아직 읽을 본문이 없습니다.</p>;
    case 'parsing':
      return <p role="status">본문을 파싱하고 있습니다. 아직 읽을 본문이 없습니다.</p>;
    case 'bookmark_only':
      return <p>북마크만 저장되었습니다. 이 버전에는 읽을 본문이 없습니다.</p>;
    case 'failed':
      return <p role="alert">가져오기에 실패했습니다. {urlFailureLabel(lifecycle.failure)}</p>;
    case 'cancelled':
      return <p>가져오기가 취소되었습니다. 이 버전에는 읽을 본문이 없습니다.</p>;
    case 'finalized': {
      const snapshot = read.reader.parsedSnapshot;
      if (!snapshot) {
        return <p role="alert">파싱 결과를 확인할 수 없습니다. 상태를 다시 확인하세요.</p>;
      }
      return (
        <>
          <p className={styles.meta}>
            파싱된 본문 조각과 위치는 원문 버전 {read.version.version}에 고정됩니다.
          </p>
          <ol className={styles.paragraphs}>
            {snapshot.fragments.map((fragment) => {
              const number = fragment.locator.index + 1;
              const heading =
                fragment.locator.kind === 'plain_paragraph'
                  ? ''
                  : fragment.locator.headingPath.join(' › ');
              return (
                <li className={styles.paragraph} id={`url-fragment-${number}`} key={number}>
                  <a href={`#url-fragment-${number}`} aria-label={`본문 조각 ${number} 링크`}>
                    ¶{number}
                  </a>{' '}
                  {fragment.text}
                  <p className={styles.fragmentMeta}>
                    {urlLocatorLabel(fragment.locator.kind)}
                    {heading ? ` · ${heading}` : ''} · UTF-16 {fragment.locator.startOffset}–
                    {fragment.locator.endOffset}
                  </p>
                </li>
              );
            })}
          </ol>
        </>
      );
    }
  }
}

function ReaderHeader({
  read,
  requestedVersionId,
}: {
  read: AvailableRead;
  requestedVersionId: string | null;
}) {
  return (
    <>
      <h3>{read.resource.title}</h3>
      <p className={styles.status}>
        원문 버전 {read.version.version} · {versionLifecycleLabel(read)}
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
    </>
  );
}

function TextAppendForm({ read, api }: { read: TextAvailableRead; api: ResourceApi }) {
  const keys = useIdempotencyKeys();
  const mutation = useMutation({
    mutationFn: (input: { text: string; idempotencyKey: string }) =>
      api.appendText(read.resource.id, {
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
    <form className={styles.form} onSubmit={submit} aria-label="새 텍스트 자료 버전 저장">
      <h4>새 텍스트 버전</h4>
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

function FileAppendForm({
  read,
  api,
  fileTransfer,
}: {
  read: FileAvailableRead;
  api: ResourceApi;
  fileTransfer: ResourceFileTransfer | undefined;
}) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [stage, setStage] = useState<UploadStage>('idle');
  const [progress, setProgress] = useState(0);
  const keys = useIdempotencyKeys();
  const nextController = useRequestAbortController();
  const mutation = useMutation({
    mutationFn: async () => {
      if (!fileTransfer || !selectedFile) throw new Error('UPLOAD_UNAVAILABLE');
      const metadata = { expectedCurrentVersionId: read.resource.currentVersionId };
      const fingerprint = { ...metadata, file: fileFingerprint(selectedFile) };
      const controller = nextController();
      setStage('reserving');
      setProgress(0);
      let reservation = await api.reserveAppendUpload(read.resource.id, {
        ...metadata,
        idempotencyKey: keys.get(fingerprint),
      });
      if (reservation.state === 'failed') {
        keys.clear(fingerprint);
        reservation = await api.reserveAppendUpload(read.resource.id, {
          ...metadata,
          idempotencyKey: keys.get(fingerprint),
        });
      }
      if (reservation.state === 'reserved' || reservation.state === 'prepared') {
        setStage('uploading');
        try {
          await fileTransfer.upload({
            uploadId: reservation.uploadId,
            file: selectedFile,
            mediaType: fileMediaType(selectedFile),
            signal: controller.signal,
            onProgress: (uploadedBytes, totalBytes) => {
              if (!controller.signal.aborted)
                setProgress(
                  totalBytes === 0 ? 0 : Math.min(100, (uploadedBytes / totalBytes) * 100),
                );
            },
          });
        } catch (error) {
          if (requiresFreshUploadIntent(error)) keys.clear(fingerprint);
          throw error;
        }
      }
      setStage('finalizing');
      const result = await api.finalizeUpload(reservation.uploadId);
      keys.clear(fingerprint);
      return result;
    },
  });

  function selectFile(file: File | null) {
    mutation.reset();
    setStage('idle');
    setProgress(0);
    const issue = file ? fileSelectionError(file) : null;
    setSelectionError(issue);
    setSelectedFile(issue ? null : file);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile) {
      setSelectionError('PDF 또는 Markdown 파일을 선택하세요.');
      return;
    }
    mutation.mutate(undefined, {
      onSuccess(result) {
        if (result.status === 'available')
          window.location.assign(`/resources/${result.resource.id}`);
      },
    });
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-label="새 파일 자료 버전 저장">
      <h4>새 파일 버전</h4>
      <label>
        교체할 원본 파일
        <input
          name="file"
          type="file"
          accept={FILE_ACCEPT}
          required
          disabled={fileTransfer === undefined || mutation.isPending}
          onChange={(event) => selectFile(event.currentTarget.files?.[0] ?? null)}
        />
      </label>
      {selectionError ? <p role="alert">{selectionError}</p> : null}
      <button type="submit" disabled={fileTransfer === undefined || mutation.isPending}>
        {mutation.isPending
          ? uploadStageLabel(stage, progress)
          : mutation.isError
            ? '파일 버전 업로드 다시 시도'
            : '새 파일 버전 업로드'}
      </button>
      {mutation.isPending && stage === 'uploading' ? (
        <progress aria-label="새 파일 버전 업로드 진행률" max={100} value={progress}>
          {Math.round(progress)}%
        </progress>
      ) : null}
      {mutation.isError ? (
        <p role="alert">
          {readableError(mutation.error, 'file')} 선택한 파일은 유지되었습니다. 같은 작업을 다시
          시도할 수 있습니다.
        </p>
      ) : null}
    </form>
  );
}

function DeleteForm({ read, api }: { read: AvailableRead; api: ResourceApi }) {
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
      <p>
        삭제하면 이후의 모든 열람 요청이 현재 원문과 과거 버전 모두에서 즉시 차단됩니다. 이미 시작된
        파일 전송은 중단되지 않습니다.
      </p>
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

function isTextRead(read: AvailableRead): read is TextAvailableRead {
  return read.resource.sourceKind === 'text';
}

function isFileRead(read: AvailableRead): read is FileAvailableRead {
  return read.resource.sourceKind === 'file';
}

function isUrlRead(read: AvailableRead): read is UrlAvailableRead {
  return read.resource.sourceKind === 'url';
}

function fileFingerprint(file: File) {
  return {
    name: file.name.normalize('NFC'),
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  };
}

function fileSelectionError(file: File) {
  if (file.size === 0) return '빈 파일은 업로드할 수 없습니다.';
  const lowerName = file.name.toLocaleLowerCase('en-US');
  const maxBytes = lowerName.endsWith('.pdf')
    ? PRIVATE_RESOURCE_PDF_MAX_BYTES
    : lowerName.endsWith('.md') || lowerName.endsWith('.markdown')
      ? PRIVATE_RESOURCE_MARKDOWN_MAX_BYTES
      : null;
  if (maxBytes === null)
    return 'PDF(.pdf) 또는 Markdown(.md, .markdown) 파일만 선택할 수 있습니다.';
  if (file.size > maxBytes) {
    return lowerName.endsWith('.pdf')
      ? 'PDF는 10 MiB까지 업로드할 수 있습니다.'
      : 'Markdown은 1 MiB까지 업로드할 수 있습니다.';
  }
  return null;
}

function fileMediaType(file: File): PrivateFileResourceMediaType {
  return file.name.toLocaleLowerCase('en-US').endsWith('.pdf')
    ? 'application/pdf'
    : 'text/markdown';
}

function uploadStageLabel(stage: UploadStage, progress: number) {
  if (stage === 'reserving') return '업로드 준비 중';
  if (stage === 'uploading') return `원본 파일 전송 중 ${Math.round(progress)}%`;
  if (stage === 'finalizing') return '원본 저장 확인 중';
  return '처리 중';
}

function sourceKindLabel(sourceKind: PrivateResourceListItem['sourceKind']) {
  switch (sourceKind) {
    case 'text':
      return '텍스트';
    case 'file':
      return '파일';
    case 'url':
      return 'URL';
  }
}

function urlLocatorLabel(kind: 'html_block' | 'markdown_paragraph' | 'plain_paragraph') {
  switch (kind) {
    case 'html_block':
      return 'HTML 블록';
    case 'markdown_paragraph':
      return 'Markdown 문단';
    case 'plain_paragraph':
      return '일반 텍스트 문단';
  }
}

/** Review and coach use are distinct states, and neither follows from storage success. */
function accessLabel(access: { reviewedState: string; includeForCoach: boolean }) {
  if (access.includeForCoach) return '검토됨 · 코치 사용 함';
  if (access.reviewedState === 'reviewed') return '검토됨 · 코치 사용 안 함';
  return '코치 사용 안 함';
}

function lifecycleLabel(resource: PrivateResourceListItem) {
  switch (resource.sourceKind) {
    case 'text':
      return `파싱 완료 · 검색 색인 안 됨 · ${accessLabel(resource)}`;
    case 'file':
      return `원본 파일 저장됨 · 본문 파싱 안 됨 · 검색 색인 안 됨 · ${accessLabel(resource)}`;
    case 'url':
      return urlLifecycleLabel(resource.lifecycle, accessLabel(resource));
  }
}

function versionLifecycleLabel(read: AvailableRead) {
  const access = accessLabel(read.resource);
  if (isTextRead(read)) return `파싱 완료 · 검색 색인 안 됨 · ${access}`;
  if (isFileRead(read)) return `원본 파일 저장됨 · 본문 파싱 안 됨 · 검색 색인 안 됨 · ${access}`;
  if (isUrlRead(read)) return urlLifecycleLabel(read.version.lifecycle, access);
}

function urlLifecycleLabel(lifecycle: PrivateUrlResourceIngestion, access = '코치 사용 안 함') {
  switch (lifecycle.contentStatus) {
    case 'queued':
      return `가져오기 대기 중 · 검색 색인 안 됨 · ${access}`;
    case 'fetching':
      return `URL 원문 확인 중 · 검색 색인 안 됨 · ${access}`;
    case 'parsing':
      return `본문 파싱 중 · 검색 색인 안 됨 · ${access}`;
    case 'finalized':
      return `본문 파싱 완료 · 검색 색인 안 됨 · ${access}`;
    case 'bookmark_only':
      return `북마크만 저장됨 · 검색 색인 안 됨 · ${access}`;
    case 'failed':
      if (lifecycle.failure.retryable)
        return `자동 재시도 대기 중 · ${urlFailureLabel(lifecycle.failure)}`;
      return `가져오기 실패 · ${urlFailureLabel(lifecycle.failure)}`;
    case 'cancelled':
      return `가져오기 취소됨 · 검색 색인 안 됨 · ${access}`;
  }
}

function urlFailureLabel(failure: PrivateUrlResourceFailure) {
  if (failure.stage === 'fetch') {
    switch (failure.code) {
      case 'blocked_scheme':
      case 'blocked_host':
      case 'blocked_address':
      case 'redirect_blocked':
        return '안전 정책에 따라 이 주소를 가져올 수 없습니다.';
      case 'redirect_limit':
        return '주소 이동 횟수가 허용 범위를 넘었습니다.';
      case 'timeout':
        return '원문을 가져오는 시간이 초과되었습니다.';
      case 'response_too_large':
        return '원문 응답이 허용된 크기를 넘었습니다.';
      case 'unsupported_media_type':
        return '지원하지 않는 원문 형식입니다.';
      case 'http_status':
        return '원문 서버가 가져올 수 없는 응답을 반환했습니다.';
      case 'network_error':
        return '원문 서버에 연결하지 못했습니다.';
    }
  }
  switch (failure.code) {
    case 'timeout':
      return '본문 처리 시간이 초과되었습니다.';
    case 'input_too_large':
    case 'output_too_large':
      return '본문이 허용된 처리 범위를 넘었습니다.';
    case 'malformed':
      return '원문 구조를 읽을 수 없습니다.';
    case 'unsupported':
      return '지원하지 않는 본문 형식입니다.';
    case 'no_extractable_text':
      return '읽을 수 있는 본문을 찾지 못했습니다.';
    case 'internal_error':
      return '본문 처리 중 오류가 발생했습니다.';
  }
}

function categoryLabel(category: PrivateTextResourceCategory) {
  return {
    paper: '논문',
    guide: '가이드',
    note: '개인 메모',
    race_material: '대회 자료',
  }[category];
}

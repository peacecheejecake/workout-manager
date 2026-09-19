'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { QueryClient, QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  PRIVATE_RESOURCE_MARKDOWN_MAX_BYTES,
  PRIVATE_RESOURCE_PDF_MAX_BYTES,
  type PrivateFileResourceMediaType,
  type PrivateFileResourceReadResult,
  type PrivateResourceReadResult,
  type PrivateTextResourceCategory,
  type PrivateTextResourceCreate,
  type PrivateTextResourceReadResult,
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
type AvailableRead = TextAvailableRead | FileAvailableRead;
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

function readableError(error: unknown, kind: 'text' | 'file' = 'text') {
  if (!(error instanceof ResourceRequestError)) return '요청을 완료하지 못했습니다.';
  if (error.status === 409) return '다른 변경이 먼저 저장되었습니다. 최신 버전을 다시 확인하세요.';
  if (error.status === 413) {
    return kind === 'file'
      ? '파일이 허용된 크기를 넘었습니다. PDF는 10 MiB, Markdown은 1 MiB까지 저장할 수 있습니다.'
      : '본문이 허용된 64 KiB 범위를 넘었습니다.';
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
        <p className={styles.eyebrow}>자료실 · private 원문 보관</p>
        <h1>자료실</h1>
        <p>
          직접 입력한 원문과 PDF·Markdown 원본 파일을 불변 버전으로 보관합니다. 파일 업로드 완료는
          원본 저장만 뜻하며, 아직 본문 파싱·검색·코치 사용으로 이어지지 않습니다.
        </p>
      </header>
      <AdaptiveWorkspace requestedView="split">
        <section className={styles.panel} aria-labelledby="resource-list-title">
          <h2 id="resource-list-title">내 자료</h2>
          <div className={styles.modeGrid}>
            <TextCreateForm api={api} />
            <FileCreateForm api={api} fileTransfer={fileTransfer} />
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
                  {resource.sourceKind === 'file' ? '파일' : '텍스트'} ·{' '}
                  {categoryLabel(resource.category)} · 버전 고정 가능 ·{' '}
                  {resource.favorite ? '별표' : '별표 없음'}
                </p>
                <p className={styles.status}>{lifecycleLabel(resource.sourceKind)}</p>
              </article>
            ))}
          </div>
        </section>
        <section className={styles.panel} aria-labelledby="resource-reader-title">
          <h2 id="resource-reader-title">자료 읽기</h2>
          {resourceId === null ? (
            <p>목록에서 자료를 선택하면 고정된 텍스트 원문 또는 파일 설명을 확인할 수 있습니다.</p>
          ) : detail.isPending ? (
            <p role="status">자료를 불러오는 중</p>
          ) : detail.isError ? (
            <div role="alert" className={styles.notice}>
              <p>{readableError(detail.error)}</p>
              <button onClick={() => void detail.refetch()}>다시 시도</button>
            </div>
          ) : detail.data ? (
            <Reader
              read={detail.data}
              api={api}
              fileTransfer={fileTransfer}
              requestedVersionId={versionId}
            />
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
  return isTextRead(read) ? (
    <TextReader read={read} api={api} requestedVersionId={requestedVersionId} />
  ) : (
    <FileReader
      read={read}
      api={api}
      fileTransfer={fileTransfer}
      requestedVersionId={requestedVersionId}
    />
  );
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
        원문 버전 {read.version.version} · {lifecycleLabel(read.resource.sourceKind)}
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

function isTextRead(read: AvailableRead): read is TextAvailableRead {
  return read.resource.sourceKind === 'text';
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

function lifecycleLabel(sourceKind: 'text' | 'file') {
  return sourceKind === 'text'
    ? '파싱 완료 · 검색 색인 안 됨 · 코치 사용 안 함'
    : '원본 파일 저장됨 · 본문 파싱 안 됨 · 검색 색인 안 됨 · 코치 사용 안 함';
}

function categoryLabel(category: PrivateTextResourceCategory) {
  return {
    paper: '논문',
    guide: '가이드',
    note: '개인 메모',
    race_material: '대회 자료',
  }[category];
}

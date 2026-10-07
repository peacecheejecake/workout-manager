'use client';
import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  raceResultAttachmentInputSchema,
  type RaceResultAttachmentInput,
  type RaceResultReadV2,
} from '@workout/contracts/race-result-v2';
import type { CompetitionsProofApi } from './competitions-proof-api';
import { RaceRequestError } from './race-api';
import styles from './competitions.module.css';

type ReadAttachment = RaceResultReadV2['proofs']['attachments'][number];
export type ProofChoice =
  | { state: 'retained'; attachment: ReadAttachment }
  | { state: 'selected'; ref: RaceResultAttachmentInput; label: string };
function identity(choice: ProofChoice) {
  const ref = choice.state === 'retained' ? choice.attachment : choice.ref;
  return ref.kind === 'gallery-image' ? `gallery:${ref.mediaItemId}` : `resource:${ref.resourceId}`;
}
export function selectedProofRefs(choices: readonly ProofChoice[]) {
  if (choices.some((choice) => choice.state === 'retained'))
    throw new Error('PROOF_CONFIRMATION_REQUIRED');
  return choices.flatMap((choice) =>
    choice.state === 'selected' ? [raceResultAttachmentInputSchema.parse(choice.ref)] : [],
  );
}
/** Chooses exact public descriptors. Server resolves ownership, finalized bytes and access CAS on save. */
export function ProofSelector({
  api,
  scope,
  choices,
  onChange,
}: {
  api: CompetitionsProofApi;
  scope: readonly string[];
  choices: readonly ProofChoice[];
  onChange: (choices: readonly ProofChoice[]) => void;
}) {
  const gallery = useInfiniteQuery({
    queryKey: ['competitions', ...scope, 'proof-gallery'],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api.gallery.list({ mediaKind: 'image', limit: 20, offset: pageParam }, signal),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, page) => n + page.items.length, 0);
      return last.items.length > 0 && loaded < last.total && loaded <= 10000 ? loaded : undefined;
    },
  });
  const resources = useInfiniteQuery({
    queryKey: ['competitions', ...scope, 'proof-resources'],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api.resources.list({ limit: 20, offset: pageParam }, signal),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, page) => n + page.items.length, 0);
      return last.items.length > 0 && loaded < last.total && loaded <= 10000 ? loaded : undefined;
    },
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function choose(
    ref:
      | { kind: 'gallery-image'; mediaItemId: string }
      | { kind: 'resource-pdf'; resourceId: string; versionId: string },
    replace?: number,
  ) {
    if (pending || (replace === undefined && choices.length >= 4)) return;
    const abort = new AbortController();
    controller.current = abort;
    setPending(true);
    setError('');
    try {
      let selection: ProofChoice;
      if (ref.kind === 'gallery-image') {
        const result = await api.gallery.read(ref.mediaItemId, abort.signal);
        if (result.status !== 'available' || result.item.mediaKind !== 'image')
          throw new Error('PROOF_UNAVAILABLE');
        selection = {
          state: 'selected',
          ref: raceResultAttachmentInputSchema.parse({
            kind: 'gallery-image',
            mediaItemId: ref.mediaItemId,
            expectedAccessRevision: result.item.accessRevision,
          }),
          label: result.item.file.originalFileName,
        };
      } else {
        const result = await api.resources.read(
          ref.resourceId,
          { versionId: ref.versionId },
          abort.signal,
        );
        if (
          result.status !== 'available' ||
          result.version.source.kind !== 'file' ||
          result.version.source.file.mediaType !== 'application/pdf'
        )
          throw new Error('PROOF_UNAVAILABLE');
        selection = {
          state: 'selected',
          ref: raceResultAttachmentInputSchema.parse({
            kind: 'resource-pdf',
            resourceId: ref.resourceId,
            versionId: ref.versionId,
            expectedAccessRevision: result.resource.accessRevision,
          }),
          label: result.resource.title,
        };
      }
      if (abort.signal.aborted) return;
      const next =
        replace === undefined
          ? [...choices, selection]
          : choices.map((choice, i) => (i === replace ? selection : choice));
      if (new Set(next.map(identity)).size !== next.length) throw new Error('DUPLICATE_PROOF');
      onChange(next);
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(
          failure instanceof RaceRequestError && failure.status === 409
            ? '증빙 접근 버전이 변경되었습니다. 목록 새로고침 후 다시 선택하세요.'
            : '증빙을 확인할 수 없습니다. 정확 버전을 다시 확인하거나 연결을 해제하세요.',
        );
    } finally {
      if (!abort.signal.aborted) setPending(false);
    }
  }
  return (
    <section aria-label="이미지 및 PDF 증빙 선택">
      <p>
        최대 4개. 첨부는 진위 확인 완료가 아닙니다. 기존 업로드 화면에서 파일을 추가한 뒤 목록을
        새로고침하세요.
      </p>
      <div className={styles.actions}>
        <a href="/gallery" target="_blank" rel="noreferrer">
          갤러리에서 이미지 업로드
        </a>
        <a href="/resources" target="_blank" rel="noreferrer">
          자료실에서 PDF 업로드
        </a>
      </div>
      <ul aria-label="선택한 증빙">
        {choices.map((choice, index) => (
          <li key={identity(choice)}>
            {choice.state === 'selected'
              ? choice.label
              : `기존 ${choice.attachment.kind === 'gallery-image' ? '이미지' : 'PDF'} 증빙 · ${choice.attachment.status === 'unavailable' ? '사용 불가' : '재확인 필요'}`}
            {choice.state === 'retained' ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  void choose(choice.attachment, index);
                }}
              >
                정확 버전 재확인 {index + 1}
              </button>
            ) : null}
            <button
              type="button"
              disabled={pending}
              onClick={() => onChange(choices.filter((_, i) => i !== index))}
            >
              증빙 연결 해제 {index + 1}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={pending || gallery.isFetching || resources.isFetching}
        onClick={() => {
          void gallery.refetch();
          void resources.refetch();
        }}
      >
        증빙 목록 새로고침
      </button>
      {gallery.isPending || resources.isPending || pending ? (
        <p role="status">증빙 확인 중입니다.</p>
      ) : null}
      {gallery.isError || resources.isError ? (
        <p role="alert">증빙 목록을 불러오지 못했습니다. 선택한 초안은 유지됩니다.</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <ul aria-label="갤러리 이미지">
        {gallery.data?.pages
          .flatMap((page) => page.items)
          .map((item) => (
            <li key={item.id}>
              <span>{item.file.originalFileName}</span>
              <button
                type="button"
                disabled={
                  pending ||
                  choices.length >= 4 ||
                  choices.some((choice) => identity(choice) === `gallery:${item.id}`)
                }
                onClick={() => {
                  void choose({ kind: 'gallery-image', mediaItemId: item.id });
                }}
              >
                이미지 선택 · {item.file.originalFileName}
              </button>
            </li>
          ))}
      </ul>
      {gallery.hasNextPage ? (
        <button
          type="button"
          disabled={gallery.isFetchingNextPage}
          onClick={() => {
            void gallery.fetchNextPage();
          }}
        >
          이미지 더 보기
        </button>
      ) : null}
      <ul aria-label="자료실 PDF">
        {resources.data?.pages
          .flatMap((page) => page.items)
          .filter((item) => item.sourceKind === 'file')
          .map((item) => (
            <li key={item.id}>
              <span>{item.title}</span>
              <button
                type="button"
                disabled={
                  pending ||
                  choices.length >= 4 ||
                  choices.some((choice) => identity(choice) === `resource:${item.id}`)
                }
                onClick={() => {
                  void choose({
                    kind: 'resource-pdf',
                    resourceId: item.id,
                    versionId: item.currentVersionId,
                  });
                }}
              >
                PDF 정확 버전 선택 · {item.title}
              </button>
            </li>
          ))}
      </ul>
      {resources.hasNextPage ? (
        <button
          type="button"
          disabled={resources.isFetchingNextPage}
          onClick={() => {
            void resources.fetchNextPage();
          }}
        >
          자료 더 보기
        </button>
      ) : null}
    </section>
  );
}

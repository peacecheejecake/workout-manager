'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Activity } from '@workout/contracts/activity';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  healthKitWorkoutReviewResponseSchema,
  type HealthKitWorkoutReviewResponse,
} from '@workout/contracts/healthkit-review';
import { healthKitBindExistingResultSchema } from '@workout/contracts/healthkit-binding';
import { healthKitCreateActivityResultSchema } from '@workout/contracts/healthkit-activity';
import { Button } from '@workout/ui-foundation/button';

type ReviewItem = HealthKitWorkoutReviewResponse['items'][number];
type Choice = 'create' | 'link';
type Decision = {
  item: ReviewItem;
  choice: Choice;
  target: { id: string; revision: number } | null;
  idempotencyKey: string;
};

export interface HealthKitReviewPanelProps {
  transport: AuthenticatedTransport;
  scope: readonly string[];
  selectedActivity: Activity | null;
  onActivityChosen(activityId: string): void;
}

const kindLabels = {
  running: '달리기',
  cycling: '자전거',
  walking: '걷기',
  strength: '근력',
  other: '기타',
} as const;

function selectionKey(item: ReviewItem, choice: Choice, target: Activity | null) {
  return JSON.stringify([
    item.sampleId,
    item.expectedSampleDigest,
    choice,
    choice === 'link' ? target?.id : null,
    choice === 'link' ? target?.revision : null,
  ]);
}

export function HealthKitReviewPanel({
  transport,
  scope,
  selectedActivity,
  onActivityChosen,
}: HealthKitReviewPanelProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>('create');
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<Decision | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const review = useQuery({
    queryKey: [...scope, 'healthkit-review'],
    enabled: open,
    queryFn: async ({ signal }) => {
      const response = await transport.request({
        path: '/bff/v1/healthkit/workout-review?limit=50',
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal,
      });
      if (response.status === 403) throw new Error('CONSENT_REQUIRED');
      if (response.status !== 200) throw new Error('REVIEW_UNAVAILABLE');
      return healthKitWorkoutReviewResponseSchema.parse(response.body);
    },
  });
  const selected = review.data?.items.find((item) => item.sampleId === sampleId) ?? null;
  const target =
    selectedActivity &&
    (selectedActivity.source.kind === 'fit' || selectedActivity.source.kind === 'manual')
      ? selectedActivity
      : null;
  const key = selected ? selectionKey(selected, choice, target) : null;
  const canSubmit =
    selected !== null &&
    !review.isFetching &&
    !review.isError &&
    confirmedKey === key &&
    (choice === 'create' || target !== null) &&
    !submitting &&
    pendingDecision === null;

  async function send(decision: Decision) {
    setSubmitting(true);
    setMessage(null);
    try {
      if (decision.choice === 'link' && !decision.target) throw new Error('TARGET_NOT_SELECTED');
      const body =
        decision.choice === 'create'
          ? {
              sampleId: decision.item.sampleId,
              expectedSampleDigest: decision.item.expectedSampleDigest,
              confirmed: true,
              idempotencyKey: decision.idempotencyKey,
            }
          : {
              sampleId: decision.item.sampleId,
              targetActivityId: decision.target?.id ?? '',
              expectedActivityRevision: decision.target?.revision ?? 0,
              expectedSampleDigest: decision.item.expectedSampleDigest,
              confirmed: true,
              idempotencyKey: decision.idempotencyKey,
            };
      const response = await transport.request({
        path:
          decision.choice === 'create'
            ? '/bff/v1/healthkit/workout-activities'
            : '/bff/v1/healthkit/workout-bindings',
        method: 'POST',
        body,
        idempotencyKey: decision.idempotencyKey,
      });
      if (response.status === 409 || response.status === 403 || response.status === 404) {
        setPendingDecision(null);
        setConfirmedKey(null);
        setMessage('원본·동의 또는 대상 활동이 변경되었습니다. 최신 상태를 다시 확인해 주세요.');
        await queryClient.invalidateQueries({ queryKey: scope });
        return;
      }
      if (response.status !== 200 && response.status !== 201)
        throw new Error('DECISION_UNCONFIRMED');
      const result =
        decision.choice === 'create'
          ? healthKitCreateActivityResultSchema.parse(response.body)
          : healthKitBindExistingResultSchema.parse(response.body);
      if (result.sampleId !== decision.item.sampleId) throw new Error('DECISION_MISMATCH');
      setPendingDecision(null);
      setConfirmedKey(null);
      setSampleId(null);
      setMessage('선택한 운동의 저장 결과를 확인했습니다.');
      await queryClient.invalidateQueries({ queryKey: scope });
      onActivityChosen(result.activityId);
    } catch {
      setMessage(
        '결과를 확인하지 못했습니다. 같은 요청으로 재시도하거나 최신 상태를 확인해 주세요.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  function submit() {
    if (!selected || !canSubmit) return;
    const decision: Decision = {
      item: selected,
      choice,
      target: choice === 'link' && target ? { id: target.id, revision: target.revision } : null,
      idempotencyKey: crypto.randomUUID(),
    };
    setPendingDecision(decision);
    void send(decision);
  }

  return (
    <section aria-labelledby="healthkit-review-heading">
      <h3 id="healthkit-review-heading">Apple 건강 운동 검토</h3>
      <Button
        variant="secondary"
        aria-expanded={open}
        aria-controls="healthkit-review-content"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? '검토 화면 닫기' : '검토할 운동 확인'}
      </Button>
      {open ? (
        <div id="healthkit-review-content">
          <p>
            동기화된 운동은 선택 전까지 활동 합계에 들어가지 않습니다. 비슷한 Garmin 활동도 자동으로
            합치지 않습니다.
          </p>
          {review.isFetching ? <p role="status">검토할 운동을 확인하고 있습니다.</p> : null}
          {review.isError ? (
            <p role="alert">
              {review.error.message === 'CONSENT_REQUIRED'
                ? '건강 데이터 동의가 필요합니다. 계정 화면에서 확인해 주세요.'
                : '검토할 운동을 확인하지 못했습니다.'}
            </p>
          ) : null}
          <Button variant="secondary" disabled={submitting} onClick={() => void review.refetch()}>
            검토 목록 다시 확인
          </Button>
          {review.isSuccess && review.data.items.length === 0 ? (
            <p>
              현재 검토 대기 중인 운동이 없습니다. 이는 HealthKit 읽기 권한 상태를 뜻하지 않습니다.
            </p>
          ) : null}
          {review.isSuccess && review.data.items.length > 0 ? (
            <fieldset disabled={submitting || pendingDecision !== null || review.isFetching}>
              <legend>검토할 운동 선택</legend>
              {review.data.items.map((item) => (
                <label key={item.sampleId}>
                  <input
                    type="radio"
                    name="healthkit-review-sample"
                    checked={sampleId === item.sampleId}
                    onChange={() => {
                      setSampleId(item.sampleId);
                      setConfirmedKey(null);
                      setMessage(null);
                    }}
                  />
                  {kindLabels[item.kind]} · 현재 기기 시각{' '}
                  {new Date(item.observedFrom).toLocaleString('ko-KR')} · 기간{' '}
                  {item.durationSeconds}초 (정의 미확인) · 거리{' '}
                  {item.distanceMeters === null ? '미확인' : `${item.distanceMeters}m`}
                </label>
              ))}
            </fieldset>
          ) : null}
          {selected && !review.isFetching && !review.isError ? (
            <div>
              <fieldset disabled={submitting || pendingDecision !== null}>
                <legend>이 운동의 처리 방법</legend>
                <label>
                  <input
                    type="radio"
                    name="healthkit-review-choice"
                    checked={choice === 'create'}
                    onChange={() => {
                      setChoice('create');
                      setConfirmedKey(null);
                    }}
                  />
                  새 활동으로 기록
                </label>
                <label>
                  <input
                    type="radio"
                    name="healthkit-review-choice"
                    checked={choice === 'link'}
                    onChange={() => {
                      setChoice('link');
                      setConfirmedKey(null);
                    }}
                  />
                  기존 활동에 보조 출처로 연결
                </label>
              </fieldset>
              {choice === 'link' ? (
                <p>
                  {target
                    ? `현재 선택한 활동: ${target.effective.title ?? '제목 미확인'} · 출처 ${target.source.kind} · 수정 ${target.revision}. 활동 목록에서 대상을 바꿀 수 있습니다.`
                    : '활동 목록에서 FIT 또는 수동 활동을 먼저 선택하세요.'}
                </p>
              ) : (
                <p>
                  선택한 운동 하나를 새 활동으로 기록합니다. 기존 활동과 같은 운동인지 확인해
                  주세요.
                </p>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={confirmedKey === key}
                  disabled={
                    submitting || pendingDecision !== null || (choice === 'link' && !target)
                  }
                  onChange={(event) => setConfirmedKey(event.currentTarget.checked ? key : null)}
                />
                선택한 원본과 처리 방법을 확인했습니다.
              </label>
              <Button variant="primary" disabled={!canSubmit} onClick={submit}>
                {choice === 'create' ? '새 활동 기록 확정' : '기존 활동 연결 확정'}
              </Button>
            </div>
          ) : null}
          {pendingDecision && !submitting ? (
            <div role="alert">
              <p>서버의 저장 결과가 확인되지 않았습니다. 같은 요청만 재시도할 수 있습니다.</p>
              <Button variant="secondary" onClick={() => void send(pendingDecision)}>
                같은 요청 재시도
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setPendingDecision(null);
                  setConfirmedKey(null);
                  void review.refetch();
                }}
              >
                최신 상태 확인
              </Button>
            </div>
          ) : null}
          {message ? <p role="status">{message}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

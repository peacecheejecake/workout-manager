import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import type { PlanDraft, PlannedSession } from '@workout/contracts/planning';
import { Button } from '@workout/ui-foundation/button';
import type { PlannedSessionOperation } from './session-operation';
import styles from './session-operations.module.css';
export interface SessionOperationsProps {
  draft: PlanDraft;
  baseline: PlanDraft | null;
  selected: string | null;
  today: string;
  onOperation(sessionId: string, operation: PlannedSessionOperation): void;
}
export function SessionOperations(props: SessionOperationsProps) {
  const session = props.draft.sessions.find((session) => session.id === props.selected);
  const root = useRef<HTMLDivElement>(null);
  const focusedControl = useRef<string | null>(null);
  const key = session
    ? JSON.stringify([session.id, session.date, session.blockId, session.durationSeconds])
    : null;
  useLayoutEffect(() => {
    if (document.activeElement !== document.body || !focusedControl.current) return;
    const control = [
      ...(root.current?.querySelectorAll<HTMLElement>('[data-operation-control]') ?? []),
    ].find((element) => element.dataset.operationControl === focusedControl.current);
    control?.focus();
  }, [key]);
  return (
    <div
      ref={root}
      onFocusCapture={(event) => {
        focusedControl.current =
          event.target instanceof HTMLElement
            ? (event.target.dataset.operationControl ?? null)
            : null;
      }}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          focusedControl.current = null;
      }}
    >
      {session ? (
        <Controls key={key} {...props} session={session} />
      ) : (
        <p>날짜나 길이를 조절할 계획 세션을 선택하세요.</p>
      )}
    </div>
  );
}

function Controls({
  draft,
  baseline,
  today,
  onOperation,
  session,
}: SessionOperationsProps & { session: PlannedSession }) {
  const [date, setDate] = useState(session.date);
  const [blockId, setBlockId] = useState(session.blockId);
  const [duration, setDuration] = useState(
    session.durationSeconds === null ? '' : String(session.durationSeconds),
  );
  const [slider, setSlider] = useState(session.durationSeconds ?? 0);
  const [error, setError] = useState<string | null>(null);
  const latestSlider = useRef(session.durationSeconds ?? 0);
  const gesture = useRef(false);
  const gestureGeometry = useRef<string | null>(null);
  const cancelled = useRef(false);
  const composing = useRef(false);
  const root = useRef<HTMLElement>(null);
  const instructions = useId();
  const prior = baseline?.sessions.find((value) => value.id === session.id);
  const past = session.date < today;
  const moveLocked = past || session.locks.date || prior?.locks.date === true;
  const resizeLocked = past || session.locks.intensity || prior?.locks.intensity === true;
  useEffect(() => {
    const cancel = () => {
      if (!gesture.current) return;
      cancelled.current = true;
      gesture.current = false;
      latestSlider.current = session.durationSeconds ?? 0;
      setSlider(session.durationSeconds ?? 0);
    };
    const element = root.current;
    let lastSize: { width: number; height: number } | null = null;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            const next = entries[0]?.contentRect;
            if (!next || !Number.isFinite(next.width) || !Number.isFinite(next.height)) return;
            if (lastSize && (lastSize.width !== next.width || lastSize.height !== next.height))
              cancel();
            lastSize = { width: next.width, height: next.height };
          });
    if (element) observer?.observe(element);
    window.addEventListener('resize', cancel);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', cancel);
      gesture.current = false;
    };
  }, [session.durationSeconds]);
  function cancelSlider() {
    cancelled.current = true;
    gesture.current = false;
    latestSlider.current = session.durationSeconds ?? 0;
    setSlider(session.durationSeconds ?? 0);
  }
  function geometry() {
    const bounds = root.current?.getBoundingClientRect();
    return JSON.stringify([window.innerWidth, window.innerHeight, bounds?.width, bounds?.height]);
  }
  function commitSlider() {
    // Resize notifications may arrive after keyup/pointerup; compare synchronously before writing.
    if (gesture.current && gestureGeometry.current !== geometry()) {
      cancelSlider();
      return;
    }
    if (!gesture.current || cancelled.current || resizeLocked || session.durationSeconds === null)
      return;
    gesture.current = false;
    if (latestSlider.current !== session.durationSeconds)
      onOperation(session.id, { kind: 'resize', durationSeconds: latestSlider.current });
  }
  function beginSlider() {
    gestureGeometry.current = geometry();
    cancelled.current = false;
    gesture.current = true;
  }
  return (
    <section ref={root} className={styles.operations} aria-label="선택한 계획 세션 이동과 길이">
      <h3>계획 세션 이동과 길이</h3>
      <p id={instructions}>
        변경은 계획 초안에만 반영됩니다. 저장은 미리보기와 명시적 확인이 필요하며 실제 기록과 세부
        단계 길이는 바뀌지 않습니다.
      </p>
      {past ? <p>과거 세션은 이 조작으로 이동하거나 길이를 바꿀 수 없습니다.</p> : null}
      <div
        className={styles.controls}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
      >
        <label>
          이동할 날짜
          <input
            data-operation-control="date"
            type="date"
            value={date}
            min={today}
            disabled={moveLocked}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <label>
          이동할 Block
          <select
            data-operation-control="block"
            value={blockId}
            disabled={moveLocked}
            onChange={(event) => setBlockId(event.target.value)}
          >
            {draft.periods
              .filter((period) => period.level === 'block')
              .map((period) => (
                <option key={period.id} value={period.id}>
                  {period.title} ({period.startDate} ~ {period.endDateExclusive}, 종료일 제외)
                </option>
              ))}
          </select>
        </label>
        <Button
          data-operation-control="apply-date"
          disabled={moveLocked}
          onClick={() => {
            if (!composing.current) onOperation(session.id, { kind: 'move', date, blockId });
          }}
        >
          계획 날짜 이동
        </Button>
        {moveLocked && !past ? <p>날짜 잠금을 먼저 해제하고 저장한 뒤 이동하세요.</p> : null}
        <label>
          변경할 계획 시간 (초)
          <input
            data-operation-control="duration"
            type="number"
            min="0"
            max="604800"
            step="any"
            disabled={resizeLocked}
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
          />
        </label>
        <Button
          data-operation-control="apply-duration"
          disabled={resizeLocked}
          onClick={() => {
            if (composing.current) return;
            if (
              duration.trim() === '' ||
              !Number.isFinite(Number(duration)) ||
              Number(duration) < 0 ||
              Number(duration) > 604800
            ) {
              setError('계획 시간은 0 이상 604800 이하의 초 단위 숫자로 입력하세요.');
              return;
            }
            setError(null);
            onOperation(session.id, { kind: 'resize', durationSeconds: Number(duration) });
          }}
        >
          계획 시간 적용
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <label className={styles.sliderLabel}>
        계획 길이 조절
        <input
          data-operation-control="slider"
          type="range"
          min="0"
          max={Math.min(604800, Math.max(7200, (session.durationSeconds ?? 0) * 2))}
          step="any"
          value={slider}
          disabled={resizeLocked || session.durationSeconds === null}
          aria-valuetext={`${slider}초, 아직 놓지 않은 값은 임시 값`}
          aria-describedby={instructions}
          onPointerDown={(event) => {
            beginSlider();
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onChange={(event) => {
            if (cancelled.current) return;
            latestSlider.current = Number(event.target.value);
            setSlider(latestSlider.current);
          }}
          onPointerUp={commitSlider}
          onPointerCancel={cancelSlider}
          onBlur={cancelSlider}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelSlider();
              return;
            }
            if (
              ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
            ) {
              event.preventDefault();
              if (event.repeat && !gesture.current) return;
              if (!gesture.current) beginSlider();
              if (gestureGeometry.current !== geometry()) {
                cancelSlider();
                return;
              }
              const max = Number(event.currentTarget.max);
              latestSlider.current =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? max
                    : Math.max(
                        0,
                        Math.min(
                          max,
                          latestSlider.current +
                            (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 1),
                        ),
                      );
              setSlider(latestSlider.current);
            }
          }}
          onKeyUp={(event) => {
            if (
              ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
            )
              commitSlider();
          }}
        />
      </label>
      <p>임시 길이: {slider}초. 놓거나 방향키를 뗄 때 적용하며 Escape로 취소합니다.</p>
      {session.durationSeconds === null ? (
        <p>
          계획 시간이 미정이므로 길이 손잡이는 사용할 수 없습니다. 초 단위 숫자를 입력해 먼저
          적용하세요.
        </p>
      ) : null}
      {resizeLocked && !past ? <p>강도 잠금을 먼저 해제하고 저장한 뒤 길이를 조절하세요.</p> : null}
    </section>
  );
}

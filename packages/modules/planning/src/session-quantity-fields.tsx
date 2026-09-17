import type { PlannedSession } from '@workout/contracts/planning';
import { TextField } from '@workout/ui-foundation/text-field';
import styles from './session-quantity-fields.module.css';

type Bounds = { min: number; max: number };
type QuantityPatch = Pick<
  PlannedSession,
  'durationSeconds' | 'durationRange' | 'distanceMeters' | 'distanceRange'
>;
function QuantityField({
  label,
  unit,
  limit,
  scalar,
  range,
  disabled,
  onChange,
}: {
  label: '시간' | '거리';
  unit: '초' | 'm';
  limit: number;
  scalar: number | null;
  range: Bounds | null | undefined;
  disabled: boolean;
  onChange(scalar: number | null, range: Bounds | null | undefined): void;
}) {
  const mode = range ? 'range' : scalar === null ? 'unknown' : 'single';
  const valid = (value: number) => Number.isFinite(value) && value >= 0 && value <= limit;
  const error =
    range && (!valid(range.min) || !valid(range.max) || range.min > range.max)
      ? `하한과 상한을 모두 0 이상 ${limit} 이하로 입력하고, 하한이 상한보다 크지 않게 하세요.`
      : scalar !== null && !valid(scalar)
        ? `0 이상 ${limit} 이하의 ${unit} 값을 입력하세요.`
        : undefined;
  const display = (value: number | null) =>
    value === null || !Number.isFinite(value) ? '' : value;
  return (
    <fieldset className={styles.quantity} disabled={disabled}>
      <legend>계획 {label}</legend>
      <label>
        계획 {label} 입력 방식
        <select
          value={mode}
          onChange={(event) => {
            if (disabled) return;
            if (event.target.value === 'unknown') onChange(null, null);
            if (event.target.value === 'single') onChange(Number.NaN, null);
            if (event.target.value === 'range')
              onChange(null, { min: Number.NaN, max: Number.NaN });
          }}
        >
          <option value="unknown">미정</option>
          <option value="single">단일값</option>
          <option value="range">범위</option>
        </select>
      </label>
      {range ? (
        <>
          <TextField
            label={`계획 ${label} 하한 (${unit})`}
            type="number"
            min="0"
            max={limit}
            step="any"
            value={display(range.min)}
            {...(error ? { error } : {})}
            onChange={(event) => {
              if (!disabled)
                onChange(null, {
                  ...range,
                  min: event.target.value === '' ? Number.NaN : Number(event.target.value),
                });
            }}
          />
          <TextField
            label={`계획 ${label} 상한 (${unit})`}
            type="number"
            min="0"
            max={limit}
            step="any"
            value={display(range.max)}
            {...(error ? { error } : {})}
            onChange={(event) => {
              if (!disabled)
                onChange(null, {
                  ...range,
                  max: event.target.value === '' ? Number.NaN : Number(event.target.value),
                });
            }}
          />
        </>
      ) : (
        <TextField
          label={`${label} (${unit}, 미정 가능)`}
          type="number"
          min="0"
          max={limit}
          step="any"
          value={display(scalar)}
          {...(error ? { error } : {})}
          onChange={(event) => {
            if (!disabled)
              onChange(event.target.value === '' ? null : Number(event.target.value), range);
          }}
        />
      )}
      <p>
        범위의 하한과 상한은 모두 포함합니다. 입력 방식을 바꾸면 새 값을 입력해야 하며 기존 값에서
        추정하지 않습니다.
      </p>
    </fieldset>
  );
}
export function SessionQuantityFields({
  session,
  disabled,
  onChange,
}: {
  session: PlannedSession;
  disabled: boolean;
  onChange(patch: Partial<QuantityPatch>): void;
}) {
  return (
    <div className={styles.fields}>
      <QuantityField
        label="시간"
        unit="초"
        limit={604800}
        scalar={session.durationSeconds}
        range={
          session.durationRange
            ? { min: session.durationRange.minSeconds, max: session.durationRange.maxSeconds }
            : session.durationRange
        }
        disabled={disabled}
        onChange={(durationSeconds, range) =>
          onChange({
            durationSeconds,
            ...(range === undefined
              ? {}
              : {
                  durationRange:
                    range === null ? null : { minSeconds: range.min, maxSeconds: range.max },
                }),
          })
        }
      />
      <QuantityField
        label="거리"
        unit="m"
        limit={10000000}
        scalar={session.distanceMeters}
        range={
          session.distanceRange
            ? { min: session.distanceRange.minMeters, max: session.distanceRange.maxMeters }
            : session.distanceRange
        }
        disabled={disabled}
        onChange={(distanceMeters, range) =>
          onChange({
            distanceMeters,
            ...(range === undefined
              ? {}
              : {
                  distanceRange:
                    range === null ? null : { minMeters: range.min, maxMeters: range.max },
                }),
          })
        }
      />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import styles from './step-quantity-field.module.css';

export interface StepQuantityFieldProps {
  dimension: 'duration' | 'distance';
  value: number | null;
  onChange(value: number | null): void;
  disabled?: boolean;
  contextKey: string;
}
type Unit = 'seconds' | 'minutes' | 'meters' | 'kilometers';
const definitions = {
  duration: { label: '단계 시간', units: ['seconds', 'minutes'], maximum: 604800 },
  distance: { label: '단계 거리', units: ['meters', 'kilometers'], maximum: 10000000 },
} as const;
const units: Record<Unit, { label: string; factor: number }> = {
  seconds: { label: '초', factor: 1 },
  minutes: { label: '분', factor: 60 },
  meters: { label: 'm', factor: 1 },
  kilometers: { label: 'km', factor: 1000 },
};
function display(value: number | null, unit: Unit): string {
  if (value === null) return '';
  if (!Number.isFinite(value)) return 'NaN';
  const factor = units[unit].factor;
  const converted = value / factor;
  if (converted !== 0 || value === 0) return String(converted);
  // Preserve subnormal canonical quantities instead of displaying positive values as zero.
  const [mantissa = '0', exponent = '0'] = value.toExponential().split('e');
  return factor === 1000
    ? `${mantissa}e${Number(exponent) - 3}`
    : `${Number(mantissa) / 6}e${Number(exponent) - 1}`;
}
function parseCanonical(text: string, unit: Unit, maximum: number): number | null {
  if (text === '') return null;
  if (text.length > 4096) return Number.NaN;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return Number.NaN;
  const [mantissa = '', exponent = '0'] = text.toLowerCase().split('e');
  const digits = mantissa.replace('.', '');
  const fractionLength = mantissa.includes('.') ? mantissa.length - mantissa.indexOf('.') - 1 : 0;
  // Decimal multiplication rounds only once into the canonical IEEE-754 number.
  const scaled = BigInt(digits) * BigInt(units[unit].factor);
  const value = Number(`${scaled}e${Number(exponent) - fractionLength}`);
  return Number.isFinite(value) && value <= maximum && (value !== 0 || scaled === 0n)
    ? value
    : Number.NaN;
}
interface Review {
  from: Unit;
  to: Unit;
  value: number | null;
  contextKey: string;
}
export function StepQuantityField(props: StepQuantityFieldProps) {
  return <QuantityInput key={props.dimension} {...props} />;
}
function QuantityInput({
  dimension,
  value,
  onChange,
  disabled = false,
  contextKey,
}: StepQuantityFieldProps) {
  const definition = definitions[dimension];
  const [unit, setUnit] = useState<Unit>(definition.units[0]);
  const [raw, setRaw] = useState<{ text: string; canonical: number | null; unit: Unit } | null>(
    null,
  );
  const [review, setReview] = useState<Review | null>(null);
  const select = useRef<HTMLSelectElement | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef(false);
  const canonicalValid =
    value === null || (Number.isFinite(value) && value >= 0 && value <= definition.maximum);
  const text =
    raw && raw.unit === unit && Object.is(raw.canonical, value) ? raw.text : display(value, unit);
  const currentReview =
    review &&
    !disabled &&
    canonicalValid &&
    Object.is(review.value, value) &&
    review.contextKey === contextKey &&
    review.from === unit;
  if (review && !currentReview) setReview(null);
  useEffect(() => {
    if (review) cancel.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      select.current?.focus();
    }
  }, [review]);
  function edit(nextText: string) {
    if (disabled) return;
    setReview(null);
    let next = parseCanonical(nextText, unit, definition.maximum);
    const shown = display(value, unit);
    // Re-entering the displayed approximation must not change the original canonical value.
    if (
      canonicalValid &&
      typeof next === 'number' &&
      Number.isFinite(next) &&
      (nextText === shown || (Number(shown) !== 0 && Number(nextText) === Number(shown)))
    )
      next = value;
    setRaw({ text: nextText, canonical: next, unit });
    if (!Object.is(next, value)) onChange(next);
  }
  return (
    <div className={styles.field}>
      <TextField
        label={`${definition.label} (${units[unit].label})`}
        type="text"
        inputMode="decimal"
        maxLength={4096}
        value={text}
        disabled={disabled || Boolean(review)}
        {...(!canonicalValid
          ? {
              error: `0 이상 ${definition.maximum}${units[definition.units[0]].label} 이하의 유한한 수를 입력하세요. 비워 두면 미정입니다.`,
            }
          : {})}
        onChange={(event) => edit(event.target.value)}
      />
      <label className={styles.unit}>
        {definition.label} 단위
        <select
          ref={select}
          value={unit}
          disabled={disabled || !canonicalValid}
          onChange={(event) => {
            const selected = definition.units.find((option) => option === event.target.value);
            if (!selected || selected === unit || disabled || !canonicalValid) return;
            setReview({ from: unit, to: selected, value, contextKey });
          }}
        >
          {definition.units.map((option) => (
            <option key={option} value={option}>
              {units[option].label}
            </option>
          ))}
        </select>
      </label>
      {review && currentReview ? (
        <fieldset aria-label={`${definition.label} 단위 전환 확인`} className={styles.confirm}>
          <legend>{definition.label} 단위 전환 확인</legend>
          <p>
            {value === null ? '미정' : `${display(value, review.from)} ${units[review.from].label}`}{' '}
            → {value === null ? '미정' : `${display(value, review.to)} ${units[review.to].label}`}
          </p>
          <p>입력·표시 단위만 바꿉니다. 저장된 초·미터 값과 계획 초안은 변경하지 않습니다.</p>
          <div className={styles.actions}>
            <Button
              onClick={() => {
                if (!currentReview || disabled) return;
                setUnit(review.to);
                setRaw(null);
                returnFocus.current = true;
                setReview(null);
              }}
            >
              {definition.label} 단위 전환 적용
            </Button>
            <Button
              ref={cancel}
              variant="secondary"
              onClick={() => {
                returnFocus.current = true;
                setReview(null);
              }}
            >
              {definition.label} 단위 전환 취소
            </Button>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

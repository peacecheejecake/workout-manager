import type {
  ActiveIntakeEntry,
  FoodDefinitionVersion,
  NutrientValueCoverage,
  RecordedFoodPortion,
} from '@workout/contracts/nutrition-core';
import type { NutrientSnapshot } from '@workout/contracts/nutrition';

export const nutrientFields = [
  { key: 'energy', label: '섭취 에너지', unit: 'kcal' },
  { key: 'carbohydrate', label: '탄수화물', unit: 'g' },
  { key: 'protein', label: '단백질', unit: 'g' },
  { key: 'fat', label: '지방', unit: 'g' },
  { key: 'fluid', label: '수분', unit: 'mL' },
  { key: 'sodium', label: '나트륨', unit: 'mg' },
] as const;
export type NutrientKey = (typeof nutrientFields)[number]['key'];
export type NutrientInput = Record<NutrientKey, string>;

function datum<U extends string>(unit: U, value: number | null) {
  return {
    value,
    unit,
    status: value === null ? ('unknown' as const) : ('reported' as const),
    evidenceIds: [],
  };
}

export function unknownNutrients(): NutrientSnapshot {
  return {
    energy: datum('kcal', null),
    carbohydrate: datum('g', null),
    protein: datum('g', null),
    fat: datum('g', null),
    fluid: datum('mL', null),
    sodium: datum('mg', null),
  };
}

export function nutrientInputs(snapshot: NutrientSnapshot): NutrientInput {
  return {
    energy: snapshot.energy.value === null ? '' : String(snapshot.energy.value),
    carbohydrate: snapshot.carbohydrate.value === null ? '' : String(snapshot.carbohydrate.value),
    protein: snapshot.protein.value === null ? '' : String(snapshot.protein.value),
    fat: snapshot.fat.value === null ? '' : String(snapshot.fat.value),
    fluid: snapshot.fluid.value === null ? '' : String(snapshot.fluid.value),
    sodium: snapshot.sodium.value === null ? '' : String(snapshot.sodium.value),
  };
}

/** Blank remains unknown; an explicit zero remains a reported value. */
export function parseNutrientInputs(input: NutrientInput): NutrientSnapshot | null {
  const read = (raw: string) => {
    if (raw.trim() === '') return { valid: true, value: null };
    const value = Number(raw);
    return { valid: Number.isFinite(value) && value >= 0, value };
  };
  const energy = read(input.energy);
  const carbohydrate = read(input.carbohydrate);
  const protein = read(input.protein);
  const fat = read(input.fat);
  const fluid = read(input.fluid);
  const sodium = read(input.sodium);
  if (![energy, carbohydrate, protein, fat, fluid, sodium].every((item) => item.valid)) return null;
  return {
    energy: datum('kcal', energy.value),
    carbohydrate: datum('g', carbohydrate.value),
    protein: datum('g', protein.value),
    fat: datum('g', fat.value),
    fluid: datum('mL', fluid.value),
    sodium: datum('mg', sodium.value),
  };
}

/** The saved snapshot is a one-time calculation from a frozen food version. */
export function frozenFoodNutrients(
  food: FoodDefinitionVersion,
  quantity: number,
  unit: RecordedFoodPortion['unit'],
): NutrientSnapshot | null {
  if (!Number.isFinite(quantity) || quantity < 0) return null;
  const factor =
    food.basis.kind === 'per_100g' && unit === 'g'
      ? quantity / 100
      : food.basis.kind === 'per_100mL' && unit === 'mL'
        ? quantity / 100
        : food.basis.kind === 'per_serving' && unit === 'serving'
          ? quantity
          : null;
  if (factor === null) return null;
  const value = <K extends NutrientKey>(key: K) => {
    const source = food.nutrients[key];
    return source.value === null ? null : source.value * factor;
  };
  return {
    energy: datum('kcal', value('energy')),
    carbohydrate: datum('g', value('carbohydrate')),
    protein: datum('g', value('protein')),
    fat: datum('g', value('fat')),
    fluid: datum('mL', value('fluid')),
    sodium: datum('mg', value('sodium')),
  };
}

export function dayInTimezone(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** UTC guard band covers all IANA offsets; the UI filters to the selected local day. */
export function intakeUtcWindow(day: string): { from: string; toExclusive: string } {
  const midnight = Date.parse(`${day}T00:00:00.000Z`);
  return {
    from: new Date(midnight - 86_400_000).toISOString(),
    toExclusive: new Date(midnight + 2 * 86_400_000).toISOString(),
  };
}

export function nextCalendarDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function dayIntakes(entries: ActiveIntakeEntry[], day: string, timezone: string) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.intakeId) || dayInTimezone(entry.occurredAt, timezone) !== day) return false;
    seen.add(entry.intakeId);
    return true;
  });
}

/** Known subtotal is explicitly incomplete when any recorded entry has an unknown metric. */
export function knownSubtotal(entries: ActiveIntakeEntry[], key: NutrientKey) {
  let known = 0;
  let knownCount = 0;
  let missing = 0;
  for (const entry of entries) {
    const value = entry.nutrientTotal[key].value;
    if (value === null) missing++;
    else {
      known += value;
      knownCount++;
    }
  }
  return { known, knownCount, missing };
}

export function coverageLabel(coverage: NutrientValueCoverage, entries: number) {
  if (entries === 0) return '섭취 기록 없음 · 먹지 않았다는 뜻이 아닙니다.';
  if (coverage === 'unknown') return '영양값 미상 · 기록된 음식 이름만 표시합니다.';
  if (coverage === 'partial') return '부분 기록 · 표시된 영양 합계는 알려진 값만 포함합니다.';
  return '기록된 항목의 영양값이 모두 입력되었습니다. 하루 전체 섭취 확인은 아닙니다.';
}

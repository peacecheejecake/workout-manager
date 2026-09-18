import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FoodDefinitionVersion } from '@workout/contracts/nutrition-core';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import { NutritionRequestError } from './nutrition-api';
import {
  nutrientFields,
  nutrientInputs,
  parseNutrientInputs,
  type NutrientInput,
} from './nutrition-model';
import type { NutritionApi, NutritionScope } from './nutrition-workspace';
import styles from './nutrition.module.css';

type FoodForm = {
  name: string;
  basis: 'per_100g' | 'per_100mL' | 'per_serving';
  servingQuantity: string;
  servingUnit: 'g' | 'mL' | 'piece';
  servingLabel: string;
  nutrients: NutrientInput;
};
function blank(): FoodForm {
  return {
    name: '',
    basis: 'per_serving',
    servingQuantity: '1',
    servingUnit: 'piece',
    servingLabel: '1회분',
    nutrients: {
      energy: '',
      carbohydrate: '',
      protein: '',
      fat: '',
      fluid: '',
      sodium: '',
    },
  };
}
function fromFood(food: FoodDefinitionVersion): FoodForm {
  return {
    name: food.name,
    basis: food.basis.kind,
    servingQuantity: food.basis.kind === 'per_serving' ? String(food.basis.serving.quantity) : '1',
    servingUnit: food.basis.kind === 'per_serving' ? food.basis.serving.unit : 'piece',
    servingLabel: food.basis.kind === 'per_serving' ? food.basis.serving.label : '1회분',
    nutrients: nutrientInputs(food.nutrients),
  };
}

export function FoodEditor({ api, scope }: { api: NutritionApi; scope: NutritionScope }) {
  const client = useQueryClient();
  const foods = useQuery({
    queryKey: [...scope, 'foods'],
    queryFn: ({ signal }) => api.listFoods(signal),
  });
  const [selected, setSelected] = useState<FoodDefinitionVersion | null>(null);
  const [form, setForm] = useState<FoodForm>(blank);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState('');
  const key = useRef<string | null>(null);
  function start(food: FoodDefinitionVersion | null) {
    setSelected(food);
    setForm(food ? fromFood(food) : blank());
    setOpen(true);
    setNotice('');
    setLocked(false);
    key.current = null;
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || locked) return;
    const values = parseNutrientInputs(form.nutrients);
    if (values === null) {
      setNotice('영양값은 0 이상의 숫자 또는 빈칸으로 입력하세요.');
      return;
    }
    const servingQuantity = Number(form.servingQuantity);
    if (
      form.basis === 'per_serving' &&
      (!Number.isFinite(servingQuantity) || servingQuantity <= 0)
    ) {
      setNotice('1회분 기준량은 0보다 커야 합니다.');
      return;
    }
    const idempotencyKey = key.current ?? crypto.randomUUID();
    key.current = idempotencyKey;
    setBusy(true);
    setNotice('');
    try {
      const saved = await api.saveFood({
        idempotencyKey,
        expectedVersionId: selected?.versionId ?? null,
        confirmed: true,
        definition: {
          foodId: selected?.foodId ?? crypto.randomUUID(),
          name: form.name.trim(),
          basis:
            form.basis === 'per_serving'
              ? {
                  kind: 'per_serving',
                  serving: {
                    quantity: servingQuantity,
                    unit: form.servingUnit,
                    label: form.servingLabel.trim(),
                  },
                }
              : { kind: form.basis },
          nutrients: values,
          provenance: {
            kind: 'user_entered',
            reference: null,
            capturedAt: new Date().toISOString(),
            reviewState: 'unreviewed',
          },
        },
      });
      key.current = null;
      setSelected(saved);
      setOpen(false);
      setNotice(
        `식품 정의 ${saved.version}버전을 저장했습니다. 기존 섭취 기록의 값은 바뀌지 않습니다.`,
      );
      await client.invalidateQueries({ queryKey: [...scope, 'foods'] });
    } catch (error) {
      if (error instanceof NutritionRequestError && [400, 404, 409].includes(error.status)) {
        key.current = null;
        setNotice(
          error.status === 409
            ? '식품 정의가 변경되었습니다. 목록을 새로고침하고 다시 선택하세요.'
            : '입력값 또는 식품 버전을 확인하세요. 저장되지 않았습니다.',
        );
      } else {
        setLocked(true);
        setNotice('저장 결과를 확인할 수 없습니다. 중복 저장을 피하려면 목록을 다시 불러오세요.');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.card} aria-labelledby="food-definitions-title">
      <div className={styles.sectionHead}>
        <h2 id="food-definitions-title">내 식품 정의</h2>
        <Button variant="secondary" onClick={() => start(null)}>
          식품 추가
        </Button>
      </div>
      <p>기준량과 영양값은 버전별로 보존합니다. 빈칸은 미상이며 0과 다릅니다.</p>
      {foods.isPending ? <p role="status">식품 목록 불러오는 중</p> : null}
      {foods.isError ? (
        <p role="alert">
          식품 목록을 불러오지 못했습니다.{' '}
          <Button
            variant="secondary"
            onClick={() => {
              void foods.refetch();
            }}
          >
            다시 불러오기
          </Button>
        </p>
      ) : null}
      {foods.data?.nextCursor !== null && foods.data !== undefined ? (
        <p role="status">목록의 일부만 표시됩니다.</p>
      ) : null}
      {foods.data?.foods.length === 0 ? <p>저장한 식품이 없습니다.</p> : null}
      <ul className={styles.list}>
        {foods.data?.foods.map((food) => (
          <li key={food.foodId}>
            {food.provenance.kind === 'user_entered' ? (
              <Button variant="secondary" onClick={() => start(food)}>
                {food.name} · v{food.version} 편집
              </Button>
            ) : (
              <span>
                {food.name} · v{food.version} · 외부 출처 (이 화면에서 편집 불가)
              </span>
            )}
            <span>
              {' '}
              {food.basis.kind === 'per_serving'
                ? `${food.basis.serving.label}당`
                : food.basis.kind === 'per_100g'
                  ? '100g당'
                  : '100mL당'}
            </span>
          </li>
        ))}
      </ul>
      {notice ? (
        <p role={locked ? 'alert' : 'status'} className={styles.notice}>
          {notice}
        </p>
      ) : null}
      {open ? (
        <form
          onSubmit={(event) => {
            void save(event);
          }}
          className={styles.form}
        >
          <h3>{selected ? '식품 정의 수정' : '새 식품 정의'}</h3>
          <TextField
            label="식품·제품 이름"
            value={form.name}
            maxLength={160}
            required
            disabled={busy || locked}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <label>
            영양 기준
            <select
              value={form.basis}
              disabled={busy || locked}
              onChange={(event) =>
                setForm({ ...form, basis: event.target.value as FoodForm['basis'] })
              }
            >
              <option value="per_serving">1회분당</option>
              <option value="per_100g">100g당</option>
              <option value="per_100mL">100mL당</option>
            </select>
          </label>
          {form.basis === 'per_serving' ? (
            <div className={styles.row}>
              <TextField
                label="1회분 기준량"
                type="number"
                min="0.001"
                step="any"
                value={form.servingQuantity}
                required
                disabled={busy || locked}
                onChange={(event) => setForm({ ...form, servingQuantity: event.target.value })}
              />
              <label>
                기준 단위
                <select
                  value={form.servingUnit}
                  disabled={busy || locked}
                  onChange={(event) =>
                    setForm({ ...form, servingUnit: event.target.value as FoodForm['servingUnit'] })
                  }
                >
                  <option value="piece">개</option>
                  <option value="g">g</option>
                  <option value="mL">mL</option>
                </select>
              </label>
              <TextField
                label="1회분 설명"
                value={form.servingLabel}
                maxLength={160}
                required
                disabled={busy || locked}
                onChange={(event) => setForm({ ...form, servingLabel: event.target.value })}
              />
            </div>
          ) : null}
          <div className={styles.metricFields}>
            {nutrientFields.map((field) => (
              <TextField
                key={field.key}
                label={`${field.label} (${field.unit}, 미상은 빈칸)`}
                type="number"
                min="0"
                step="any"
                value={form.nutrients[field.key]}
                disabled={busy || locked}
                onChange={(event) =>
                  setForm({
                    ...form,
                    nutrients: { ...form.nutrients, [field.key]: event.target.value },
                  })
                }
              />
            ))}
          </div>
          <div className={styles.actions}>
            <Button type="submit" disabled={busy || locked}>
              {busy ? '저장 중' : '확인하고 식품 정의 저장'}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              닫기
            </Button>
            {locked ? (
              <Button
                variant="secondary"
                onClick={() => {
                  void foods.refetch();
                  setOpen(false);
                }}
              >
                목록 다시 확인
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
    </section>
  );
}

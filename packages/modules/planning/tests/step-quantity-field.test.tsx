import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StepQuantityField, type StepQuantityFieldProps } from '../src/step-quantity-field';

function setup(
  initial: number | null,
  dimension: StepQuantityFieldProps['dimension'] = 'duration',
) {
  const change = vi.fn<(value: number | null) => void>();
  function Host({
    disabled = false,
    contextKey = 'session:step:0',
    override,
    fieldsetDisabled = false,
  }: {
    disabled?: boolean;
    contextKey?: string;
    override?: number | null;
    fieldsetDisabled?: boolean;
  }) {
    const [value, setValue] = useState(initial);
    return (
      <fieldset disabled={fieldsetDisabled}>
        <StepQuantityField
          dimension={dimension}
          value={override === undefined ? value : override}
          contextKey={contextKey}
          disabled={disabled}
          onChange={(next) => {
            change(next);
            setValue(next);
          }}
        />
      </fieldset>
    );
  }
  const view = (props: Parameters<typeof Host>[0] = {}) => <Host {...props} />;
  return { ...render(view()), view, change };
}
async function switchUnit(
  user: ReturnType<typeof userEvent.setup>,
  dimension: '시간' | '거리',
  unit: string,
) {
  await user.selectOptions(screen.getByRole('combobox', { name: `단계 ${dimension} 단위` }), unit);
  await user.click(screen.getByRole('button', { name: `단계 ${dimension} 단위 전환 적용` }));
}

describe('step quantity unit confirmation', () => {
  it('previews duration conversion, cancels with focus restoration and changes only display after explicit confirmation', async () => {
    const app = setup(61.25);
    const user = userEvent.setup();
    const choice = screen.getByRole('combobox', { name: '단계 시간 단위' });
    expect(screen.getByRole('textbox', { name: '단계 시간 (초)' })).toHaveValue('61.25');
    await user.selectOptions(choice, 'minutes');
    const preview = screen.getByRole('group', { name: '단계 시간 단위 전환 확인' });
    expect(preview).toHaveTextContent('61.25 초 → 1.0208333333333333 분');
    expect(choice).toHaveValue('seconds');
    expect(screen.getByRole('textbox', { name: '단계 시간 (초)' })).toBeDisabled();
    const cancel = within(preview).getByRole('button', { name: '단계 시간 단위 전환 취소' });
    expect(cancel).toHaveFocus();
    await user.click(cancel);
    expect(choice).toHaveFocus();
    expect(choice).toHaveValue('seconds');
    await switchUnit(user, '시간', 'minutes');
    expect(choice).toHaveValue('minutes');
    expect(choice).toHaveFocus();
    expect(screen.getByRole('textbox', { name: '단계 시간 (분)' })).toHaveValue(
      '1.0208333333333333',
    );
    expect(app.change).not.toHaveBeenCalled();
  });

  it.each([null, 0])('preserves %s independently from unit preferences', async (value) => {
    const app = setup(value, 'distance');
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole('combobox', { name: '단계 거리 단위' }),
      'kilometers',
    );
    expect(screen.getByRole('group', { name: '단계 거리 단위 전환 확인' })).toHaveTextContent(
      value === null ? '미정 → 미정' : '0 m → 0 km',
    );
    await user.click(screen.getByRole('button', { name: '단계 거리 단위 전환 적용' }));
    expect(screen.getByRole('textbox', { name: '단계 거리 (km)' })).toHaveValue(
      value === null ? '' : '0',
    );
    expect(app.change).not.toHaveBeenCalled();
    if (value === null) {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '0' } });
      expect(app.change).toHaveBeenLastCalledWith(0);
    } else {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
      expect(app.change).toHaveBeenLastCalledWith(null);
    }
  });

  it('avoids accumulated rounding through repeated display changes and unchanged displayed approximation input', async () => {
    const original = 0.10000000000000002;
    const app = setup(original);
    const user = userEvent.setup();
    for (let index = 0; index < 4; index++) {
      await switchUnit(user, '시간', 'minutes');
      fireEvent.change(screen.getByRole('textbox'), { target: { value: String(original / 60) } });
      await switchUnit(user, '시간', 'seconds');
      expect(screen.getByRole('textbox')).toHaveValue(String(original));
    }
    expect(app.change).not.toHaveBeenCalled();
  });

  it.each([
    {
      dimension: 'duration' as const,
      label: '시간' as const,
      unit: 'minutes',
      input: '0.1',
      expected: 6,
    },
    {
      dimension: 'distance' as const,
      label: '거리' as const,
      unit: 'kilometers',
      input: '1.001',
      expected: 1001,
    },
    {
      dimension: 'distance' as const,
      label: '거리' as const,
      unit: 'kilometers',
      input: '1.23456789012345',
      expected: 1234.56789012345,
    },
  ])(
    'converts a changed $dimension input once at canonical precision',
    async ({ dimension, label, unit, input, expected }) => {
      const app = setup(null, dimension);
      await switchUnit(userEvent.setup(), label, unit);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: input } });
      expect(app.change).toHaveBeenCalledTimes(1);
      expect(app.change).toHaveBeenLastCalledWith(expected);
    },
  );

  it.each([
    {
      dimension: 'duration' as const,
      label: '시간' as const,
      unit: 'minutes',
      maximum: '10080',
      overflow: '10080.0001',
      canonical: 604800,
    },
    {
      dimension: 'distance' as const,
      label: '거리' as const,
      unit: 'kilometers',
      maximum: '10000',
      overflow: '10000.0001',
      canonical: 10000000,
    },
  ])(
    'enforces canonical bounds for $dimension in converted units',
    async ({ dimension, label, unit, maximum, overflow, canonical }) => {
      const app = setup(null, dimension);
      await switchUnit(userEvent.setup(), label, unit);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: maximum } });
      expect(app.change).toHaveBeenLastCalledWith(canonical);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: overflow } });
      expect(app.change).toHaveBeenLastCalledWith(Number.NaN);
      expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('combobox')).toBeDisabled();
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '0.25' } });
      expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-invalid');
      expect(screen.getByRole('combobox')).toBeEnabled();
    },
  );

  it('keeps invalid raw input visible as a schema-blocking sentinel and coalesces repeated invalid changes', () => {
    const app = setup(1);
    for (const input of [
      '1e',
      '-1',
      'Infinity',
      '0x10',
      ' 1 ',
      '1e9999',
      '1e-9999',
      '9'.repeat(4097),
    ]) {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: input } });
      expect(screen.getByRole('textbox')).toHaveValue(input);
      expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
      expect(app.change).toHaveBeenLastCalledWith(Number.NaN);
    }
    expect(app.change).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '.125' } });
    expect(app.change).toHaveBeenLastCalledWith(0.125);
    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-invalid');
  });

  it('retains nonzero subnormal canonical values rather than displaying or converting them to zero', async () => {
    const app = setup(Number.MIN_VALUE, 'distance');
    const user = userEvent.setup();
    await switchUnit(user, '거리', 'kilometers');
    expect(screen.getByRole('textbox')).toHaveValue('5e-327');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '5e-327' } });
    expect(app.change).not.toHaveBeenCalled();
    await switchUnit(user, '거리', 'meters');
    expect(screen.getByRole('textbox')).toHaveValue(String(Number.MIN_VALUE));
    expect(app.change).not.toHaveBeenCalled();
  });

  it.each(['value', 'context', 'disabled'] as const)(
    'invalidates a pending conversion on changed %s without reviving it when props revert',
    async (boundary) => {
      const app = setup(61.25);
      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox'), 'minutes');
      app.rerender(
        app.view(
          boundary === 'value'
            ? { override: 90 }
            : boundary === 'context'
              ? { contextKey: 'session:step:1' }
              : { disabled: true },
        ),
      );
      expect(
        screen.queryByRole('group', { name: '단계 시간 단위 전환 확인' }),
      ).not.toBeInTheDocument();
      app.rerender(app.view());
      expect(
        screen.queryByRole('group', { name: '단계 시간 단위 전환 확인' }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('combobox')).toHaveValue('seconds');
      expect(app.change).not.toHaveBeenCalled();
    },
  );

  it('honors inherited disabled fieldsets and exposes only units of its own dimension', async () => {
    const app = setup(1234.567, 'distance');
    const user = userEvent.setup();
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['m', 'km']);
    await user.selectOptions(screen.getByRole('combobox'), 'kilometers');
    app.rerender(app.view({ fieldsetDisabled: true }));
    const confirm = screen.getByRole('button', { name: '단계 거리 단위 전환 적용' });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(screen.getByRole('combobox')).toHaveValue('meters');
    expect(app.change).not.toHaveBeenCalled();
    app.rerender(app.view());
    await user.click(confirm);
    expect(screen.getByRole('textbox', { name: '단계 거리 (km)' })).toHaveValue('1.234567');
    expect(app.change).not.toHaveBeenCalled();
  });
});

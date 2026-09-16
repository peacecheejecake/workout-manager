import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AdaptiveWorkspace } from '../src/adaptive-workspace';
import { Button } from '../src/button';
import { TextAreaField, TextField } from '../src/text-field';
import { StatusNotice, type NoticeState } from '../src/status-notice';
import {
  fractionalBoundaryWidths,
  getContainerMode,
  getLayoutMode,
  responsiveSpec,
  viewportFixtures,
} from '../src/responsive';

describe('accessible controls', () => {
  it('supports keyboard activation without implicit form submission', async () => {
    const user = userEvent.setup();
    const click = vi.fn();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={submit}>
        <Button onClick={click}>초안 유지</Button>
        <Button disabled>승인 대기</Button>
      </form>,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: '초안 유지' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(click).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '승인 대기' }));
    expect(click).toHaveBeenCalledOnce();
  });

  it('links description, external context and validation errors to the native control', () => {
    render(
      <>
        <p id="unit">단위 km</p>
        <TextField
          label="거리"
          description="소수점 입력 가능"
          error="0 이상 입력하세요"
          aria-describedby="unit"
          inputMode="decimal"
        />
      </>,
    );
    const input = screen.getByRole('textbox', { name: '거리' });
    expect(input).toHaveAccessibleDescription('단위 km 소수점 입력 가능 0 이상 입력하세요');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('inputmode', 'decimal');
  });

  it('preserves the same focused textarea, IME handlers and draft across layout changes', async () => {
    const user = userEvent.setup();
    const composition = vi.fn();
    const workspace = (view: 'split' | 'stack') => (
      <AdaptiveWorkspace requestedView={view}>
        <TextAreaField label="활동 초안" defaultValue="" onCompositionEnd={composition} />
        <p>실제 활동을 저장하지 않습니다.</p>
      </AdaptiveWorkspace>
    );
    const { rerender } = render(workspace('split'));
    const input = screen.getByRole('textbox', { name: '활동 초안' });
    await user.click(input);
    await user.type(input, 'draft');
    fireEvent.compositionStart(input);
    rerender(workspace('stack'));
    fireEvent.compositionEnd(input, { data: '운동' });
    expect(screen.getByRole('textbox', { name: '활동 초안' })).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue('draft');
    expect(composition).toHaveBeenCalledOnce();
    rerender(workspace('split'));
    expect(input).toHaveValue('draft');
  });

  it('uses distinct generated IDs for repeated labelled fields', () => {
    render(
      <>
        <TextField label="시작" />
        <TextField label="종료" />
      </>,
    );
    expect(screen.getByRole('textbox', { name: '시작' }).id).not.toBe(
      screen.getByRole('textbox', { name: '종료' }).id,
    );
  });
});

describe('explicit asynchronous state', () => {
  it.each<NoticeState>([
    'loading',
    'empty',
    'partial',
    'error',
    'stale',
    'unavailable',
    'sync-pending',
  ])('keeps %s meaning and recovery action available', (state) => {
    render(
      <StatusNotice state={state} action={<Button>다시 시도</Button>}>
        값을 확인할 수 없습니다.
      </StatusNotice>,
    );
    expect(screen.getByRole(state === 'error' ? 'alert' : 'status')).toHaveTextContent(
      '값을 확인할 수 없습니다.',
    );
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeEnabled();
  });
});

describe('generated responsive specification', () => {
  it('classifies fractional widths without gaps and preserves canonical fixtures', () => {
    expect(fractionalBoundaryWidths.map(getLayoutMode)).toEqual([
      'mobile',
      'tablet',
      'tablet',
      'desktop',
    ]);
    expect(viewportFixtures.map((fixture) => fixture.width)).toEqual(
      responsiveSpec.testWidthsCssPx,
    );
    expect(getLayoutMode(responsiveSpec.reflowTestMinWidthPx)).toBe('mobile');
  });
  it('classifies actual module width independently of viewport', () => {
    const { standardMinPx, workspaceMinPx } = responsiveSpec.componentContainers;
    expect(getContainerMode(standardMinPx - 0.1)).toBe('compact');
    expect(getContainerMode(standardMinPx)).toBe('standard');
    expect(getContainerMode(workspaceMinPx - 0.1)).toBe('standard');
    expect(getContainerMode(workspaceMinPx)).toBe('workspace');
  });
  it.each([-1, NaN, Infinity])('rejects invalid measured width %s', (width) => {
    expect(() => getLayoutMode(width)).toThrow(RangeError);
    expect(() => getContainerMode(width)).toThrow(RangeError);
  });
});

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ConversationComposer, type ConversationComposerProps } from '../src/composer';

afterEach(cleanup);
const base: ConversationComposerProps = {
  value: '초안\n둘째 줄',
  label: '메시지',
  submitLabel: '기록 저장',
  maxLength: 8000,
  state: { kind: 'idle' },
  onChange: () => undefined,
  onSubmit: () => undefined,
};
it('preserves controlled text, plaintext slots and focus across pending state changes', () => {
  const { rerender } = render(
    <ConversationComposer {...base} help={<p>{'<script>literal</script>'}</p>} />,
  );
  const input = screen.getByRole('textbox');
  input.focus();
  rerender(<ConversationComposer {...base} state={{ kind: 'submitting', message: '저장 중' }} />);
  expect(input).toHaveFocus();
  expect(input).toHaveValue(base.value);
  expect(screen.getByRole('button', { name: '기록 저장' })).toBeDisabled();
  expect(input).toHaveAttribute('readonly');
});
it('requires opt-in shortcut and rejects IME, repeated and modified shortcuts', () => {
  const submit = vi.fn();
  const { rerender } = render(<ConversationComposer {...base} onSubmit={submit} />);
  const input = screen.getByRole('textbox');
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  expect(submit).not.toHaveBeenCalled();
  rerender(<ConversationComposer {...base} onSubmit={submit} shortcut="control-enter" />);
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: true });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, repeat: true });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, altKey: true });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
  expect(submit).toHaveBeenCalledTimes(1);
});
it('delegates changes without clearing owner draft and offers no submit while uncertain or invalid', () => {
  const submit = vi.fn();
  function Owner() {
    const [value, change] = useState('');
    return <ConversationComposer {...base} value={value} onChange={change} onSubmit={submit} />;
  }
  const { unmount } = render(<Owner />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ' } });
  expect(screen.getByRole('button')).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '새 초안' } });
  fireEvent.click(screen.getByRole('button'));
  expect(submit).toHaveBeenCalledOnce();
  expect(screen.getByRole('textbox')).toHaveValue('새 초안');
  unmount();
  render(
    <ConversationComposer
      {...base}
      onSubmit={submit}
      state={{ kind: 'uncertain', message: '확인 필요' }}
    />,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('확인 필요');
  expect(screen.getByRole('button')).toBeDisabled();
});
it('associates help and current state without dangling descriptions after returning idle', () => {
  const { rerender } = render(
    <ConversationComposer
      {...base}
      help="Ctrl+Enter는 명시 저장"
      state={{ kind: 'conflict', message: '최신 기록을 다시 확인' }}
    />,
  );
  const input = screen.getByRole('textbox');
  expect(input).toHaveAccessibleDescription('Ctrl+Enter는 명시 저장 최신 기록을 다시 확인');
  const descriptionId = input.getAttribute('aria-describedby');
  rerender(<ConversationComposer {...base} help="Ctrl+Enter는 명시 저장" />);
  expect(input).toHaveAccessibleDescription('Ctrl+Enter는 명시 저장');
  expect(input.getAttribute('aria-describedby')).not.toBe(descriptionId);
  rerender(<ConversationComposer {...base} />);
  expect(input).not.toHaveAttribute('aria-describedby');
});
it.each([
  { state: { kind: 'uncertain', message: '결과 미확인' } as const, value: '초안', readOnly: false },
  {
    state: { kind: 'conflict', message: '최신 기록 필요' } as const,
    value: '초안',
    readOnly: false,
  },
  { state: { kind: 'unavailable', message: '저장 불가' } as const, value: '초안', readOnly: true },
  { state: { kind: 'idle' } as const, value: '초과 입력', readOnly: false },
])(
  'blocks click and shortcut for $state.kind and preserves owner text',
  ({ state, value, readOnly }) => {
    const submit = vi.fn();
    render(
      <ConversationComposer
        {...base}
        value={value}
        maxLength={3}
        state={state}
        shortcut="control-enter"
        onSubmit={submit}
      />,
    );
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue(value);
    if (readOnly) expect(input).toHaveAttribute('readonly');
    else expect(input).not.toHaveAttribute('readonly');
    expect(screen.getByRole('button')).toBeDisabled();
    fireEvent.click(screen.getByRole('button'));
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(submit).not.toHaveBeenCalled();
  },
);

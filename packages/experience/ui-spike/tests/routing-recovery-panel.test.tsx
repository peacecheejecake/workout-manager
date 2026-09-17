import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RoutingRecoveryPanel } from '../src/routing-recovery-panel';

describe('routing recovery fixture panel', () => {
  it('runs under StrictMode and keeps a newer error after an older success is delivered', async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <RoutingRecoveryPanel />
      </StrictMode>,
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: '합성 응답 시나리오' }),
      'success',
    );
    await user.click(screen.getByRole('button', { name: '경로 요청' }));
    await user.click(screen.getByRole('button', { name: '합성 도착점 바꾸기' }));
    expect(screen.getByText('초안 수정 번호: 2')).toBeVisible();
    await user.selectOptions(screen.getByRole('combobox', { name: '합성 응답 시나리오' }), '429');
    await user.click(screen.getByRole('button', { name: '경로 요청' }));
    await user.click(screen.getByRole('button', { name: '최신 응답 전달' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('429');
    await user.click(screen.getByRole('button', { name: '대기 응답 전달' }));
    expect(screen.getByRole('alert')).toHaveTextContent('429');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('합성 도착점: C')).toBeVisible();
    expect(screen.getByText('대기 응답: 0')).toBeVisible();
  });
  it('shows only explicit synthetic success, invalidates on edit and clears state on remount', async () => {
    const user = userEvent.setup();
    const tree = render(<RoutingRecoveryPanel />);
    await user.selectOptions(
      screen.getByRole('combobox', { name: '합성 응답 시나리오' }),
      'success',
    );
    await user.click(screen.getByRole('button', { name: '경로 요청' }));
    await user.click(screen.getByRole('button', { name: '대기 응답 전달' }));
    expect(await screen.findByRole('img')).toHaveAccessibleName(
      '합성 계산 결과 · 실제 보행 경로 아님',
    );
    await user.click(screen.getByRole('button', { name: '합성 도착점 바꾸기' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '경로 요청' }));
    tree.unmount();
    render(<RoutingRecoveryPanel />);
    expect(screen.getByText('초안 수정 번호: 1')).toBeVisible();
    expect(screen.getByText('대기 응답: 0')).toBeVisible();
  });
});

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  session: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  read: vi.fn(),
}));

import { NativeLanding } from '../../../apps/mobile-web/src/native-entry';

const client = {
  connect: mocks.connect,
  session: mocks.session,
  signIn: mocks.signIn,
  signOut: mocks.signOut,
  read: mocks.read,
  getCapabilities: () => ({ 'auth.transport': true }),
  openSettings: async () => ({ ok: true, value: undefined }),
} as unknown as NonNullable<ComponentProps<typeof NativeLanding>['client']>;

const signedIn = (athleteId = 'alice') => ({
  ok: true as const,
  value: { state: 'signed_in' as const, athleteId, expiresAt: '2030-01-01T00:00:00Z' },
});

async function openNote() {
  render(<NativeLanding client={client} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '작업 메모 (임시) 열기' }));
  const input = screen.getByRole('textbox', { name: '작업 메모' });
  await user.type(input, '임시 메모');
  return { user, input };
}

describe('iOS native product shell draft and lifecycle', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/');
    vi.spyOn(history, 'back').mockImplementation(() => {});
    localStorage.clear();
    mocks.connect.mockReset().mockResolvedValue({
      ok: true,
      value: { 'auth.transport': true, 'app.openSettings': true },
    });
    mocks.session.mockReset().mockResolvedValue(signedIn());
    mocks.signIn.mockReset().mockResolvedValue(signedIn());
    mocks.signOut.mockReset().mockResolvedValue({ ok: true, value: undefined });
    mocks.read.mockReset().mockResolvedValue({
      ok: true,
      value: { status: 200, body: { kind: 'ai', granted: false, revision: 1 } },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    history.replaceState(null, '', '/');
  });

  it('asks before button Back and keeps the draft and focus on continue editing', async () => {
    const { user, input } = await openNote();
    await user.click(screen.getByRole('button', { name: /^뒤로$/ }));
    const dialog = screen.getByRole('alertdialog', { name: '저장되지 않은 변경사항' });
    expect(input.parentElement).toHaveAttribute('inert');
    await user.click(within(dialog).getByRole('button', { name: '계속 편집' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(input).toHaveValue('임시 메모');
    await waitFor(() => expect(input).toHaveFocus());
    await user.click(screen.getByRole('button', { name: /^뒤로$/ }));
    await user.click(screen.getByRole('button', { name: '뒤로 이동' }));
    expect(history.back).toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: '작업 메모' })).toBeNull();
    expect(await screen.findByRole('button', { name: '작업 메모 (임시) 열기' })).toBeVisible();
  });

  it('routes native edge and browser history Back through the same confirmation', async () => {
    const { user, input } = await openNote();
    expect(input).toHaveFocus();
    await act(async () => window.dispatchEvent(new Event('workout:native-back')));
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(input).not.toHaveFocus();
    expect(screen.getByRole('button', { name: '계속 편집' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: '계속 편집' }));
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue('임시 메모');
    history.replaceState(null, '', '/');
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate', { state: null })));
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(history.state).toMatchObject({ workoutNativeScreen: 'note' });
    expect(input).toHaveValue('임시 메모');
  });

  it('does not interrupt a Korean IME composition on Back', async () => {
    const { input } = await openNote();
    await act(async () => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      window.dispatchEvent(new Event('workout:native-back'));
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(async () =>
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })),
    );
    await act(async () => window.dispatchEvent(new Event('workout:native-back')));
    expect(screen.getByRole('alertdialog')).toBeVisible();
  });

  it('retains an unsaved draft on an uncertain foreground check, then clears it on 401', async () => {
    const { input } = await openNote();
    mocks.session.mockResolvedValueOnce({ ok: false, code: 'UNAVAILABLE' });
    await act(async () => window.dispatchEvent(new Event('workout:native-foreground')));
    expect(await screen.findByRole('alert')).toHaveTextContent('임시 메모는 유지됩니다');
    expect(input).toHaveValue('임시 메모');
    mocks.session.mockResolvedValueOnce({ ok: true, value: { state: 'signed_out' } });
    await act(async () => window.dispatchEvent(new Event('workout:native-foreground')));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '작업 메모' })).toBeNull());
    expect(localStorage.getItem('workout:private:account-scope')).toBeNull();
  });

  it('clears an earlier foreground uncertainty after successful sign-in', async () => {
    mocks.session.mockResolvedValueOnce({ ok: true, value: { state: 'signed_out' } });
    render(<NativeLanding client={client} />);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: '시스템 로그인' });
    mocks.session.mockResolvedValueOnce({ ok: false, code: 'UNAVAILABLE' });
    await act(async () => window.dispatchEvent(new Event('workout:native-foreground')));
    await waitFor(() => expect(mocks.session).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole('button', { name: '시스템 로그인' }));
    await screen.findByRole('button', { name: '작업 메모 (임시) 열기' });
    expect(
      screen.queryByText('계정 상태를 확인할 수 없습니다. 임시 메모는 유지됩니다.'),
    ).toBeNull();

    mocks.session.mockResolvedValueOnce({ ok: false, code: 'UNAVAILABLE' });
    await act(async () => window.dispatchEvent(new Event('workout:native-foreground')));
    expect(await screen.findByRole('alert')).toHaveTextContent('임시 메모는 유지됩니다');
  });

  it('reconciles a timed-out sign-in with the native session before showing account state', async () => {
    mocks.session.mockResolvedValueOnce({ ok: true, value: { state: 'signed_out' } });
    render(<NativeLanding client={client} />);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: '시스템 로그인' });
    mocks.signIn.mockResolvedValueOnce({ ok: false, code: 'TIMEOUT' });
    mocks.session.mockResolvedValueOnce(signedIn());

    await user.click(screen.getByRole('button', { name: '시스템 로그인' }));

    await screen.findByRole('button', { name: '작업 메모 (임시) 열기' });
    expect(mocks.session).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/TIMEOUT/)).toBeNull();
  });

  it('reconciles a timed-out sign-out before retaining a signed-in account', async () => {
    render(<NativeLanding client={client} />);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: '작업 메모 (임시) 열기' });
    mocks.signOut.mockResolvedValueOnce({ ok: false, code: 'TIMEOUT' });
    mocks.session.mockResolvedValueOnce({ ok: true, value: { state: 'signed_out' } });

    await user.click(screen.getByRole('button', { name: '로그아웃' }));

    await screen.findByRole('button', { name: '시스템 로그인' });
    expect(mocks.session).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/TIMEOUT/)).toBeNull();
  });

  it('clears the old account draft when foreground session belongs to a new account', async () => {
    await openNote();
    mocks.session.mockResolvedValueOnce(signedIn('bob'));
    await act(async () => window.dispatchEvent(new Event('workout:native-foreground')));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '작업 메모' })).toBeNull());
    expect(localStorage.getItem('workout:private:account-scope')).toBe('bob');
  });

  it('keeps logout and relogin history aligned for Back and Forward', async () => {
    const { user } = await openNote();
    const oldNoteEntry = history.state;
    mocks.session.mockResolvedValueOnce({ ok: true, value: { state: 'signed_out' } });
    await act(async () => window.dispatchEvent(new Event('workout:native-foreground')));
    await screen.findByRole('button', { name: '시스템 로그인' });
    const accountEntry = history.state;
    expect(accountEntry).toMatchObject({ workoutNativeScreen: 'account' });

    mocks.signIn.mockResolvedValueOnce(signedIn('bob'));
    await user.click(screen.getByRole('button', { name: '시스템 로그인' }));
    await screen.findByRole('button', { name: '작업 메모 (임시) 열기' });
    history.replaceState(oldNoteEntry, '', '/');
    await act(async () =>
      window.dispatchEvent(new PopStateEvent('popstate', { state: oldNoteEntry })),
    );
    expect(screen.queryByRole('textbox', { name: '작업 메모' })).toBeNull();
    expect(history.state).toMatchObject({ workoutNativeScreen: 'account' });

    await user.click(screen.getByRole('button', { name: '작업 메모 (임시) 열기' }));
    const newNoteEntry = history.state;
    await user.type(screen.getByRole('textbox', { name: '작업 메모' }), '새 메모');
    history.replaceState(accountEntry, '', '/');
    await act(async () =>
      window.dispatchEvent(new PopStateEvent('popstate', { state: accountEntry })),
    );
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(history.state).toMatchObject({ workoutNativeScreen: 'note' });
    await user.click(screen.getByRole('button', { name: '뒤로 이동' }));
    history.replaceState(accountEntry, '', '/');
    await act(async () =>
      window.dispatchEvent(new PopStateEvent('popstate', { state: accountEntry })),
    );
    history.replaceState(newNoteEntry, '', '/');
    await act(async () =>
      window.dispatchEvent(new PopStateEvent('popstate', { state: newNoteEntry })),
    );
    expect(screen.getByRole('textbox', { name: '작업 메모' })).toHaveValue('');
  });
});

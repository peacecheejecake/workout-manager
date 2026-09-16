import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { fireEvent, render, screen } from '@testing-library/react';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { HostContext } from '@workout/contracts/core';
import { WorkspaceProvider, useWorkspaceDraft } from '../src/provider.js';
import { createWorkspaceStore } from '../src/workspace-store.js';

const unavailable = { state: 'unavailable', reason: 'M0 fixture' } as const;
const host: HostContext = {
  environment: 'web',
  navigate: () => {},
  openExternal: async () => {},
  onForeground: () => () => {},
  capabilities: {
    'healthkit.read': unavailable,
    'healthkit.background': unavailable,
    'media.pick': unavailable,
    'share.native': unavailable,
    haptics: unavailable,
    'notifications.native': unavailable,
  },
  transport: { request: async () => ({ status: 200, body: { items: [] }, traceId: null }) },
};
function Draft({ capture }: { capture?: (client: QueryClient) => void }) {
  const { state, actions } = useWorkspaceDraft();
  const client = useQueryClient();
  return (
    <>
      <label htmlFor="note">Note</label>
      <input id="note" value={state.note} onChange={(e) => actions.setNote(e.target.value)} />
      <button onClick={actions.reset}>Reset</button>
      <button onClick={() => capture?.(client)}>Capture cache</button>
    </>
  );
}
function workspace(userId: string, child = <Draft />, sessionId = 'session-a') {
  return (
    <WorkspaceProvider host={host} userId={userId} workspaceId="workspace-a" sessionId={sessionId}>
      {child}
    </WorkspaceProvider>
  );
}
describe('workspace lifetime', () => {
  it('isolates store factories and resets only the owning draft', () => {
    const first = createWorkspaceStore();
    const second = createWorkspaceStore();
    first.getState().actions.setNote('private draft');
    expect(second.getState().state.note).toBe('');
    first.getState().actions.reset();
    expect(first.getState().state.note).toBe('');
  });
  it('starts each SSR render with identical empty state and hydrates safely in StrictMode', () => {
    expect(renderToString(workspace('user-a'))).toBe(renderToString(workspace('user-b')));
    const container = document.createElement('div');
    container.innerHTML = renderToString(workspace('user-a'));
    document.body.append(container);
    render(<StrictMode>{workspace('user-a')}</StrictMode>, { container, hydrate: true });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'new draft' } });
    expect(screen.getByLabelText('Note')).toHaveValue('new draft');
    fireEvent.click(screen.getByText('Reset'));
    expect(screen.getByLabelText('Note')).toHaveValue('');
  });
  it('preserves drafts on ordinary rerenders and resets immediately for another account or session', () => {
    const view = render(workspace('user-a'));
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'private draft' } });
    view.rerender(workspace('user-a'));
    expect(screen.getByLabelText('Note')).toHaveValue('private draft');
    view.rerender(workspace('user-b'));
    expect(screen.getByLabelText('Note')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'second draft' } });
    view.rerender(workspace('user-b', <Draft />, 'session-b'));
    expect(screen.getByLabelText('Note')).toHaveValue('');
  });
  it('disposes old cache on account switch and unmount instead of sharing a module singleton', () => {
    const captured: QueryClient[] = [];
    const child = <Draft capture={(client) => captured.push(client)} />;
    const view = render(workspace('user-a', child));
    fireEvent.click(screen.getByText('Capture cache'));
    const first = captured[0];
    expect(first).toBeDefined();
    first?.setQueryData(['private'], 'first-user');
    view.rerender(workspace('user-b', child));
    fireEvent.click(screen.getByText('Capture cache'));
    const second = captured[1];
    expect(second).not.toBe(first);
    expect(first?.getQueryCache().getAll()).toHaveLength(0);
    expect(second?.getQueryData(['private'])).toBeUndefined();
    second?.setQueryData(['private'], 'second-user');
    view.unmount();
    expect(second?.getQueryCache().getAll()).toHaveLength(0);
  });
});

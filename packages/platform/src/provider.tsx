'use client';

import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useStore } from 'zustand';
import type { HostContext } from '@workout/contracts/core';
import { idSchema } from '@workout/contracts/primitives';
import { createWorkspaceStore } from './workspace-store';

export interface WorkspaceScope {
  userId: string;
  workspaceId: string;
  /** Rotate on credential/session or transport replacement; never contains an access token. */
  sessionId: string;
}
interface WorkspaceContextValue {
  host: HostContext;
  scope: WorkspaceScope;
  store: ReturnType<typeof createWorkspaceStore>;
}
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export interface WorkspaceProviderProps extends WorkspaceScope {
  host: HostContext;
  children: ReactNode;
}

/** Keyed reset happens before children render, so an account switch cannot flash prior data. */
export function WorkspaceProvider(props: WorkspaceProviderProps) {
  const { userId, workspaceId, sessionId } = props;
  idSchema.parse(userId);
  idSchema.parse(workspaceId);
  idSchema.parse(sessionId);
  return <WorkspaceLifetime key={JSON.stringify([userId, workspaceId, sessionId])} {...props} />;
}

function WorkspaceLifetime({
  host,
  userId,
  workspaceId,
  sessionId,
  children,
}: WorkspaceProviderProps) {
  const [store] = useState(createWorkspaceStore);
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } }),
  );
  useEffect(
    () => () => {
      // clear() cancels and removes active queries; no private cache survives this lifetime.
      queryClient.clear();
      store.getState().actions.reset();
    },
    [queryClient, store],
  );
  return (
    <WorkspaceContext value={{ host, scope: { userId, workspaceId, sessionId }, store }}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WorkspaceContext>
  );
}

function useWorkspaceContext() {
  const value = use(WorkspaceContext);
  if (!value) throw new Error('WorkspaceProvider is required');
  return value;
}
export function useHost() {
  return useWorkspaceContext().host;
}
export function useWorkspaceScope() {
  return useWorkspaceContext().scope;
}
export function useWorkspaceDraft() {
  const { store } = useWorkspaceContext();
  const note = useStore(store, (value) => value.state.note);
  const actions = useStore(store, (value) => value.actions);
  return { state: { note }, actions };
}

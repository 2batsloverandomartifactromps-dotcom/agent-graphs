/**
 * The shared SDK client (`client: 'ui'`), rebuilt when the actor name or token changes.
 * The UI is served from the same origin as /api/v1 (docs/ui.md; Vite proxies it in dev).
 */
import { AgentGraphsClient, AgentGraphsError } from '@agent-graphs/sdk';
import { createContext, useContext } from 'react';
import { toast } from 'sonner';

export function makeClient(actorName: string, token: string): AgentGraphsClient {
  return new AgentGraphsClient({
    baseUrl: window.location.origin,
    client: 'ui',
    actorName: actorName.trim() || 'Maintainer',
    ...(token.trim() ? { token: token.trim() } : {}),
  });
}

export const ClientContext = createContext<AgentGraphsClient | null>(null);

export function useClient(): AgentGraphsClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('ClientContext is missing');
  return client;
}

/** Message plus the server's hint, for toasts. */
export function errorText(error: unknown): { title: string; description?: string } {
  if (error instanceof AgentGraphsError) {
    return { title: error.message, ...(error.hint ? { description: error.hint } : {}) };
  }
  return { title: error instanceof Error ? error.message : String(error) };
}

export function toastError(error: unknown, prefix?: string): void {
  const { title, description } = errorText(error);
  toast.error(prefix ? `${prefix}: ${title}` : title, description ? { description } : undefined);
}

/** In-process pub/sub for committed events (docs/architecture.md §3.1, api.md §3). */
export type HubMessage = {
  seq: number;
  type: string;
  graphId: string | null;
  entity: { type: string; id: string };
  actor: unknown;
  payload: unknown;
  createdAt: string;
  snapshot?: unknown;
};

type Listener = (message: HubMessage) => void;

export class EventHub {
  private listeners = new Set<{ graphs: Set<string> | null; fn: Listener }>();

  /** Subscribe to some graphs (or all, with `null`). Returns an unsubscribe function. */
  subscribe(graphs: string[] | null, fn: Listener): () => void {
    const entry = { graphs: graphs ? new Set(graphs) : null, fn };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  publish(messages: HubMessage[]): void {
    for (const message of messages) {
      for (const l of this.listeners) {
        if (l.graphs && (!message.graphId || !l.graphs.has(message.graphId))) continue;
        try {
          l.fn(message);
        } catch {
          // A broken subscriber must not affect the command that published.
        }
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}

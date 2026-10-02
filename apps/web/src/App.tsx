import { NODE_STATUSES } from '@agent-graphs/core';
import { useEffect, useState } from 'react';

type Health = { ok: boolean; version: string } | null;

/**
 * Placeholder shell for M0. The real UI (docs/ui.md, docs/design/ui-mockup.html) is built in M4,
 * starting with node `ui-foundation` in docs/build-graph.yaml.
 */
export function App() {
  const [health, setHealth] = useState<Health>(null);

  useEffect(() => {
    fetch('/health')
      .then((response) => (response.ok ? response.json() : null))
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 font-sans antialiased">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <p className="font-mono text-xs uppercase tracking-widest text-violet-400">M0 · scaffold</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Agent Graphs</h1>
        <p className="mt-3 text-zinc-400">
          Construct, run, monitor and audit execution graphs for agent-orchestrated builds. The UI
          lands in milestone M4. See <code className="font-mono text-zinc-300">docs/ui.md</code> and
          the design mockup.
        </p>
        <p className="mt-8 text-sm">
          Server:{' '}
          <span className={health?.ok ? 'text-emerald-400' : 'text-zinc-500'}>
            {health?.ok ? `connected (v${health.version})` : 'not reachable — run `pnpm dev`'}
          </span>
        </p>
        <ul className="mt-8 flex flex-wrap gap-2">
          {NODE_STATUSES.map((status) => (
            <li
              key={status}
              className="rounded-md border border-white/10 px-2 py-1 font-mono text-xs text-zinc-400"
            >
              {status}
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

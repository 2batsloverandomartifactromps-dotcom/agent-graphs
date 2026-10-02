/**
 * ⌘K command palette (docs/ui.md §3): jump to a graph, node, or page; run actions such as
 * "pause graph" or "open inbox".
 */
import type { GraphView } from '@agent-graphs/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Command } from 'cmdk';
import {
  Bot,
  FileText,
  Inbox,
  LayoutDashboard,
  Moon,
  Pause,
  Play,
  Plus,
  SlidersHorizontal,
  Waypoints,
} from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { toastError, useClient } from '../lib/api';
import { qk, useGraphs } from '../lib/queries';
import { resolvedTheme, useSettings } from '../lib/settings';
import { StatusIcon } from './status';

type PaletteState = { open: boolean; setOpen: (o: boolean) => void };
export const usePalette = create<PaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function CommandPalette() {
  const { open, setOpen } = usePalette();
  const navigate = useNavigate();
  const client = useClient();
  const qc = useQueryClient();
  const { graph: currentGraph } = useParams({ strict: false }) as { graph?: string };
  const { data: graphs } = useGraphs({});
  const settings = useSettings();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!usePalette.getState().open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  const nodes = useMemo(() => {
    if (!open) return [];
    const out: Array<{
      graph: string;
      graphTitle: string;
      key: string;
      title: string;
      status: string;
    }> = [];
    for (const [, view] of qc.getQueriesData<GraphView>({ queryKey: ['graph'] })) {
      if (!view) continue;
      const ref = view.graph.slug ?? view.graph.id;
      for (const n of view.nodes)
        out.push({
          graph: ref,
          graphTitle: view.graph.title,
          key: n.key,
          title: n.title,
          status: n.status,
        });
    }
    return out;
  }, [open, qc]);

  const current = currentGraph ? qc.getQueryData<GraphView>(qk.graph(currentGraph)) : undefined;
  const go = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  const graphAction = async (action: 'pause' | 'resume') => {
    if (!currentGraph) return;
    try {
      await client.graphAction(currentGraph, action);
      toast.success(action === 'pause' ? 'Graph paused' : 'Graph resumed');
      void qc.invalidateQueries({ queryKey: qk.graph(currentGraph) });
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay-scrim" />
        <Dialog.Content className="cmdk" aria-label="Command palette">
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Dialog.Description className="sr-only">
            Jump to a graph, node or page, or run an action.
          </Dialog.Description>
          <Command label="Command palette" loop>
            <Command.Input placeholder="Search graphs, nodes, pages, actions…" autoFocus />
            <Command.List>
              <Command.Empty>No results.</Command.Empty>
              {current && (
                <Command.Group heading={current.graph.title}>
                  {current.graph.status === 'active' && (
                    <Command.Item onSelect={() => go(() => void graphAction('pause'))}>
                      <Pause />
                      Pause graph
                    </Command.Item>
                  )}
                  {current.graph.status === 'paused' && (
                    <Command.Item onSelect={() => go(() => void graphAction('resume'))}>
                      <Play />
                      Resume graph
                    </Command.Item>
                  )}
                </Command.Group>
              )}
              <Command.Group heading="Go to">
                <Command.Item onSelect={() => go(() => navigate({ to: '/' }))}>
                  <LayoutDashboard />
                  Overview
                </Command.Item>
                <Command.Item onSelect={() => go(() => navigate({ to: '/inbox' }))}>
                  <Inbox />
                  Open inbox
                </Command.Item>
                <Command.Item onSelect={() => go(() => navigate({ to: '/graphs' }))}>
                  <Waypoints />
                  Graphs
                </Command.Item>
                <Command.Item onSelect={() => go(() => navigate({ to: '/graphs/new' }))}>
                  <Plus />
                  New graph
                </Command.Item>
                <Command.Item onSelect={() => go(() => navigate({ to: '/agents' }))}>
                  <Bot />
                  Agents
                </Command.Item>
                <Command.Item onSelect={() => go(() => navigate({ to: '/notes' }))}>
                  <FileText />
                  Notes explorer
                </Command.Item>
                <Command.Item onSelect={() => go(() => navigate({ to: '/settings' }))}>
                  <SlidersHorizontal />
                  Settings
                </Command.Item>
                <Command.Item
                  onSelect={() =>
                    go(() =>
                      settings.set({
                        theme: resolvedTheme(settings.theme) === 'dark' ? 'light' : 'dark',
                      }),
                    )
                  }
                >
                  <Moon />
                  Toggle theme
                </Command.Item>
              </Command.Group>
              {graphs && graphs.length > 0 && (
                <Command.Group heading="Graphs">
                  {graphs.map((g) => (
                    <Command.Item
                      key={g.id}
                      value={`graph ${g.title} ${g.slug ?? ''}`}
                      onSelect={() =>
                        go(() =>
                          navigate({ to: '/graphs/$graph', params: { graph: g.slug ?? g.id } }),
                        )
                      }
                    >
                      <StatusIcon status={g.status} />
                      {g.title}
                      <span className="muted mono" style={{ marginLeft: 'auto', fontSize: 11 }}>
                        {g.slug}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {nodes.length > 0 && (
                <Command.Group heading="Nodes">
                  {nodes.map((n) => (
                    <Command.Item
                      key={`${n.graph}/${n.key}`}
                      value={`node ${n.key} ${n.title} ${n.graphTitle}`}
                      onSelect={() =>
                        go(() =>
                          navigate({
                            to: '/graphs/$graph/nodes/$node',
                            params: { graph: n.graph, node: n.key },
                          }),
                        )
                      }
                    >
                      <StatusIcon status={n.status} />
                      <span className="mono">{n.key}</span>
                      <span className="ellipsis">{n.title}</span>
                      <span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>
                        {n.graphTitle}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Canvas tab: the canvas stays mounted while the node/orchestrator inspector opens beside it. */
import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { toastError, useClient } from '../../lib/api';
import { qk, useNotes } from '../../lib/queries';
import type { CanvasSearch } from '../../router';
import { GraphCanvas } from './canvas/graph-canvas';
import type { CanvasActions } from './canvas/node-card';
import { useWorkspace } from './workspace';

export function CanvasLayout() {
  const { graph, view } = useWorkspace();
  const params = useParams({ strict: false }) as { node?: string; key?: string };
  const search = useSearch({ strict: false }) as CanvasSearch & { tab?: string };
  const navigate = useNavigate();
  const client = useClient();
  const qc = useQueryClient();
  const { data: notes } = useNotes({ graph, limit: 500 });

  const canvasSearch: CanvasSearch = {
    ...(search.cp ? { cp: true } : {}),
    ...(search.focus ? { focus: true } : {}),
    ...(search.table ? { table: true } : {}),
    ...(search.status ? { status: search.status } : {}),
    ...(search.tag ? { tag: search.tag } : {}),
    ...(search.kind ? { kind: search.kind } : {}),
    ...(search.model ? { model: search.model } : {}),
  };

  const onSelect = useCallback(
    (key: string | null) => {
      if (key)
        void navigate({
          to: '/graphs/$graph/nodes/$node',
          params: { graph, node: key },
          search: (prev) => ({ ...(prev as CanvasSearch), tab: (prev as { tab?: string }).tab }),
        });
      else
        void navigate({
          to: '/graphs/$graph',
          params: { graph },
          search: (prev) => ({ ...(prev as CanvasSearch), tab: undefined }),
        });
    },
    [navigate, graph],
  );

  const actions = useMemo<CanvasActions>(
    () => ({
      readOnly: false,
      onReview: (key) => onSelect(key),
      onApprove: async (requestId, nodeKey) => {
        try {
          await client.resolveRequest(requestId, { choice: 'approve' });
          toast.success(`Approved ${nodeKey}`);
          void qc.invalidateQueries({ queryKey: qk.graph(graph) });
          void qc.invalidateQueries({ queryKey: ['requests'] });
        } catch (e) {
          toastError(e, 'Approve');
        }
      },
    }),
    [client, qc, graph, onSelect],
  );

  return (
    <div className="subview on">
      <GraphCanvas
        view={view}
        graph={graph}
        {...(params.node ? { selected: params.node } : {})}
        {...(params.key ? { selectedOrch: params.key } : {})}
        search={canvasSearch}
        onSearch={(patch) =>
          void navigate({
            to: '.',
            search: (prev) => ({ ...(prev as Record<string, unknown>), ...patch }),
            replace: true,
          })
        }
        onSelect={onSelect}
        onSelectOrch={(key) =>
          void navigate({
            to: '/graphs/$graph/orchestrators/$key',
            params: { graph, key },
            search: (prev) => prev,
          })
        }
        {...(notes ? { notes } : {})}
        actions={actions}
      />
      <Outlet />
    </div>
  );
}

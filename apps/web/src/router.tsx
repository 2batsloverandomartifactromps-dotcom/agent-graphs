/**
 * Routes (docs/ui.md §2). Every view is addressable: selection, tabs, filters and canvas focus
 * live in the URL. The canvas stays mounted while the node/orchestrator inspector opens.
 */
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { lazy } from 'react';
import { Shell } from './components/shell';
import { AgentsPage } from './features/agents/agents-page';
import { GraphsPage } from './features/graphs/graphs-page';
import { InboxPage } from './features/inbox/inbox-page';
import { NotFound } from './features/not-found';
import { NotesPage } from './features/notes/notes-page';
import { OverviewPage } from './features/overview/overview-page';
import { SettingsPage } from './features/settings/settings-page';
import { CanvasLayout } from './features/workspace/canvas-layout';
import { NodeInspectorRoute } from './features/workspace/node-inspector';
import { OrchestratorInspectorRoute } from './features/workspace/orchestrator-inspector';
import { ActivityTab } from './features/workspace/tabs/activity-tab';
import { AgentsTab } from './features/workspace/tabs/agents-tab';
import { AimsTab } from './features/workspace/tabs/aims-tab';
import { NotesTab } from './features/workspace/tabs/notes-tab';
import { GraphSettingsTab } from './features/workspace/tabs/settings-tab';
import { GraphWorkspace } from './features/workspace/workspace';

const NewGraphPage = lazy(() => import('./features/graphs/new-graph-page'));
const SpecTab = lazy(() => import('./features/workspace/tabs/spec-tab'));

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const bool = (v: unknown): boolean | undefined =>
  v === true || v === 'true' || v === 1 ? true : undefined;

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFound });

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewPage,
});

export type GraphsSearch = { view?: string; q?: string; layout?: 'table' | 'cards'; sort?: string };
const graphsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/graphs',
  component: GraphsPage,
  validateSearch: (s: Record<string, unknown>): GraphsSearch => ({
    view: str(s.view),
    q: str(s.q),
    layout: s.layout === 'cards' ? 'cards' : undefined,
    sort: str(s.sort),
  }),
});

const newGraphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/graphs/new',
  component: NewGraphPage,
});

const graphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/graphs/$graph',
  component: GraphWorkspace,
});

export type CanvasSearch = {
  cp?: boolean;
  focus?: boolean;
  table?: boolean;
  status?: string;
  tag?: string;
  kind?: string;
  model?: string;
};
const canvasLayout = createRoute({
  getParentRoute: () => graphRoute,
  id: 'canvas',
  component: CanvasLayout,
  validateSearch: (s: Record<string, unknown>): CanvasSearch => ({
    cp: bool(s.cp),
    focus: bool(s.focus),
    table: bool(s.table),
    status: str(s.status),
    tag: str(s.tag),
    kind: str(s.kind),
    model: str(s.model),
  }),
});
const canvasIndex = createRoute({
  getParentRoute: () => canvasLayout,
  path: '/',
  component: () => null,
});
export type NodeSearch = { tab?: string };
const nodeRoute = createRoute({
  getParentRoute: () => canvasLayout,
  path: 'nodes/$node',
  component: NodeInspectorRoute,
  validateSearch: (s: Record<string, unknown>): NodeSearch => ({ tab: str(s.tab) }),
});
const orchRoute = createRoute({
  getParentRoute: () => canvasLayout,
  path: 'orchestrators/$key',
  component: OrchestratorInspectorRoute,
  validateSearch: (s: Record<string, unknown>): NodeSearch => ({ tab: str(s.tab) }),
});

export type TabSearch = {
  type?: string;
  node?: string;
  audit?: boolean;
  types?: string;
  event?: number;
  edit?: boolean;
};
const tabSearch = (s: Record<string, unknown>): TabSearch => ({
  type: str(s.type),
  node: str(s.node),
  audit: bool(s.audit),
  types: str(s.types),
  event: typeof s.event === 'number' ? s.event : undefined,
  edit: bool(s.edit),
});
const notesTab = createRoute({
  getParentRoute: () => graphRoute,
  path: 'notes',
  component: NotesTab,
  validateSearch: tabSearch,
});
const activityTab = createRoute({
  getParentRoute: () => graphRoute,
  path: 'activity',
  component: ActivityTab,
  validateSearch: tabSearch,
});
const agentsTab = createRoute({
  getParentRoute: () => graphRoute,
  path: 'agents',
  component: AgentsTab,
});
const specTab = createRoute({
  getParentRoute: () => graphRoute,
  path: 'spec',
  component: SpecTab,
  validateSearch: tabSearch,
});
const aimsTab = createRoute({ getParentRoute: () => graphRoute, path: 'aims', component: AimsTab });
const settingsTab = createRoute({
  getParentRoute: () => graphRoute,
  path: 'settings',
  component: GraphSettingsTab,
});

export type InboxSearch = {
  kind?: string;
  graph?: string;
  blocking?: boolean;
  tab?: 'open' | 'resolved';
  assignee?: string;
};
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: InboxPage,
  validateSearch: (s: Record<string, unknown>): InboxSearch => ({
    kind: str(s.kind),
    graph: str(s.graph),
    blocking: bool(s.blocking),
    tab: s.tab === 'resolved' ? 'resolved' : undefined,
    assignee: str(s.assignee),
  }),
});

export type NotesSearch = {
  q?: string;
  type?: string;
  severity?: string;
  model?: string;
  provider?: string;
  mechanism?: string;
  graph?: string;
  node?: string;
  since?: string;
};
const notesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notes',
  component: NotesPage,
  validateSearch: (s: Record<string, unknown>): NotesSearch => ({
    q: str(s.q),
    type: str(s.type),
    severity: str(s.severity),
    model: str(s.model),
    provider: str(s.provider),
    mechanism: str(s.mechanism),
    graph: str(s.graph),
    node: str(s.node),
    since: str(s.since),
  }),
});

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents',
  component: AgentsPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  overviewRoute,
  graphsRoute,
  newGraphRoute,
  graphRoute.addChildren([
    canvasLayout.addChildren([canvasIndex, nodeRoute, orchRoute]),
    notesTab,
    activityTab,
    agentsTab,
    specTab,
    aimsTab,
    settingsTab,
  ]),
  inboxRoute,
  notesRoute,
  agentsRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

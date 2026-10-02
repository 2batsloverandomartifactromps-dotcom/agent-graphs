/**
 * Global shell (docs/ui.md §3): collapsible sidebar (icon rail inside a graph workspace), top
 * bar with breadcrumbs, ⌘K palette, live indicator and theme toggle.
 */
import { Link, Outlet, useMatchRoute, useParams, useRouterState } from '@tanstack/react-router';
import {
  Bell,
  BellOff,
  Bot,
  ChevronRight,
  ChevronsUpDown,
  FileText,
  Inbox,
  LayoutDashboard,
  Moon,
  PanelLeft,
  Search,
  SlidersHorizontal,
  Sun,
  Waypoints,
} from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { formatUsd, initials } from '../lib/format';
import { useLive } from '../lib/live';
import { useGraph, useGraphs, useMe, useRequests, useSessions } from '../lib/queries';
import { resolvedTheme, useSettings } from '../lib/settings';
import { statusMeta } from '../lib/status';
import { cn } from '../lib/utils';
import { CommandPalette, usePalette } from './command-palette';
import { LiveConnection } from './live-connection';
import { IconButton, Kbd, Tip } from './ui';

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="7" r="2.2" />
        <circle cx="6" cy="17" r="2.2" />
        <circle cx="18" cy="12" r="2.2" />
        <path d="M8.2 7.4c3 .6 4.6 2.2 7.6 4.1M8.2 16.6c3-.6 4.6-2.2 7.6-4.1" />
      </svg>
    </span>
  );
}

function useThemeEffect() {
  const theme = useSettings((s) => s.theme);
  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolvedTheme(theme);
    };
    apply();
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

function Sidebar({ rail }: { rail: boolean }) {
  const { data: requests } = useRequests('open');
  const { data: graphs } = useGraphs({});
  const { data: sessions } = useSessions({ status: 'active' });
  const actorName = useSettings((s) => s.actorName);
  const { data: me } = useMe();
  const open = requests ?? [];
  const blocking = open.filter((r) => r.blocking).length;
  const recent = useMemo(
    () =>
      (graphs ?? [])
        .filter((g) => !g.archivedAt)
        .slice()
        .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
        .slice(0, 6),
    [graphs],
  );
  const activeSpend = (graphs ?? [])
    .filter((g) => g.status === 'active')
    .reduce((a, g) => a + g.costUsd, 0);
  const activeCount = (graphs ?? []).filter((g) => g.status === 'active').length;
  const items = [
    { to: '/', label: 'Overview', icon: LayoutDashboard, exact: true },
    { to: '/graphs', label: 'Graphs', icon: Waypoints },
    { to: '/inbox', label: 'Inbox', icon: Inbox, count: open.length, hot: blocking > 0 },
    { to: '/agents', label: 'Agents', icon: Bot, count: sessions?.length },
    { to: '/notes', label: 'Notes', icon: FileText },
    { to: '/settings', label: 'Settings', icon: SlidersHorizontal },
  ] as const;
  return (
    <aside className="sidebar" aria-label="Primary">
      <Link to="/" className="ws-switch" title="Agent Graphs">
        <BrandMark />
        <span className="ws-text col grow">
          <span className="ws-name">Agent Graphs</span>
          <span className="ws-sub">{me?.authMode === 'token' ? 'Token mode' : 'Local server'}</span>
        </span>
        <ChevronsUpDown className="chev muted" size={14} />
      </Link>
      <nav className="nav" aria-label="Main">
        {items.map((it) => (
          <Link
            key={it.to}
            to={it.to}
            activeOptions={{ exact: 'exact' in it ? it.exact : false }}
            activeProps={{ className: 'active', 'aria-current': 'page' }}
            title={it.label}
          >
            <it.icon size={16} />
            <span>{it.label}</span>
            {'count' in it && it.count ? (
              <b className={cn('count', 'hot' in it && it.hot && 'hot')}>
                {it.count}
                <span className="sr-only"> open</span>
              </b>
            ) : null}
          </Link>
        ))}
      </nav>
      {!rail && recent.length > 0 && (
        <>
          <div className="nav-label eyebrow">Graphs</div>
          <div className="nav-graphs nav" style={{ marginTop: 0 }}>
            {recent.map((g) => (
              <Link
                key={g.id}
                to="/graphs/$graph"
                params={{ graph: g.slug ?? g.id }}
                activeProps={{ className: 'active' }}
                title={`${g.title} · ${statusMeta(g.status).label}`}
              >
                <span className={cn('dot', statusMeta(g.status).cls)} aria-hidden="true" />
                <span className="ellipsis">{g.title}</span>
              </Link>
            ))}
          </div>
        </>
      )}
      <div className="side-foot">
        {!rail && activeCount > 0 && (
          <div className="usage-card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="eyebrow" style={{ fontSize: 10.5 }}>
                Active spend
              </span>
              <span className="num" style={{ fontSize: 12, color: 'var(--text-2)' }}>
                {activeCount} graph{activeCount === 1 ? '' : 's'}
              </span>
            </div>
            <div className="num" style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>
              <b style={{ color: 'var(--text)', fontWeight: 600 }}>{formatUsd(activeSpend)}</b>{' '}
              across running work
            </div>
          </div>
        )}
        <Link to="/settings" className="me" title="Settings">
          <span className="avatar me">{initials(actorName)}</span>
          <span className="me-text col grow">
            <span style={{ fontWeight: 500, fontSize: 13 }}>{actorName}</span>
            <span className="muted" style={{ fontSize: 11 }}>
              {me ? me.role.charAt(0).toUpperCase() + me.role.slice(1) : '—'}
            </span>
          </span>
        </Link>
      </div>
    </aside>
  );
}

const TAB_LABELS: Record<string, string> = {
  notes: 'Notes',
  activity: 'Activity',
  agents: 'Agents',
  spec: 'Spec',
  aims: 'Aims',
  settings: 'Settings',
};

function Crumbs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { graph } = useParams({ strict: false }) as { graph?: string };
  const { data: view } = useGraph(graph && graph !== 'new' ? graph : undefined);
  const parts: Array<{ label: string; to?: string; params?: Record<string, string> }> = [];
  if (pathname === '/') parts.push({ label: 'Agent Graphs' }, { label: 'Overview' });
  else if (pathname.startsWith('/graphs/new'))
    parts.push({ label: 'Graphs', to: '/graphs' }, { label: 'New graph' });
  else if (graph) {
    const seg = pathname.split('/')[3];
    parts.push({ label: 'Graphs', to: '/graphs' });
    parts.push({ label: view?.graph.title ?? graph, to: '/graphs/$graph', params: { graph } });
    parts.push({ label: seg && TAB_LABELS[seg] ? (TAB_LABELS[seg] as string) : 'Canvas' });
  } else {
    const seg = pathname.split('/')[1] ?? '';
    const label =
      { graphs: 'Graphs', inbox: 'Inbox', agents: 'Agents', notes: 'Notes', settings: 'Settings' }[
        seg
      ] ?? seg;
    parts.push({ label: 'Agent Graphs' }, { label });
  }
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {parts.map((p, i) => {
        const last = i === parts.length - 1;
        return (
          <span key={`crumb-${p.label}`} className="row" style={{ gap: 6 }}>
            {i > 0 && <ChevronRight aria-hidden="true" />}
            {p.to && !last && p.params?.graph ? (
              <Link
                to="/graphs/$graph"
                params={{ graph: p.params.graph }}
                className="ellipsis"
                style={{ maxWidth: 280 }}
              >
                {p.label}
              </Link>
            ) : p.to && !last ? (
              <Link to="/graphs" className="ellipsis" style={{ maxWidth: 280 }}>
                {p.label}
              </Link>
            ) : (
              <span
                className={cn('ellipsis', last && 'cur')}
                style={{ maxWidth: 320 }}
                aria-current={last ? 'page' : undefined}
              >
                {p.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function LiveIndicator() {
  const status = useLive((s) => s.status);
  const label = {
    live: 'Live',
    connecting: 'Connecting',
    reconnecting: 'Reconnecting',
    offline: 'Offline',
  }[status];
  return (
    <span
      className={cn(
        'live',
        (status === 'reconnecting' || status === 'connecting') && 'reconnecting',
        status === 'offline' && 'offline',
      )}
      role="status"
      aria-live="polite"
      title={status === 'live' ? 'Streaming live updates' : label}
      data-testid="live-indicator"
    >
      <span className="pulse" aria-hidden="true" />
      {label}
    </span>
  );
}

function ThemeToggle() {
  const theme = useSettings((s) => s.theme);
  const set = useSettings((s) => s.set);
  const current = resolvedTheme(theme);
  return (
    <IconButton
      bordered
      label={current === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => set({ theme: current === 'dark' ? 'light' : 'dark' })}
    >
      {current === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
    </IconButton>
  );
}

function NotificationsToggle() {
  const enabled = useSettings((s) => s.notifications);
  const set = useSettings((s) => s.set);
  const toggle = async () => {
    if (enabled) {
      set({ notifications: false });
      return;
    }
    try {
      const perm =
        typeof Notification !== 'undefined' ? await Notification.requestPermission() : 'denied';
      set({ notifications: perm === 'granted' });
    } catch {
      set({ notifications: false });
    }
  };
  return (
    <IconButton
      bordered
      label={
        enabled
          ? 'Browser notifications on (blocking inbox items)'
          : 'Enable browser notifications for blocking inbox items'
      }
      onClick={toggle}
      aria-pressed={enabled}
    >
      {enabled ? <Bell size={16} /> : <BellOff size={16} />}
    </IconButton>
  );
}

export function Shell() {
  useThemeEffect();
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const set = useSettings((s) => s.set);
  const matchRoute = useMatchRoute();
  const inWorkspace =
    Boolean(matchRoute({ to: '/graphs/$graph', fuzzy: true })) &&
    !matchRoute({ to: '/graphs/new' });
  const rail = collapsed || inWorkspace;
  const palette = usePalette();
  return (
    <div className={cn('app', rail && 'rail')}>
      <a href="#main" className="sr-only">
        Skip to content
      </a>
      <LiveConnection />
      <Sidebar rail={rail} />
      <div className="main">
        <header className="topbar">
          <IconButton
            label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => set({ sidebarCollapsed: !collapsed })}
          >
            <PanelLeft size={16} />
          </IconButton>
          <Crumbs />
          <Tip content="Command palette">
            <button
              type="button"
              className="search"
              onClick={() => palette.setOpen(true)}
              aria-label="Search graphs, nodes, notes (⌘K)"
            >
              <Search size={14} />
              <span>Search graphs, nodes, notes…</span>
              <span className="kbd-row">
                <Kbd>⌘</Kbd>
                <Kbd>K</Kbd>
              </span>
            </button>
          </Tip>
          <LiveIndicator />
          <NotificationsToggle />
          <ThemeToggle />
        </header>
        <main id="main" className="contents">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}

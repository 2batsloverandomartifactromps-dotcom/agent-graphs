/**
 * Settings (docs/ui.md §2): display name (X-Actor-Name), API token for AUTH_MODE=token, theme,
 * browser notifications, and the display vocabulary served by GET /vocab.
 */

import { NODE_STATUSES } from '@agent-graphs/core';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ExecBadge, ThinkMeter } from '../../components/exec-badge';
import { StatusPill } from '../../components/status';
import { Button, Segmented } from '../../components/ui';
import { useMe, useVocab } from '../../lib/queries';
import { DEFAULT_ACTOR, type ThemePref, useSettings } from '../../lib/settings';

export function SettingsPage() {
  const settings = useSettings();
  const qc = useQueryClient();
  const { data: me, error: meError } = useMe();
  const { data: vocab } = useVocab();
  const [name, setName] = useState(settings.actorName);
  const [token, setToken] = useState(settings.token);
  const save = () => {
    settings.set({ actorName: name.trim() || DEFAULT_ACTOR, token: token.trim() });
    toast.success('Settings saved');
    void qc.invalidateQueries();
  };
  return (
    <section className="view on page" aria-label="Settings">
      <div className="page-in" style={{ maxWidth: 920 }}>
        <div className="page-h">
          <div>
            <h1>Settings</h1>
            <div className="sub">Stored in this browser.</div>
          </div>
        </div>
        <div className="card">
          <div className="card-h">
            <h3>Identity</h3>
            {me && (
              <span className="sub">
                Server: {me.authMode} mode · role <b>{me.role}</b>
              </span>
            )}
            {meError && (
              <span className="sub" style={{ color: 'var(--s-blocked-fg)' }}>
                {(meError as Error).message}
              </span>
            )}
          </div>
          <div className="card-b">
            <div className="field" style={{ marginTop: 0 }}>
              <label htmlFor="s-name">Display name</label>
              <input
                id="s-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <span className="muted" style={{ fontSize: 12 }}>
                Sent as <span className="mono">X-Actor-Name</span>; it appears in the audit trail
                for your decisions and edits.
              </span>
            </div>
            <div className="field">
              <label htmlFor="s-token">
                API token{' '}
                <span className="muted">
                  (only needed when the server runs with AUTH_MODE=token)
                </span>
              </label>
              <input
                id="s-token"
                className="input mono"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ag_…"
              />
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <Button variant="primary" size="sm" onClick={save}>
                <Check />
                Save
              </Button>
            </div>
          </div>
        </div>
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-h">
            <h3>Appearance & notifications</h3>
          </div>
          <div className="card-b col" style={{ gap: 12 }}>
            <div className="row">
              <span style={{ width: 160 }}>Theme</span>
              <Segmented
                label="Theme"
                value={settings.theme}
                onChange={(v: ThemePref) => settings.set({ theme: v })}
                options={[
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' },
                  { value: 'system', label: 'System' },
                ]}
              />
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.notifications}
                onChange={async (e) => {
                  if (!e.target.checked) return settings.set({ notifications: false });
                  const perm =
                    typeof Notification !== 'undefined'
                      ? await Notification.requestPermission()
                      : 'denied';
                  settings.set({ notifications: perm === 'granted' });
                  if (perm !== 'granted')
                    toast.error('Notifications were not allowed by the browser.');
                }}
              />
              Browser notifications for new blocking inbox items
            </label>
          </div>
        </div>
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-h">
            <h3>Display vocabulary</h3>
            <span className="sub">From GET /api/v1/vocab · unknown models show their raw id</span>
          </div>
          <div className="card-b col" style={{ gap: 12 }}>
            <div className="sys-row">
              {vocab?.models.map((m) => (
                <ExecBadge
                  key={m.id}
                  x={{
                    kind: 'agent',
                    model: m.id,
                    provider: m.provider,
                    thinking: 'high',
                    mechanism: 'claude-code',
                  }}
                />
              ))}
              <ExecBadge
                x={{ kind: 'human', agent: 'Human', provider: 'human', mechanism: 'ui' }}
              />
            </div>
            <div className="sys-row">
              {vocab?.thinking.map((t) => (
                <span key={t.id} className="sys-think">
                  <ThinkMeter level={t.id} />
                  {t.id}
                </span>
              ))}
            </div>
            <div className="sys-row">
              {NODE_STATUSES.map((s) => (
                <StatusPill key={s} status={s} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

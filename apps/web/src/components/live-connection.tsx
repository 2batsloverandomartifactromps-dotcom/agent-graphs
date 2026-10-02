/**
 * Owns the single SSE subscription (all graphs) and the connection indicator state
 * (docs/ui.md §3, §8). Reconnection with Last-Event-ID replay is handled by the SDK; a health
 * probe distinguishes "reconnecting" from "offline".
 */
import type { LiveEvent } from '@agent-graphs/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useClient } from '../lib/api';
import { createLiveHandler, useLive } from '../lib/live';
import { useSettings } from '../lib/settings';

function notify(event: LiveEvent) {
  if (event.type !== 'request.created') return;
  const snap = event.snapshot as { blocking?: boolean; title?: string; kind?: string } | undefined;
  if (!snap?.blocking || !useSettings.getState().notifications) return;
  try {
    if (
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted' &&
      document.hidden
    ) {
      new Notification(`Agent Graphs: ${snap.kind ?? 'request'} needs you`, {
        body: snap.title ?? '',
      });
    }
  } catch {
    // notifications are best-effort
  }
}

export function LiveConnection() {
  const client = useClient();
  const qc = useQueryClient();
  useEffect(() => {
    const live = useLive.getState();
    live.setStatus('connecting');
    let failures = 0;
    let probe: ReturnType<typeof setInterval> | undefined;
    const handler = createLiveHandler(qc, notify);
    const startProbe = () => {
      if (probe) return;
      probe = setInterval(() => {
        client
          .health()
          .then(() => {
            // The SDK retries the stream every 2 s; if it fails again, onError flips us back.
            failures = 0;
            useLive.getState().setStatus('live');
            if (probe) clearInterval(probe);
            probe = undefined;
          })
          .catch(() => useLive.getState().setStatus('offline'));
      }, 3000);
    };
    // The stream sends no event when idle, so confirm reachability once at start.
    client
      .health()
      .then(() => {
        if (useLive.getState().status === 'connecting') useLive.getState().setStatus('live');
      })
      .catch(() => useLive.getState().setStatus('offline'));
    const stop = client.subscribe({
      onEvent: (e) => {
        failures = 0;
        if (probe) {
          clearInterval(probe);
          probe = undefined;
        }
        handler(e);
      },
      onResync: () => void qc.invalidateQueries(),
      onError: () => {
        failures += 1;
        useLive.getState().setStatus('reconnecting');
        startProbe();
        // Missed events are replayed with Last-Event-ID; refetch views in case of a gap.
        if (failures === 1) setTimeout(() => void qc.invalidateQueries(), 2500);
      },
    });
    return () => {
      stop();
      if (probe) clearInterval(probe);
    };
  }, [client, qc]);
  return null;
}

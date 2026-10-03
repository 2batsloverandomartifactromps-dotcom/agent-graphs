/**
 * Per-viewer settings (docs/ui.md §2 Settings): display name sent as X-Actor-Name, the API token
 * for AUTH_MODE=token, theme, and notification opt-in. Persisted in localStorage when available.
 */
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

export type ThemePref = 'dark' | 'light' | 'system';

export type Settings = {
  actorName: string;
  token: string;
  theme: ThemePref;
  notifications: boolean;
  sidebarCollapsed: boolean;
  inspectorWidth: number;
  set: (patch: Partial<Omit<Settings, 'set'>>) => void;
};

const memory = new Map<string, string>();
const safeStorage: StateStorage = {
  getItem: (k) => {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return memory.get(k) ?? null;
    }
  },
  setItem: (k, v) => {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      memory.set(k, v);
    }
  },
  removeItem: (k) => {
    try {
      window.localStorage.removeItem(k);
    } catch {
      memory.delete(k);
    }
  },
};

export const DEFAULT_ACTOR = 'Maintainer';

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      actorName: DEFAULT_ACTOR,
      token: '',
      theme: 'dark',
      notifications: false,
      sidebarCollapsed: false,
      inspectorWidth: 420,
      set: (patch) => set(patch),
    }),
    {
      name: 'agent-graphs.settings',
      storage: createJSONStorage(() => safeStorage),
      partialize: ({ set: _set, ...rest }) => rest,
    },
  ),
);

export function resolvedTheme(pref: ThemePref): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

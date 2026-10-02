import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@xyflow/react/dist/base.css';
import './styles.css';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { MotionConfig } from 'motion/react';
import { Tooltip } from 'radix-ui';
import { StrictMode, Suspense, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { ClientContext, makeClient } from './lib/api';
import { resolvedTheme, useSettings } from './lib/settings';
import { router } from './router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => count < 2 && !(error as { status?: number }).status,
    },
  },
  mutationCache: new MutationCache(),
});

function App() {
  const actorName = useSettings((s) => s.actorName);
  const token = useSettings((s) => s.token);
  const theme = useSettings((s) => s.theme);
  const client = useMemo(() => makeClient(actorName, token), [actorName, token]);
  return (
    <ClientContext.Provider value={client}>
      <QueryClientProvider client={queryClient}>
        <MotionConfig reducedMotion="user">
          <Tooltip.Provider delayDuration={250}>
            <Suspense fallback={null}>
              <RouterProvider router={router} />
            </Suspense>
            <Toaster
              theme={resolvedTheme(theme)}
              position="bottom-right"
              closeButton
              toastOptions={{ style: { fontFamily: 'var(--font-sans)', fontSize: 13 } }}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </QueryClientProvider>
    </ClientContext.Provider>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

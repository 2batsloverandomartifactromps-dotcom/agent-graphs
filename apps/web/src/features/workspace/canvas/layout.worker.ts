/// <reference lib="webworker" />
/** Runs the dagre layout off the main thread (docs/ui.md §5.1, §9). */
import { computeLayout, type LayoutInput } from '../../../lib/layout';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<{ id: number; input: LayoutInput }>) => {
  try {
    scope.postMessage({ id: event.data.id, result: computeLayout(event.data.input) });
  } catch (error) {
    scope.postMessage({ id: event.data.id, error: (error as Error).message });
  }
};

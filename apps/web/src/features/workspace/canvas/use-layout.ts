/**
 * Layout hook: dagre runs in a Web Worker, memoized by structure hash so status changes never
 * relayout. Falls back to the main thread when workers are unavailable.
 */
import { useEffect, useState } from 'react';
import {
  computeLayout,
  type LayoutInput,
  type LayoutResult,
  structureHash,
} from '../../../lib/layout';

const results = new Map<string, LayoutResult>();
let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, (r: LayoutResult | undefined) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; result?: LayoutResult }>) => {
      waiting.get(e.data.id)?.(e.data.result);
      waiting.delete(e.data.id);
    };
    worker.onerror = () => {
      for (const resolve of waiting.values()) resolve(undefined);
      waiting.clear();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

function layoutAsync(input: LayoutInput): Promise<LayoutResult> {
  const w = getWorker();
  if (!w) return Promise.resolve(computeLayout(input));
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, (r) => resolve(r ?? computeLayout(input)));
    w.postMessage({ id, input });
  });
}

export function useLayout(input: LayoutInput): LayoutResult | undefined {
  const hash = structureHash(input);
  const [result, setResult] = useState<LayoutResult | undefined>(() => results.get(hash));
  // biome-ignore lint/correctness/useExhaustiveDependencies: the structure hash captures `input`
  useEffect(() => {
    const cached = results.get(hash);
    if (cached) {
      setResult(cached);
      return;
    }
    let live = true;
    void layoutAsync(input).then((r) => {
      results.set(hash, r);
      if (live) setResult(r);
    });
    return () => {
      live = false;
    };
  }, [hash]);
  // While a new structure is laid out, keep showing the previous layout (no blank flash).
  return results.get(hash) ?? result;
}

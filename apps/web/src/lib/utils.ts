import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge conditional class names, letting later Tailwind utilities win conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** An animation duration, or 0 when the user prefers reduced motion (docs/ui.md §6.4). */
export function motionMs(ms: number): number {
  if (typeof window === 'undefined' || !window.matchMedia) return ms;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms;
}

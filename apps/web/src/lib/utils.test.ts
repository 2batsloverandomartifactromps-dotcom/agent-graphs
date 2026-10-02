import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('merges conditional classes and resolves Tailwind conflicts', () => {
    const muted = false;
    expect(cn('px-2 text-sm', muted && 'text-zinc-500', 'px-4')).toBe('text-sm px-4');
  });
});

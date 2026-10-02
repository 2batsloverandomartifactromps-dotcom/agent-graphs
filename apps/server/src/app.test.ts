import { describe, expect, it } from 'vitest';
import { createApp } from './app';

describe('server app', () => {
  it('reports health', async () => {
    const response = await createApp().request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, spec: 'agent-graphs/v1' });
  });
});

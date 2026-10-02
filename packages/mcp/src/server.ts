/** `createMcpServer`: the tools, prompts, and resources of docs/agent-protocol.md §7.1. */
import { AgentGraphsError } from '@agent-graphs/sdk';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type ActorInput, ToolContext, type ToolContextOptions } from './context';
import { PROMPTS, PROTOCOL_MD } from './protocol';
import { type ToolDef, toolsFor, UsageError } from './tools';

export const MCP_SERVER_NAME = 'agent-graphs';
export const MCP_SERVER_VERSION = '0.1.0';

/**
 * Tool profiles keep tool definitions small: `orchestrator` and `evolver` include the worker
 * tools; `all` includes everything.
 */
export const MCP_PROFILES = ['worker', 'orchestrator', 'evolver', 'all'] as const;
export type McpProfile = (typeof MCP_PROFILES)[number];

export function isMcpProfile(value: unknown): value is McpProfile {
  return typeof value === 'string' && (MCP_PROFILES as readonly string[]).includes(value);
}

export type CreateMcpServerOptions = ToolContextOptions & {
  profile?: McpProfile;
  actor?: ActorInput;
};

const INSTRUCTIONS = `Agent Graphs coordinates agent work through execution graphs. Workers: work_next (claim) → read the briefing → attempt_heartbeat every ≤5 min → note_add / metrics_report → attempt_submit (or attempt_fail / attempt_block / attempt_release). Orchestrators: orchestrator_attach → graph_sitrep → dispatch with node_claim {dispatchedBy} → resolve. Directives override prompts. Never stop while holding an open attempt. Read agent-graphs://docs/protocol for the full protocol.`;

/** Map any thrown error to a tool error result with the server's code and hint. */
export function errorResult(error: unknown): CallToolResult {
  if (error instanceof AgentGraphsError) {
    const missingRoute = error.status === 404 && /No route for/.test(error.message);
    const hint = missingRoute
      ? 'This server version does not implement that endpoint yet (optional self-evolution and learn-mode endpoints ship in later milestones).'
      : error.hint;
    const text = hint
      ? `${error.code}: ${error.message}\nHint: ${hint}`
      : `${error.code}: ${error.message}`;
    return {
      isError: true,
      content: [{ type: 'text', text }],
      structuredContent: {
        error: {
          status: error.status,
          code: error.code,
          message: error.message,
          ...(hint ? { hint } : {}),
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      },
    };
  }
  if (error instanceof UsageError) {
    const text = error.hint
      ? `BAD_REQUEST: ${error.message}\nHint: ${error.hint}`
      : `BAD_REQUEST: ${error.message}`;
    return {
      isError: true,
      content: [{ type: 'text', text }],
      structuredContent: {
        error: {
          code: 'BAD_REQUEST',
          message: error.message,
          ...(error.hint ? { hint: error.hint } : {}),
        },
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text', text: `INTERNAL: ${message}` }],
    structuredContent: { error: { code: 'INTERNAL', message } },
  };
}

function structured(data: unknown): Record<string, unknown> | undefined {
  if (data === undefined) return undefined;
  if (data && typeof data === 'object' && !Array.isArray(data))
    return data as Record<string, unknown>;
  return { result: data };
}

function register(server: McpServer, def: ToolDef, ctx: ToolContext): void {
  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    try {
      const out = await def.run(args ?? {}, ctx);
      const sc = structured(out.data);
      return {
        content: [{ type: 'text', text: out.text }],
        ...(sc ? { structuredContent: sc } : {}),
      };
    } catch (error) {
      return errorResult(error);
    }
  };
  // The SDK's registerTool generics are very deep for zod 4 shapes; register through a narrow
  // signature (inputs are still validated by the SDK against `def.input`).
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: z.ZodRawShape;
      annotations?: Record<string, unknown>;
    },
    cb: (args: Record<string, unknown>) => Promise<CallToolResult>,
  ) => void;
  registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      ...(def.readOnly ? { annotations: { readOnlyHint: true } } : {}),
    },
    handler,
  );
}

/**
 * Build an MCP server bound to one API client. Use `toolContext` state (sessions learned from
 * claims and attachments) for the lifetime of the connection.
 */
export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const profile = options.profile ?? 'all';
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );
  const ctx = new ToolContext(options);
  for (const def of toolsFor(profile)) register(server, def, ctx);
  registerPrompts(server);
  registerResources(server, ctx);
  return server;
}

function promptMessage(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

function registerPrompts(server: McpServer): void {
  const registerPrompt = server.registerPrompt.bind(server) as unknown as (
    name: string,
    config: { title: string; description: string; argsSchema: z.ZodRawShape },
    cb: (args: Record<string, string>) => ReturnType<typeof promptMessage>,
  ) => void;
  registerPrompt(
    'work',
    {
      title: 'Work on a graph',
      description: 'Start the worker loop on a graph.',
      argsSchema: { graph: z.string().describe('Graph id or slug') },
    },
    (a) => promptMessage(PROMPTS.work(a.graph ?? '')),
  );
  registerPrompt(
    'orchestrate',
    {
      title: 'Orchestrate a graph',
      description: 'Attach as an orchestrator (default lead) and run its loop.',
      argsSchema: {
        graph: z.string().describe('Graph id or slug'),
        orchestrator: z.string().optional().describe('Orchestrator key (default lead)'),
      },
    },
    (a) => promptMessage(PROMPTS.orchestrate(a.graph ?? '', a.orchestrator || 'lead')),
  );
  registerPrompt(
    'review',
    {
      title: 'Review submitted work',
      description: 'Judge attempts awaiting an independent verdict.',
      argsSchema: { graph: z.string().describe('Graph id or slug') },
    },
    (a) => promptMessage(PROMPTS.review(a.graph ?? '')),
  );
  registerPrompt(
    'plan',
    {
      title: 'Plan a graph',
      description: 'Draft a spec for a goal, validate it, and create it as a draft.',
      argsSchema: { goal: z.string().describe('What the graph should achieve') },
    },
    (a) => promptMessage(PROMPTS.plan(a.goal ?? '')),
  );
}

function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'protocol',
    'agent-graphs://docs/protocol',
    { title: 'Agent Graphs protocol', mimeType: 'text/markdown' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: PROTOCOL_MD }],
    }),
  );
  server.registerResource(
    'sitrep',
    new ResourceTemplate('agent-graphs://graphs/{id}/sitrep', {
      list: async () => {
        const r = await ctx.client.listGraphs({ status: 'active,paused,verifying' });
        return {
          resources: r.items.map((g) => ({
            uri: `agent-graphs://graphs/${g.slug ?? g.id}/sitrep`,
            name: `${g.title} · sitrep`,
            mimeType: 'text/markdown',
          })),
        };
      },
    }),
    { title: 'Graph sitrep', mimeType: 'text/markdown' },
    async (uri, vars) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: await ctx.client.sitrep(String(vars.id), { budget: 3000 }),
        },
      ],
    }),
  );
  server.registerResource(
    'briefing',
    new ResourceTemplate('agent-graphs://graphs/{id}/nodes/{key}/briefing', { list: undefined }),
    { title: 'Node briefing', mimeType: 'text/markdown' },
    async (uri, vars) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: await ctx.client.briefing(String(vars.id), String(vars.key), { budget: 6000 }),
        },
      ],
    }),
  );
}

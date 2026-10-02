/**
 * Client-side helpers for exercising the MCP server: connect an MCP SDK client over an
 * in-memory transport or over Streamable HTTP. Used by tests, the simulator, and harnesses
 * that embed the tools in another agent runtime.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type CreateMcpServerOptions, createMcpServer } from './server';

export type McpTestClient = Client;

/** A connected MCP client talking to a fresh server over an in-memory transport. */
export async function connectInMemory(options: CreateMcpServerOptions): Promise<Client> {
  const server = createMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'agent-graphs-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** A connected MCP client over Streamable HTTP (optionally through a custom fetch). */
export async function connectHttp(
  url: string,
  options: { fetch?: typeof fetch; headers?: Record<string, string> } = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.headers ? { requestInit: { headers: options.headers } } : {}),
  });
  const client = new Client({ name: 'agent-graphs-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

/** The text of a tool result (first text block). */
export function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.find((c) => c.type === 'text')?.text ?? '';
}

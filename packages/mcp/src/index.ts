/**
 * @agent-graphs/mcp: an MCP server with the tools, prompts, resources, and profiles listed in
 * docs/agent-protocol.md §7.1. Tools are defined against the sdk client, so the same set serves
 * stdio (`agraph mcp`) and Streamable HTTP (mounted by the server at /mcp).
 */

export {
  type ClientSessionRecord,
  clientSessionFromEnv,
  parseActor,
  readClientSession,
  stateDir,
  writeClientSession,
} from './client-session';
export { type ActorInput, ToolContext, type ToolContextOptions } from './context';
export * as format from './format';
export { createMcpHttpHandler, forwardingClient, type McpHttpOptions } from './http';
export { PROMPTS, PROTOCOL_MD } from './protocol';
export {
  type CreateMcpServerOptions,
  createMcpServer,
  errorResult,
  isMcpProfile,
  MCP_PROFILES,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  type McpProfile,
} from './server';
export { runStdioServer, type StdioOptions } from './stdio';
export { PROFILE_GROUPS, TOOLS, type ToolDef, type ToolGroup, toolsFor, UsageError } from './tools';

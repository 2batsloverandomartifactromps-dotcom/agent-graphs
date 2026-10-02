/**
 * @agent-graphs/mcp: an MCP server with the tools, prompts, resources, and profiles listed in
 * docs/agent-protocol.md §7.1. Tools are defined against the sdk client, so the same set serves
 * stdio (`agraph mcp`) and Streamable HTTP (mounted by the server at /mcp).
 * Built in milestone M3 (node `mcp-server` in docs/build-graph.yaml).
 */

export const MCP_SERVER_NAME = 'agent-graphs';

/**
 * Tool profiles keep tool definitions small: `orchestrator` and `evolver` include the worker
 * tools; `all` includes everything.
 */
export const MCP_PROFILES = ['worker', 'orchestrator', 'evolver', 'all'] as const;
export type McpProfile = (typeof MCP_PROFILES)[number];

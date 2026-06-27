#!/usr/bin/env node
/**
 * MCP server (stdio transport) exposing Cosmos.so image search as agent tools.
 * For local clients that spawn the server as a subprocess (Claude Desktop, Claude Code).
 * For a remote URL-based server, use src/mcp-http.ts instead.
 *
 * Tools: cosmos_search, cosmos_featured, cosmos_download
 * Run:   npx tsx src/mcp.ts   |   node dist/mcp.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCosmosTools } from "./tools.js";

const server = new McpServer({ name: "cosmo-api", version: "0.1.0" });
registerCosmosTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is reserved for the MCP JSON-RPC stream
  console.error("cosmo-api MCP server running on stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

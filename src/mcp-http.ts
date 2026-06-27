#!/usr/bin/env node
/**
 * URL-based MCP server over Streamable HTTP transport.
 *
 * Exposes Cosmos.so image search at a single endpoint you can point any
 * remote MCP client at:
 *
 *     POST /mcp     (the MCP JSON-RPC stream)
 *     GET  /healthz
 *
 * Runs stateless: a fresh server+transport is created per request, so it scales
 * horizontally and needs no sticky sessions — ideal behind Azure / a load balancer.
 *
 * Env: MCP_PORT (default 7071), MCP_TOKEN (optional bearer token to require).
 *
 * Hook it into an agent (Claude Desktop / Code, etc.):
 *   {
 *     "mcpServers": {
 *       "cosmos": { "type": "http", "url": "https://your-host/mcp" }
 *     }
 *   }
 */
import "dotenv/config";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerCosmosTools } from "./tools.js";

const PORT = Number(process.env.MCP_PORT ?? process.env.PORT ?? 7070);
const TOKEN = process.env.MCP_TOKEN ?? "";

function newServer(): McpServer {
  const server = new McpServer({ name: "cosmo-api", version: "0.1.0" });
  registerCosmosTools(server);
  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, transport: "streamable-http", endpoint: "/mcp" });
});

// optional bearer-token gate
function authed(req: Request): boolean {
  if (!TOKEN) return true;
  const h = req.header("authorization") ?? "";
  return h === `Bearer ${TOKEN}`;
}

app.post("/mcp", async (req: Request, res: Response) => {
  if (!authed(req)) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  // stateless: new server + transport per request, disposed when the response closes
  const server = newServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

// stateless mode does not support server-initiated streams over GET/DELETE
const noSession = (_req: Request, res: Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
app.get("/mcp", noSession);
app.delete("/mcp", noSession);

app.listen(PORT, () => {
  console.log(`cosmo-api MCP (HTTP) on http://localhost:${PORT}/mcp`);
  if (TOKEN) console.log("  bearer-token auth: ON");
});

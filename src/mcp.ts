#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) server exposing Cosmos.so image search as agent tools.
 *
 * Transport: stdio (standard for local MCP servers / Claude Desktop / Claude Code).
 *
 * Tools:
 *   cosmos_search    - semantic image search, returns image URLs + metadata
 *   cosmos_featured  - the Cosmos homepage featured feed
 *   cosmos_download  - search + save images to a local directory
 *
 * Run:  npx tsx src/mcp.ts   (dev)   |   node dist/mcp.js   (built)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { searchAll, featuredPage, cdnUrl, type CosmosElement } from "./cosmos.js";

const MAX_LIMIT = 200;

/** Compact, token-friendly shape for an LLM agent. */
function shape(el: CosmosElement, width: number) {
  return {
    id: el.id,
    type: el.type,
    original: el.url, // full-resolution master
    thumb: el.url ? cdnUrl(el.url, { width, format: "webp", quality: 80 }) : null,
    width: el.width,
    height: el.height,
    owner: el.owner,
    source: el.sourceUrl,
    caption: el.caption,
    permalink: el.shareUrl,
  };
}

function asJson(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

const server = new McpServer({
  name: "cosmo-api",
  version: "0.1.0",
});

server.registerTool(
  "cosmos_search",
  {
    title: "Cosmos image search",
    description:
      "Search cosmos.so for images by a natural-language phrase (e.g. 'brutalist concrete interiors', " +
      "'wabi-sabi ceramics', 'film noir lighting'). The query is expanded semantically server-side. " +
      "Returns a list of images with full-resolution and thumbnail URLs, dimensions, original source, " +
      "AI caption, and permalink. Good for moodboards, visual references, and design inspiration.",
    inputSchema: {
      query: z.string().min(1).describe("Natural-language description of the imagery you want."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`Max images to return (default 20, max ${MAX_LIMIT}).`),
      width: z
        .number()
        .int()
        .min(100)
        .max(2000)
        .optional()
        .describe("Thumbnail width in px (default 800)."),
    },
  },
  async ({ query, limit, width }) => {
    const els = await searchAll(query, limit ?? 20);
    const w = width ?? 800;
    return asJson({ query, count: els.length, results: els.map((e) => shape(e, w)) });
  },
);

server.registerTool(
  "cosmos_featured",
  {
    title: "Cosmos featured feed",
    description:
      "Get the cosmos.so homepage featured/curated images (no query). Useful for general design " +
      "inspiration or sampling what's trending on Cosmos.",
    inputSchema: {
      limit: z.number().int().min(1).max(40).optional().describe("Max images (default 20, max 40)."),
      width: z.number().int().min(100).max(2000).optional().describe("Thumbnail width in px (default 800)."),
    },
  },
  async ({ limit, width }) => {
    const page = await featuredPage();
    const w = width ?? 800;
    const items = page.items.slice(0, limit ?? 20);
    return asJson({ count: items.length, results: items.map((e) => shape(e, w)) });
  },
);

server.registerTool(
  "cosmos_download",
  {
    title: "Cosmos search + download",
    description:
      "Search cosmos.so and download the matching images to a local directory as .webp files. " +
      "Returns the directory path and how many files were saved. Use when the agent needs the actual " +
      "image files on disk, not just URLs.",
    inputSchema: {
      query: z.string().min(1).describe("Natural-language description of the imagery you want."),
      dir: z.string().min(1).describe("Absolute or relative directory to save images into."),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Max images (default 20)."),
      width: z.number().int().min(100).max(4000).optional().describe("Saved image width in px (default 1200)."),
    },
  },
  async ({ query, dir, limit, width }) => {
    const els = await searchAll(query, limit ?? 20);
    await mkdir(dir, { recursive: true });
    const w = width ?? 1200;
    let saved = 0;
    const pool = 6;
    for (let i = 0; i < els.length; i += pool) {
      const batch = els.slice(i, i + pool);
      const res = await Promise.all(
        batch.map(async (el) => {
          if (!el.url) return false;
          try {
            const r = await fetch(cdnUrl(el.url, { width: w, format: "webp", quality: 85 }), {
              headers: { "user-agent": "Mozilla/5.0" },
            });
            if (!r.ok || !r.body) return false;
            await pipeline(Readable.fromWeb(r.body as any), createWriteStream(join(dir, `${el.id}.webp`)));
            return true;
          } catch {
            return false;
          }
        }),
      );
      saved += res.filter(Boolean).length;
    }
    return asJson({ query, dir, requested: els.length, saved });
  },
);

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

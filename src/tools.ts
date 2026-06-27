/**
 * Shared Cosmos MCP tool definitions, registered onto an McpServer.
 * Used by both the stdio server (src/mcp.ts) and the HTTP server (src/mcp-http.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { searchAll, featuredPage, cdnUrl, type CosmosElement } from "./cosmos.js";
// cdnUrl is still used below for the download tool's resized fetch

const MAX_LIMIT = 200;

/** Compact, token-friendly shape for an LLM agent. Returns the original full-res image. */
function shape(el: CosmosElement) {
  return {
    id: el.id,
    type: el.type,
    url: el.url, // original full-resolution master, untouched
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

export function registerCosmosTools(server: McpServer): void {
  server.registerTool(
    "cosmos_search",
    {
      title: "Cosmos image search",
      description:
        "Search cosmos.so for images by a natural-language phrase (e.g. 'brutalist concrete interiors', " +
        "'wabi-sabi ceramics', 'film noir lighting'). The query is expanded semantically server-side. " +
        "Returns a list of images with full-resolution image URL, dimensions, original source, AI " +
        "caption, and permalink. Good for moodboards, visual references, and design inspiration. " +
        "Use `offset` (or `page`) to skip past earlier results and get the next batch — Cosmos caps a " +
        "single query at ~500 results total.",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language description of the imagery you want."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Max images to return per call (default 20, max ${MAX_LIMIT}).`),
        offset: z
          .number()
          .int()
          .min(0)
          .max(500)
          .optional()
          .describe("Skip this many results before returning (for paging). Default 0."),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-based page number; convenience alternative to offset (offset = (page-1)*limit)."),
      },
    },
    async ({ query, limit, offset, page }) => {
      const lim = limit ?? 20;
      const off = offset ?? (page ? (page - 1) * lim : 0);
      const els = await searchAll(query, lim, off);
      return asJson({ query, offset: off, limit: lim, count: els.length, results: els.map(shape) });
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
      },
    },
    async ({ limit }) => {
      const page = await featuredPage();
      const items = page.items.slice(0, limit ?? 20);
      return asJson({ count: items.length, results: items.map(shape) });
    },
  );

  server.registerTool(
    "cosmos_download",
    {
      title: "Cosmos search + download",
      description:
        "Search cosmos.so and download the matching images to a local directory as .webp files. " +
        "Returns the directory path and how many files were saved. Use when the agent needs the actual " +
        "image files on disk, not just URLs. (Server-side path — only useful for self-hosted setups.)",
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
}

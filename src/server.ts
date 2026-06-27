/**
 * Image-search HTTP API backed by Cosmos.so.
 *
 *   GET /api/search?q=brutalism&limit=60&width=800
 *        -> { query, count, results: [{ id, url, thumb, width, height, source, ... }] }
 *   GET /api/featured?limit=40
 *   GET /healthz
 *
 *   PORT env var (default 3000).
 *
 * Thin proxy + normalizer over the reverse-engineered Cosmos GraphQL API,
 * with a tiny in-memory TTL cache so repeated queries don't re-hit upstream.
 */
import "dotenv/config";
import express from "express";
import { searchAll, featuredPage, type CosmosElement } from "./cosmos.js";

const PORT = Number(process.env.PORT ?? 7070);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 5 * 60 * 1000);
const MAX_LIMIT = Number(process.env.MAX_LIMIT ?? 500);
const DEFAULT_LIMIT = Number(process.env.DEFAULT_LIMIT ?? 60);

interface CacheEntry {
  at: number;
  data: unknown;
}
const cache = new Map<string, CacheEntry>();

function cached<T>(key: string): T | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return e.data as T;
}

function shape(el: CosmosElement) {
  return {
    id: el.id,
    type: el.type,
    url: el.url, // original full-resolution master (default)
    width: el.width,
    height: el.height,
    blurHash: el.blurHash,
    owner: el.owner,
    source: el.sourceUrl,
    caption: el.caption,
    permalink: el.shareUrl,
  };
}

const app = express();

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.status(400).json({ error: "missing ?q=" });
    return;
  }
  const limit = Math.min(Number(req.query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);
  // paging: ?offset=N, or ?page=N (1-based). Cosmos caps a query at ~500 total.
  const page = Number(req.query.page ?? 0);
  const offset = Math.min(
    Number(req.query.offset ?? (page > 1 ? (page - 1) * limit : 0)) || 0,
    500,
  );
  // ?fresh=1 (or nocache=1) bypasses the in-memory cache and re-fetches from upstream
  const fresh = ["1", "true", "yes"].includes(String(req.query.fresh ?? req.query.nocache ?? "").toLowerCase());
  const key = `search:${q}:${limit}:${offset}`;

  try {
    let elements = fresh ? null : cached<CosmosElement[]>(key);
    let cacheHit = !!elements;
    if (!elements) {
      elements = await searchAll(q, limit, offset);
      cache.set(key, { at: Date.now(), data: elements });
    }
    res.json({
      query: q,
      offset,
      limit,
      count: elements.length,
      cached: cacheHit,
      results: elements.map(shape),
    });
  } catch (err) {
    res.status(502).json({ error: "upstream failed", detail: String(err) });
  }
});

app.get("/api/featured", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 40) || 40, 100);
  try {
    const page = await featuredPage();
    res.json({
      count: Math.min(page.items.length, limit),
      results: page.items.slice(0, limit).map(shape),
    });
  } catch (err) {
    res.status(502).json({ error: "upstream failed", detail: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`cosmo-api listening on http://localhost:${PORT}`);
  console.log(`  try: curl "http://localhost:${PORT}/api/search?q=brutalism&limit=20"`);
});

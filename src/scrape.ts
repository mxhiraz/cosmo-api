#!/usr/bin/env node
/**
 * CLI scraper. Pulls Cosmos search results to disk as JSON metadata,
 * and optionally downloads the images themselves.
 *
 *   tsx src/scrape.ts "brutalism" --limit 300 --out ./data --images
 *   tsx src/scrape.ts "kyoto, wabi-sabi, ceramics" --limit 100
 *
 * Multiple comma-separated queries are scraped sequentially.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { searchAll, cdnUrl, type CosmosElement } from "./cosmos.js";

interface Args {
  queries: string[];
  limit: number;
  out: string;
  images: boolean;
  width: number;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  const raw = positional.join(" ");
  const queries = raw
    .split(",")
    .map((q) => q.trim())
    .filter(Boolean);
  return {
    queries,
    limit: Number(opts.limit ?? 200),
    out: opts.out ?? "./data",
    images: opts.images === "true",
    width: Number(opts.width ?? 1200),
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "query";
}

async function downloadImage(el: CosmosElement, dir: string, width: number): Promise<boolean> {
  if (!el.url) return false;
  const url = cdnUrl(el.url, { width, format: "webp", quality: 85 });
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok || !res.body) return false;
  const file = join(dir, `${el.id}.webp`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(file));
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.queries.length === 0) {
    console.error('Usage: tsx src/scrape.ts "<query>[, query2, ...]" [--limit N] [--out DIR] [--images] [--width PX]');
    process.exit(1);
  }
  await mkdir(args.out, { recursive: true });

  for (const query of args.queries) {
    const s = slug(query);
    console.log(`\n▶ scraping "${query}" (limit ${args.limit})`);
    const elements = await searchAll(query, args.limit);
    console.log(`  got ${elements.length} elements`);

    const meta = {
      query,
      scrapedAt: new Date().toISOString(),
      count: elements.length,
      elements,
    };
    const metaFile = join(args.out, `${s}.json`);
    await writeFile(metaFile, JSON.stringify(meta, null, 2));
    console.log(`  wrote ${metaFile}`);

    if (args.images) {
      const imgDir = join(args.out, s);
      await mkdir(imgDir, { recursive: true });
      let ok = 0;
      // small concurrency pool to be polite to the CDN
      const pool = 6;
      for (let i = 0; i < elements.length; i += pool) {
        const batch = elements.slice(i, i + pool);
        const results = await Promise.all(
          batch.map((el) => downloadImage(el, imgDir, args.width).catch(() => false)),
        );
        ok += results.filter(Boolean).length;
        process.stdout.write(`\r  downloaded ${ok}/${elements.length}`);
      }
      process.stdout.write("\n");
      console.log(`  images in ${imgDir}`);
    }
  }
  console.log("\n✓ done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

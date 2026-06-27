# cosmo-api

Image scraper + image-search API backed by [cosmos.so](https://www.cosmos.so).

Cosmos is a visual bookmarking / moodboard site. This project wraps its
**undocumented, unauthenticated** GraphQL API so you can use it as your own
image-search backend — search a phrase, get back image URLs + metadata.

## How it works (reverse-engineered)

| | |
|---|---|
| Endpoint | `POST https://api.cosmos.so/graphql` |
| Auth | **none** for public search / featured feeds |
| Search | `searchElements(searchTerm: String!, meta: ListMetadataInput)` |
| Pagination | pass `meta.pageCursor = <previous response's meta.nextPageCursor>` |
| Page size | ~20 items/page, server caps a single query at **~500 results** |
| Images | `https://cdn.cosmos.so/<id>` — public CDN, supports `?format=webp&w=<px>&q=<1-100>` and `?rect=x,y,w,h` cropping |

The search term is **LLM-expanded server-side** (e.g. `brutalism` →
`brutalist-architecture--raw-concrete-textures--monolithic-geometric-forms…`),
so results are semantic rather than literal keyword matches.

> ⚠️ This relies on a private API and a CDN that isn't yours. Respect Cosmos's
> terms, creators' copyright, and rate limits. Built-in retry/backoff is polite,
> not aggressive. Use for personal/research purposes.

## Setup

```bash
npm install
```

Requires Node 18+ (uses the built-in `fetch`).

## CLI scraper

Dump search results to `./data/<slug>.json` (metadata), optionally download images:

```bash
# metadata only
npx tsx src/scrape.ts "wabi-sabi ceramics" --limit 100

# metadata + download webp images (600px wide) into ./data/<slug>/
npx tsx src/scrape.ts "brutalism" --limit 300 --out ./data --images --width 600

# several queries at once (comma-separated)
npx tsx src/scrape.ts "kyoto, film noir, risograph" --limit 80 --images
```

Flags: `--limit N` (default 200, cap ~500) · `--out DIR` (default `./data`) ·
`--images` (download files) · `--width PX` (download size, default 1200).

Each `data/<slug>.json` element looks like:

```json
{
  "id": 1114963728,
  "type": "image",
  "url": "https://cdn.cosmos.so/f40a691a-…",
  "width": 564, "height": 845, "blurHash": "00KUTT",
  "owner": "brooklyn",
  "sourceUrl": "https://www.pinterest.com/pin/…",
  "caption": "Sculptural vessels from the Lithic Collection…",
  "shareUrl": "https://www.cosmos.so/e/1114963728"
}
```

## Search API server

```bash
npx tsx src/server.ts            # dev
# or
npm run build && npm start       # compiled
PORT=8080 npm start              # custom port
```

Endpoints:

```
GET /api/search?q=<query>&limit=60&width=800
GET /api/featured?limit=40
GET /healthz
```

Example:

```bash
curl "http://localhost:3000/api/search?q=brutalism&limit=20"
```

```json
{
  "query": "brutalism",
  "count": 20,
  "results": [
    {
      "id": 911578334,
      "type": "image",
      "url":  "https://cdn.cosmos.so/c774afdf-…",
      "thumb":"https://cdn.cosmos.so/c774afdf-…?format=webp&w=800&q=80",
      "full": "https://cdn.cosmos.so/c774afdf-…?format=webp&q=90",
      "width": 425, "height": 640, "blurHash": "00LN.4",
      "owner": "lcluer",
      "source": "https://…", "caption": "…",
      "permalink": "https://www.cosmos.so/e/911578334"
    }
  ]
}
```

Results are cached in-memory for 5 minutes per `(query, limit)`.

## Files

- `src/cosmos.ts` — GraphQL client: `searchPage`, `searchAll`, `featuredPage`, `cdnUrl`.
- `src/scrape.ts` — CLI scraper → JSON + image files.
- `src/server.ts` — Express image-search API.

## Ideas to extend

- Persist to SQLite/Postgres instead of JSON; dedupe across queries by `id`.
- Add a CLIP/embedding index over downloaded images for true reverse-image / visual similarity search.
- Add `searchClusters` (boards) — same API surface, `searchClusters(searchTerm, filters)`.

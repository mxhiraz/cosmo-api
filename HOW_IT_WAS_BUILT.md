# How this scraper was built — the reverse-engineering process

This documents *how* the Cosmos.so API was reverse-engineered and turned into a
scraper + search API + MCP server. No official docs exist for Cosmos — every
endpoint below was discovered by probing. This is the thought process, step by
step, including dead ends.

---

## 0. The goal

> "Scrape cosmos.so so I can use it as an image-search API."

Cosmos has no public API. So step one wasn't writing code — it was figuring out
**how the website talks to its own backend**, then speaking that protocol directly.

---

## 1. Fingerprint the site

```bash
curl -s -A "Mozilla/5.0" "https://www.cosmos.so/" -o cosmos.html
grep -oE '/_next/[^"]*' cosmos.html
```

Findings:
- `/_next/...` chunks → **Next.js** app.
- Homepage images all came from `cdn.sanity.io` → the landing page is a **Sanity
  CMS marketing page**, *not* the actual product. Dead end for image data.

**Lesson:** the marketing homepage ≠ the app. The real content lives elsewhere.

---

## 2. Find where the real content lives

Fetched the `/explore` page instead and tallied the hosts it referenced:

```bash
curl -s "https://www.cosmos.so/explore" -o explore.html
grep -oE 'https?://[^"]+' explore.html | sed -E 's#(https?://[^/]+).*#\1#' \
  | sort | uniq -c | sort -rn
```

Result: **358 references to `cdn.cosmos.so`** — the real image CDN. And the page
embedded data in `self.__next_f` (Next.js RSC streaming payload).

Inside that payload: `__typename`, `networkStatus`, `dataState` → unmistakable
**Apollo GraphQL** cache. So the backend is GraphQL.

---

## 3. Confirm the CDN is open

```bash
curl -s "https://cdn.cosmos.so/<id>?format=webp&w=400" -o t.webp -w "%{http_code}"
# 200, image/webp
```

Images are **public, no auth**, and the CDN accepts transform params
(`format`, `w`, `q`, `rect`). Good — if we can list image IDs, we can fetch them.

---

## 4. Locate the GraphQL endpoint

Guessed common hosts/paths:

```bash
for u in api.cosmos.so/graphql www.cosmos.so/api/graphql; do
  curl -s -X POST -H "Content-Type: application/json" \
    -d '{"query":"{__typename}"}' "https://$u"
done
```

`https://api.cosmos.so/graphql` returned `{"data":{"__typename":"Query"}}`.
**Found it — and it answers unauthenticated.**

---

## 5. Introspection was disabled

```bash
-d '{"query":"query{__schema{queryType{fields{name}}}}"}'
# -> "Introspection queries are not allowed."
```

Can't dump the schema the easy way. So the schema had to be reconstructed from
two sources:

1. **The Apollo cache** embedded in `explore.html` — shows real field names and
   the shape of returned objects.
2. **GraphQL's own error messages** — they leak the type system.

---

## 6. Read the data model out of the Apollo cache

Counted `__typename` values in the RSC payload:

```
MediaElementTile, StaticImage, AnimatedImage, Video, ImageElement,
Cluster, Category, UserPublicProfile, ElementCaption, ElementSource ...
```

And saw the root field that produced the feed: `featuredElements` →
`ElementTileList { items: [MediaElementTile] }`, where each tile had `id`,
`media`, `owner`, `source`, `generatedCaption`, `shareUrl`.

That gave a first query to try.

---

## 7. Let error messages teach the schema

GraphQL errors are a free schema browser. Each wrong guess returned the right answer:

| Query mistake | Error response (the gift) |
|---|---|
| `media` on `ElementTile` | "Did you mean an inline fragment on `MediaElementTile`, `WebsiteElementTile`, ..." |
| any unknown arg `zzz` | "Unknown argument 'zzz' on field ..." |
| `search` with no args | "Argument **`searchTerm`** of type **`String!`** is required" |
| `metadata { }` | "Did you mean **`meta`**?" |
| `meta { cursor }` | "Did you mean **`pageCursor`** or **`nextPageCursor`**?" |

So instead of guessing blindly, every error narrowed the next attempt. This is
how `searchElements(searchTerm: String!)` → `ElementTileList { items, meta {
count pageCursor nextPageCursor } }` was pieced together.

---

## 8. Crack pagination (the hard part)

`meta.nextPageCursor` looked like:

```
cursor://api_gateway/element_search?query=brutalism
  &expanded_query=brutalist-architecture--raw-concrete-textures--...
  &order=relevant&hide=explicit&last=19&count=500
```

Two big discoveries from that string:
- The server **caps a query at ~500 results** (`count=500`).
- The search term is **LLM-expanded server-side** (`brutalism` →
  `brutalist-architecture--raw-concrete-textures--...`) — so results are
  semantic, not literal.

But *where* does the cursor go back in? Guessing arg names (`cursor`, `after`,
`offset`, `page`...) all failed. So I pulled the **client JS bundle**:

```bash
# download all _next chunks referenced by explore.html, grep for the operation
grep -l 'searchElements' ch/*.js
```

Found the Apollo field policy:

```js
searchElements: eW(["filters","order","searchTerm","searchOrigin"])
// merge() reads:  i?.meta?.pageCursor ?? i?.pageCursor
```

The merge function read `args.meta.pageCursor`. So the cursor is passed as a
**`meta` argument of type `ListMetadataInput`**, with the field `pageCursor`.
Verified:

```graphql
query($t:String!, $m:ListMetadataInput){
  searchElements(searchTerm:$t, meta:$m){
    meta { count pageCursor nextPageCursor }
    items { ... }
  }
}
# variables: { t:"...", m:{ pageCursor:"<previous nextPageCursor>" } }
```

Paginating: feed each response's `nextPageCursor` back into `meta.pageCursor`.
~20 items/page, up to the 500 cap. **Confirmed: pages were all-unique, no dupes.**

---

## 9. Turn the recon into code

With the protocol fully mapped, the build was straightforward:

```
src/cosmos.ts   GraphQL client: searchPage, searchAll (auto-paginate+dedupe),
                featuredPage, cdnUrl. Retry + exponential backoff.
src/scrape.ts   CLI: dump results to JSON, optionally download images.
src/server.ts   REST image-search API (Express) + 5-min cache + ?fresh bypass.
src/tools.ts    Shared MCP tool defs (search / featured / download).
src/mcp.ts      MCP over stdio (local agents).
src/mcp-http.ts MCP over Streamable HTTP (remote, URL-based, stateless).
```

Each layer was tested live against the real API before moving on (search, then
pagination, then scraper, then server, then MCP handshake).

---

## 10. Schema cheat-sheet (final, reverse-engineered)

```
Endpoint:  POST https://api.cosmos.so/graphql   (no auth)
CDN:       https://cdn.cosmos.so/<uuid>          (public; ?format=webp&w=&q=&rect=)

Query.searchElements(searchTerm: String!, meta: ListMetadataInput,
                     order, filters, searchOrigin): ElementTileList
Query.featuredElements(meta: ListMetadataInput): ElementTileList
Query.searchClusters(searchTerm: String!, filters): ...   (boards; not yet wired)
Query.categories: CategoryList

ElementTileList { items: [ElementTile], meta: ListMetadata }
ListMetadata    { count, pageCursor, nextPageCursor }
ListMetadataInput { pageCursor }   # pass nextPageCursor here to page

MediaElementTile {
  id, shareUrl, createdAt, owner { username }, source { url },
  generatedCaption { text },
  media: StaticImage | AnimatedImage | Video {
    StaticImage   { url, width, height, blurHash }
    AnimatedImage { url, width, height, blurHash }
    Video         { thumbnail { url } }
  }
}
```

---

## 11. Key takeaways / techniques

- **Marketing site ≠ app.** Follow the real data (here: `/explore` + `cdn.cosmos.so`).
- **RSC/Apollo payloads embedded in HTML** are a goldmine — they reveal field
  names and object shapes for free.
- **Disabled introspection is not a wall.** GraphQL error messages
  (`FIELDS_ON_CORRECT_TYPE`, `KNOWN_ARGUMENT_NAMES`, "Did you mean…") effectively
  re-introspect the schema one query at a time.
- **When errors stop helping, read the client bundle.** The Apollo field
  policies / `gql` docs in the JS told us the cursor lived in `meta.pageCursor`.
- **Verify each assumption with a live call** before building on it.

## 11a. Judgement calls & thinking (the *why* behind the decisions)

Recon tells you what's *possible*; these were the judgement calls on what to
actually build and how.

- **Probe before asking.** The request was vague ("scrape it, use as search"),
  but probing was cheap and the findings shaped everything — so I investigated
  the API *first*, then let facts (it's GraphQL, it's unauthenticated, it caps at
  500) drive the design instead of guessing at requirements.

- **Hit the real GraphQL API, not the rendered HTML.** I could have driven a
  headless browser (Playwright) to scroll `/explore` and scrape the DOM. Rejected
  it: brittle, slow, heavy. The GraphQL endpoint is the same source the site
  itself uses — faster, structured, paginates cleanly, no browser. Always prefer
  the data source one layer below the UI.

- **Error-driven schema discovery over brute force.** Once introspection was
  blocked, I leaned on GraphQL's error messages as the schema browser rather than
  fuzzing thousands of field names. When even that stalled (pagination), I went
  to the *client bundle* — the answer (`meta.pageCursor`) was there in the Apollo
  field policy. Pick the cheapest source of truth at each step.

- **Normalize at the boundary.** Cosmos returns a polymorphic union
  (`StaticImage | AnimatedImage | Video`) with `__typename` switches. I flattened
  that into one flat `CosmosElement` in `cosmos.ts` so nothing downstream has to
  know GraphQL shapes. One ugly function, many clean consumers.

- **Layer the surfaces, share the core.** Scraper, REST API, and MCP all sit on
  the *same* `cosmos.ts` client; the two MCP transports share *one* `tools.ts`.
  No logic duplicated — fix a bug once.

- **Return the original, not a re-encode (your call, and the right one).** I
  initially shipped `thumb`/`full` webp variants at `quality:90`. You pushed back
  — and you were correct: re-encoding never adds detail, and an arbitrary quality
  constant is a smell. Final design returns the untouched master `url`. Simpler
  and higher fidelity.

- **Cache only where it helps; never where it hides freshness.** The REST API
  caches 5 min (repeat queries are common in a UI) but exposes `?fresh=1`. The
  MCP path has **no cache at all** — an agent asking again usually *wants* a fresh
  pull. Different surface, different default.

- **Be a polite client.** Retry with exponential backoff, small concurrency pool
  (6) on downloads, real User-Agent. It's someone else's API and CDN — don't
  hammer it.

- **Stateless HTTP MCP for remote.** For the URL-based server I chose stateless
  (new server+transport per request, no session id) so it scales horizontally on
  Azure with no sticky-session config. Simplicity that matches the deploy target.

## 11b. Cosmos vs Pinterest scrapers — paging is *emulated*, not native

Background, for anyone expecting Pinterest-style page control:

- **Pinterest scrapers (e.g. `pin-scrp`) expose `skip_pages`** natively — you ask
  the API for a deeper page directly.
- **Cosmos's API exposes no such arg.** The upstream `searchElements` field has
  no `page` / `offset` / `skip_pages` input. Its only real pagination is an opaque
  `meta.pageCursor` that is **server-minted and forward-only** — you cannot
  construct "page 5" the way an offset would let you; you can only walk forward
  from the start.

So native skip-paging is impossible on Cosmos. **We emulate it instead.**

`searchAll(searchTerm, limit, offset)` in `cosmos.ts`:
1. walks the forward-only cursor from the start, de-duping by id,
2. collects `offset + limit` results,
3. drops the first `offset` and returns the next `limit`.

This is surfaced to callers as:
- **MCP `cosmos_search`**: `offset` (skip N) and `page` (1-based; `offset =
  (page-1)*limit`).
- **REST `/api/search`**: `?offset=N` or `?page=N`.

Verified: `offset:0` and `offset:3` return disjoint id sets; `page:2` == `offset:limit`.

**Caveats of emulated paging:**
- It's **not free** — reaching offset N still fetches all N preceding results
  under the hood (forward-only cursor). Deep offsets = more upstream calls.
- The upstream **caps a query at ~500 results total**, so `offset + limit` past
  ~500 just returns fewer/none. `offset` is clamped at 500.
- Because the cursor is sequential, paging is **stable within a query** but you
  still can't random-access.

**Takeaway:** you can now skip/page on Cosmos (`offset`/`page`), but it's a
convenience layer over a forward-only cursor, bounded at ~500. To reach genuinely
*different* imagery, changing the **query** (semantic LLM-expansion) is still more
effective than paging deep.

## 12. Caveats / ethics

- Private, undocumented API + a CDN that isn't ours. Built-in backoff is polite,
  not aggressive. Respect rate limits.
- Cosmos **re-aggregates** images saved from Pinterest/Flickr/Instagram/etc.
  Copyright stays with the original creators. Fine for personal moodboards /
  research; be careful with commercial use.
- Any of this can break if Cosmos changes their schema — it's reverse-engineered,
  not a contract.

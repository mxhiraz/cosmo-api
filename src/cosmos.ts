/**
 * Minimal client for the (undocumented, unauthenticated) Cosmos.so GraphQL API.
 *
 * Reverse-engineered from https://www.cosmos.so (Apollo GraphQL backend).
 *   Endpoint : POST https://api.cosmos.so/graphql
 *   Auth     : none required for public search / featured feeds
 *   Search   : searchElements(searchTerm: String!, meta: ListMetadataInput)
 *   Paginate : pass meta.pageCursor = previous response's meta.nextPageCursor
 *              ~20 items/page, server caps a query at 500 results.
 *
 * The search term is LLM-expanded server-side (e.g. "brutalism" ->
 * "brutalist-architecture--raw-concrete-textures--..."), so results are
 * semantic, not literal keyword matches.
 */

const ENDPOINT = "https://api.cosmos.so/graphql";
const UA = "Mozilla/5.0 (cosmo-api scraper)";

/** A normalized image/media element from Cosmos. */
export interface CosmosElement {
  /** Cosmos element id. */
  id: number;
  /** "image" | "animated" | "video" | "other" */
  type: string;
  /** Direct CDN url of the media (no transform params). */
  url: string | null;
  width: number | null;
  height: number | null;
  /** BlurHash placeholder, if present. */
  blurHash: string | null;
  /** Uploader username on Cosmos. */
  owner: string | null;
  /** Original source url the image was saved from (Pinterest, Flickr, ...). */
  sourceUrl: string | null;
  /** AI-generated caption text, if any. */
  caption: string | null;
  /** Public permalink on cosmos.so. */
  shareUrl: string | null;
}

export interface SearchPage {
  items: CosmosElement[];
  /** Total results the server will serve for this query (cap ~500). */
  count: number;
  /** Cursor to fetch the next page, or null when exhausted. */
  nextPageCursor: string | null;
}

const ELEMENT_FIELDS = `
  __typename
  id
  ... on MediaElementTile {
    shareUrl
    owner { username }
    source { url }
    generatedCaption { text }
    media {
      __typename
      ... on StaticImage { url width height blurHash }
      ... on AnimatedImage { url width height blurHash }
      ... on Video { thumbnail { url } }
    }
  }
`;

const SEARCH_QUERY = `
  query SearchElements($searchTerm: String!, $meta: ListMetadataInput) {
    searchElements(searchTerm: $searchTerm, meta: $meta) {
      meta { count pageCursor nextPageCursor }
      items { ${ELEMENT_FIELDS} }
    }
  }
`;

const FEATURED_QUERY = `
  query FeaturedElements($meta: ListMetadataInput) {
    featuredElements(meta: $meta) {
      meta { count pageCursor nextPageCursor }
      items { ${ELEMENT_FIELDS} }
    }
  }
`;

interface GqlError {
  message: string;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as { data?: T; errors?: GqlError[] };
      if (json.errors?.length) {
        throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
      }
      if (!json.data) throw new Error("GraphQL: empty data");
      return json.data;
    } catch (err) {
      lastErr = err;
      // exponential backoff: 0.5s, 1s, 2s
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

function normalize(tile: any): CosmosElement | null {
  if (!tile || tile.__typename !== "MediaElementTile") return null;
  const media = tile.media ?? {};
  let type = "other";
  let url: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let blurHash: string | null = null;

  switch (media.__typename) {
    case "StaticImage":
      type = "image";
      url = media.url ?? null;
      width = media.width ?? null;
      height = media.height ?? null;
      blurHash = media.blurHash ?? null;
      break;
    case "AnimatedImage":
      type = "animated";
      url = media.url ?? null;
      width = media.width ?? null;
      height = media.height ?? null;
      blurHash = media.blurHash ?? null;
      break;
    case "Video":
      type = "video";
      url = media.thumbnail?.url ?? null;
      break;
  }

  return {
    id: tile.id,
    type,
    url,
    width,
    height,
    blurHash,
    owner: tile.owner?.username ?? null,
    sourceUrl: tile.source?.url ?? null,
    caption: tile.generatedCaption?.text || null,
    shareUrl: tile.shareUrl ?? null,
  };
}

/** Fetch a single page of search results. */
export async function searchPage(
  searchTerm: string,
  pageCursor?: string | null,
): Promise<SearchPage> {
  const data = await gql<{ searchElements: any }>(SEARCH_QUERY, {
    searchTerm,
    meta: pageCursor ? { pageCursor } : null,
  });
  const se = data.searchElements;
  return {
    items: (se.items ?? []).map(normalize).filter(Boolean) as CosmosElement[],
    count: se.meta?.count ?? 0,
    nextPageCursor: se.meta?.nextPageCursor ?? null,
  };
}

/** Fetch a single page of the featured (homepage) feed. */
export async function featuredPage(pageCursor?: string | null): Promise<SearchPage> {
  const data = await gql<{ featuredElements: any }>(FEATURED_QUERY, {
    meta: pageCursor ? { pageCursor } : null,
  });
  const fe = data.featuredElements;
  return {
    items: (fe.items ?? []).map(normalize).filter(Boolean) as CosmosElement[],
    count: fe.meta?.count ?? 0,
    nextPageCursor: fe.meta?.nextPageCursor ?? null,
  };
}

/**
 * Search and auto-paginate up to `limit` elements (server caps ~500/query).
 * De-dupes by id and stops on empty page or exhausted cursor.
 */
export async function searchAll(
  searchTerm: string,
  limit = 200,
): Promise<CosmosElement[]> {
  const out: CosmosElement[] = [];
  const seen = new Set<number>();
  let cursor: string | null | undefined = undefined;

  while (out.length < limit) {
    const page: SearchPage = await searchPage(searchTerm, cursor);
    if (page.items.length === 0) break;
    for (const el of page.items) {
      if (seen.has(el.id)) continue;
      seen.add(el.id);
      out.push(el);
      if (out.length >= limit) break;
    }
    if (!page.nextPageCursor) break;
    cursor = page.nextPageCursor;
  }
  return out;
}

/**
 * Build a transformed CDN url. Cosmos CDN supports query params:
 *   format=webp|jpg|png   w=<px>   q=<1-100>   rect=x,y,w,h (crop)
 */
export function cdnUrl(
  url: string,
  opts: { width?: number; format?: string; quality?: number } = {},
): string {
  if (!url) return url;
  const u = new URL(url);
  if (opts.format) u.searchParams.set("format", opts.format);
  if (opts.width) u.searchParams.set("w", String(opts.width));
  if (opts.quality) u.searchParams.set("q", String(opts.quality));
  return u.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

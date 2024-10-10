import { SUGGESTION_ORIGIN } from "./constants.js";
import { assertImdbOnlyUrl, imdbFetch } from "./guard.js";
import type { SuggestionEntry } from "./types.js";
import { logger } from "../logger.js";

interface RawSuggestionDoc {
  id?: string;
  l?: string;
  q?: string;
  qid?: string;
  y?: number;
  s?: string;
  i?: { imageUrl?: string; width?: number; height?: number };
  rank?: number;
}

/**
 * Official IMDb suggestion API (WAF-free, IMDb-owned host).
 * Used for search-by-name; never leaves imdb-owned infrastructure.
 */
export async function searchTitles(query: string, limit = 8): Promise<SuggestionEntry[]> {
  const q = query.trim().toLowerCase().replace(/\s+/g, "_");
  if (!q) return [];
  const first = q[0] ?? "s";
  const url = assertImdbOnlyUrl(
    `${SUGGESTION_ORIGIN}/suggestion/${encodeURIComponent(first)}/${encodeURIComponent(q)}.json`,
  );
  logger.debug(`Suggestion search: ${url}`);
  const res = await imdbFetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "application/json",
      Origin: "https://www.imdb.com",
      Referer: "https://www.imdb.com/",
    },
  });
  if (!res.ok) {
    logger.warn(`Suggestion API ${res.status} for query "${query}"`);
    return [];
  }
  const json = (await res.json()) as { d?: RawSuggestionDoc[] };
  const docs = Array.isArray(json.d) ? json.d : [];
  return docs
    .filter((d) => d.id?.startsWith("tt"))
    .slice(0, limit)
    .map((d) => ({
      id: d.id as string,
      label: d.l ?? d.id ?? "",
      kind: d.q ?? d.qid ?? "unknown",
      year: typeof d.y === "number" ? d.y : null,
      stars: d.s,
      poster: d.i?.imageUrl ?? null,
    }));
}

export function parseSuggestionPayload(json: unknown, limit = 8): SuggestionEntry[] {
  const docs = (json as { d?: RawSuggestionDoc[] })?.d;
  if (!Array.isArray(docs)) return [];
  return docs
    .filter((d) => typeof d?.id === "string" && (d.id as string).startsWith("tt"))
    .slice(0, limit)
    .map((d) => ({
      id: d.id as string,
      label: d.l ?? (d.id as string),
      kind: d.q ?? d.qid ?? "unknown",
      year: typeof d.y === "number" ? d.y : null,
      stars: d.s,
      poster: d.i?.imageUrl ?? null,
    }));
}

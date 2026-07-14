/**
 * Closed allow-list of IMDb-owned hosts. NOTHING else may be fetched.
 * See AGENTS.md section 2 — this list is binding.
 */
export const ALLOWED_HOSTS = new Set<string>([
  "imdb.com",
  "www.imdb.com",
  "m.imdb.com",
  "v3.sg.media-imdb.com",
  "sg.media-imdb.com",
  "datasets.imdbws.com",
  "developer.imdb.com",
  // IMDb image CDN — only for image bytes/URLs IMDb itself returns.
  "m.media-amazon.com",
]);

export const IMDB_ORIGIN = "https://www.imdb.com";
export const SUGGESTION_ORIGIN = "https://v3.sg.media-imdb.com";
export const DATASETS_ORIGIN = "https://datasets.imdbws.com";

export const DATASET_FILES = [
  "title.basics.tsv.gz",
  "title.ratings.tsv.gz",
  "title.crew.tsv.gz",
  "title.principals.tsv.gz",
  "title.episode.tsv.gz",
  "title.akas.tsv.gz",
  "name.basics.tsv.gz",
] as const;

export type DatasetFile = (typeof DATASET_FILES)[number];

/** Real-browser headers used for every IMDb HTML request. */
export function imdbHtmlHeaders(referer = "https://www.google.com/"): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: referer,
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
  };
}

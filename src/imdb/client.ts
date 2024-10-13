import {
  DATASET_FILES,
  type DatasetFile,
} from "./constants.js";
import { assertImdbOnlyUrl, isImdbOnlyUrl } from "./guard.js";
import {
  episodesUrl,
  extractTitleId,
  fullCreditsUrl,
  isTitleId,
  normalizeTitleInput,
  parentalGuideUrl,
  photosUrl,
  referenceUrl,
  reviewsUrl,
  taglinesUrl,
  titleUrl,
} from "./ids.js";
import {
  akasForTitle,
  basicsForTitle,
  cacheDir,
  crewForTitle,
  ensureDataset,
  episodesForSeries,
  principalsForTitle,
  ratingsForTitle,
  readCachedDataset,
  splitNconsts,
} from "./datasets.js";
import { parseSuggestionPayload, searchTitles } from "./suggestion.js";
import type { SuggestionEntry } from "./types.js";

// ---------------------------------------------------------------------------
// ImdbClient — the dedicated IMDb data-access library of this repo.
// Pure IMDb-only access (search API, official bulk datasets, canonical URL
// builders) behind the closed host allow-list. Browser crawling lives in
// src/crawler/ and uses this client for everything non-browser.
// ---------------------------------------------------------------------------

export interface ImdbClientOptions {
  /** Base dir for the dataset cache (.cache/imdb). Defaults to cwd. */
  baseDir?: string;
}

export class ImdbClient {
  readonly baseDir: string;

  constructor(opts: ImdbClientOptions = {}) {
    this.baseDir = opts.baseDir ?? process.cwd();
  }

  // --- Guard ---------------------------------------------------------------
  isImdbUrl(url: string): boolean {
    return isImdbOnlyUrl(url);
  }

  assertUrl(url: string): string {
    return assertImdbOnlyUrl(url);
  }

  // --- Canonical IMDb URLs (all validated) ----------------------------------
  title(id: string): string {
    return titleUrl(id);
  }

  reviews(id: string): string {
    return reviewsUrl(id);
  }

  parentalGuide(id: string): string {
    return parentalGuideUrl(id);
  }

  episodes(id: string, season?: number): string {
    return episodesUrl(id, season);
  }

  taglines(id: string): string {
    return taglinesUrl(id);
  }

  photos(id: string): string {
    return photosUrl(id);
  }

  fullCredits(id: string): string {
    return fullCreditsUrl(id);
  }

  reference(id: string): string {
    return referenceUrl(id);
  }

  /** Normalize any user input (bare tt id, URL) to {imdbId, url}. */
  normalize(input: string): { imdbId: string; url: string } {
    return normalizeTitleInput(input);
  }

  extractId(input: string): string | null {
    return extractTitleId(input);
  }

  isTitle(id: string): boolean {
    return isTitleId(id);
  }

  // --- Search (official suggestion API, WAF-free) ----------------------------
  async search(query: string, limit = 8): Promise<SuggestionEntry[]> {
    return searchTitles(query, limit);
  }

  parseSearchPayload(json: unknown, limit = 8): SuggestionEntry[] {
    return parseSuggestionPayload(json, limit);
  }

  // --- Official bulk datasets -------------------------------------------------
  datasetFiles(): readonly DatasetFile[] {
    return DATASET_FILES;
  }

  cacheDir(): string {
    return cacheDir(this.baseDir);
  }

  async ensureDataset(file: DatasetFile): Promise<string> {
    return ensureDataset(file, this.baseDir);
  }

  readDataset(file: DatasetFile): string | null {
    return readCachedDataset(file, this.baseDir);
  }

  basics(titleId: string): ReturnType<typeof basicsForTitle> {
    const text = this.readDataset("title.basics.tsv.gz");
    return text ? basicsForTitle(text, titleId.toLowerCase()) : null;
  }

  ratings(titleId: string): ReturnType<typeof ratingsForTitle> {
    const text = this.readDataset("title.ratings.tsv.gz");
    return text ? ratingsForTitle(text, titleId.toLowerCase()) : null;
  }

  crew(titleId: string): { directors: string[]; writers: string[] } | null {
    const text = this.readDataset("title.crew.tsv.gz");
    if (!text) return null;
    const row = crewForTitle(text, titleId.toLowerCase());
    if (!row) return null;
    return { directors: splitNconsts(row.directors), writers: splitNconsts(row.writers) };
  }

  akas(titleId: string, limit = 25): ReturnType<typeof akasForTitle> {
    const text = this.readDataset("title.akas.tsv.gz");
    return text ? akasForTitle(text, titleId.toLowerCase(), limit) : [];
  }

  seriesEpisodes(seriesId: string): ReturnType<typeof episodesForSeries> {
    const text = this.readDataset("title.episode.tsv.gz");
    return text ? episodesForSeries(text, seriesId.toLowerCase()) : [];
  }

  principals(titleId: string, limit = 15): ReturnType<typeof principalsForTitle> {
    const text = this.readDataset("title.principals.tsv.gz");
    return text ? principalsForTitle(text, titleId.toLowerCase(), limit) : [];
  }
}

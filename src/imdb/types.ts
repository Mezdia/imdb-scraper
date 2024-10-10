export type MediaKind = "movie" | "series" | "episode" | "unknown";

export interface CastMember {
  name: string;
  role?: string;
  imdbId?: string;
}

export interface Review {
  title: string;
  content: string;
  author?: string;
  rating?: number | null;
}

export interface ParentalGuideItem {
  type: string;
  rating: string;
}

export interface EpisodeRef {
  imdbId: string;
  season?: number | null;
  episode?: number | null;
  title?: string;
}

export interface TitleRecord {
  imdbId: string;
  url: string;
  title: string;
  kind: MediaKind;
  year?: string | null;
  date?: string | null;
  rating?: string | null;
  votes?: number | null;
  description?: string | null;
  plot?: string | null;
  runtime?: string | null;
  runtimeMinutes?: number | null;
  genres?: string[];
  directors?: string[];
  writers?: string[];
  cast?: CastMember[];
  poster?: string | null;
  parentsGuide?: ParentalGuideItem[] | null;
  reviews?: Review[] | null;
  episodes?: EpisodeRef[] | null;
  episodeCount?: number | null;
  seriesId?: string | null;
  season?: number | null;
  episode?: number | null;
  /** Fields we attempted but could not obtain from IMDb. */
  missing?: string[];
  scrapedAt: string;
  provenance: string[];
}

export interface SuggestionEntry {
  id: string;
  label: string;
  kind: string;
  year?: number | null;
  stars?: string;
  poster?: string | null;
}

export interface CrawlOptions {
  includeReviews: boolean;
  includeParentsGuide: boolean;
  deepReviews: boolean;
  includeEpisodes: boolean;
  maxEpisodes: number;
  concurrency: number;
  politenessMs: number;
  retries: number;
  timeoutMs: number;
  headless: boolean;
  engine: "datasets" | "browser" | "auto";
}

export const DEFAULT_CRAWL_OPTIONS: CrawlOptions = {
  includeReviews: true,
  includeParentsGuide: true,
  deepReviews: false,
  includeEpisodes: true,
  maxEpisodes: 500,
  concurrency: 3,
  politenessMs: 1200,
  retries: 3,
  timeoutMs: 45_000,
  headless: true,
  engine: "auto",
};

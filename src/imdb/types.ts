export type MediaKind = "movie" | "series" | "episode" | "unknown";

export interface CastMember {
  name: string;
  role?: string;
  imdbId?: string;
}

/** Full credit entry (any department), e.g. writer/producer/composer. */
export interface CreditEntry {
  name: string;
  imdbId?: string;
  category: string;
  job?: string;
  characters?: string;
}

export interface Review {
  title: string;
  content: string;
  author?: string;
  authorId?: string;
  rating?: number | null;
  date?: string;
  helpful?: number | null;
}

export interface ParentalGuideItem {
  type: string;
  rating: string;
  votes?: number | null;
  totalVotes?: number | null;
  breakdown?: { rating: string; votes: number }[];
  description?: string;
  details?: { text: string; spoiler: boolean }[];
}

export interface EpisodeRef {
  imdbId: string;
  season?: number | null;
  episode?: number | null;
  title?: string;
  airDate?: string;
  rating?: string | null;
  votes?: number | null;
  poster?: string;
  plot?: string;
}

export interface TrailerRef {
  id: string;
  name?: string;
  url?: string;
  runtimeSeconds?: number;
}

/** Localized / alternative title from official title.akas. */
export interface AkaEntry {
  title: string;
  region?: string;
  language?: string;
  types?: string;
  isOriginal?: boolean;
}

export interface BoxOffice {
  budget?: string;
  openingWeekend?: string;
  grossUSA?: string;
  grossWorldwide?: string;
}

export interface TitleRecord {
  imdbId: string;
  url: string;

  // --- A. Identity & classification --------------------------------------
  title: string;
  originalTitle?: string | null;
  titleType?: string | null;
  kind: MediaKind;
  isAdult?: boolean | null;
  akas?: AkaEntry[] | null;

  // --- B. Dates, release, origin ------------------------------------------
  year?: string | null;
  date?: string | null;
  releaseDate?: string | null;
  endYear?: string | null;
  countries?: string[];
  languages?: string[];
  filmingLocations?: string[];
  productionCompanies?: string[];

  // --- C. Ratings & standing ----------------------------------------------
  rating?: string | null;
  votes?: number | null;
  metascore?: number | null;
  top250Rank?: number | null;

  // --- D. Story ------------------------------------------------------------
  description?: string | null;
  plot?: string | null;
  tagline?: string | null;
  genres?: string[];
  keywords?: string[];

  // --- E. Production facts --------------------------------------------------
  runtime?: string | null;
  runtimeMinutes?: number | null;
  contentRating?: string | null;
  colorInfo?: string[];
  soundMix?: string[];
  awardsSummary?: string | null;

  // --- F. Money --------------------------------------------------------------
  boxOffice?: BoxOffice | null;

  // --- G. People ---------------------------------------------------------------
  directors?: string[];
  writers?: string[];
  creators?: string[];
  cast?: CastMember[];
  credits?: CreditEntry[];

  // --- H. Media gallery (IMDb CDN only) ------------------------------------------
  poster?: string | null;
  posterCaption?: string | null;
  gallery?: string[] | null;
  photoCount?: number | null;
  videoCount?: number | null;
  trailers?: TrailerRef[] | null;

  // --- I. Guidance & reviews -------------------------------------------------------
  parentsGuide?: ParentalGuideItem[] | null;
  reviews?: Review[] | null;
  reviewCount?: number | null;

  // --- J. Series ---------------------------------------------------------------------
  episodes?: EpisodeRef[] | null;
  episodeCount?: number | null;
  totalSeasons?: number | null;
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
  deepEpisodes: boolean;
  includeGallery: boolean;
  maxGalleryPhotos: number;
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
  deepEpisodes: false,
  includeGallery: false,
  maxGalleryPhotos: 20,
  maxEpisodes: 500,
  concurrency: 3,
  politenessMs: 1200,
  retries: 3,
  timeoutMs: 45_000,
  headless: true,
  engine: "auto",
};

// IScrapeMDB IMDb client library — public entry point.
// Everything network-facing stays inside the IMDb allow-list (see guard.ts).
export { ImdbClient, type ImdbClientOptions } from "./client.js";
export { assertImdbOnlyUrl, isImdbOnlyUrl, imdbFetch, NonImdbSourceError } from "./guard.js";
export {
  ALLOWED_HOSTS,
  DATASET_FILES,
  DATASETS_ORIGIN,
  IMDB_ORIGIN,
  SUGGESTION_ORIGIN,
  imdbHtmlHeaders,
  type DatasetFile,
} from "./constants.js";
export {
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
export { SELECTORS } from "./selectors.js";
export { searchTitles, parseSuggestionPayload } from "./suggestion.js";
export {
  akasForTitle,
  basicsForTitle,
  cacheDir,
  cachedPath,
  crewForTitle,
  datasetUrl,
  ensureDataset,
  episodesForSeries,
  indexRatingsTsv,
  namesIndex,
  parseBasicsTsv,
  parseTsv,
  principalsForTitle,
  ratingsForTitle,
  readCachedDataset,
  splitNconsts,
} from "./datasets.js";
export { DEFAULT_CRAWL_OPTIONS } from "./types.js";
export type {
  AkaEntry,
  BoxOffice,
  CastMember,
  CrawlOptions,
  CreditEntry,
  EpisodeRef,
  MediaKind,
  ParentalGuideItem,
  Review,
  SuggestionEntry,
  TitleRecord,
  TrailerRef,
} from "./types.js";

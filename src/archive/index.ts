// Archive BETA barrel — isolated Wayback fallback (AGENTS.md §5).
export {
  ArchiveClient,
  enhanceWithArchiveBeta,
  extractArchiveGallery,
  isWaybackMiss,
  mergeArchiveIntoRecord,
  pickLatestCdxTimestamp,
  scoreArchiveRichness,
  type ArchiveFetchResult,
} from "./archiveClient.js";
export {
  NonArchivedImdbUrlError,
  archiveCdxFetch,
  archiveFetch,
  archiveHtmlHeaders,
  assertArchiveCdxUrl,
  assertArchiveUrl,
  buildArchiveCdxUrl,
  buildArchiveUrl,
  extractArchiveTimestamp,
  extractEmbeddedImdbUrl,
  isArchiveCdxUrl,
  isArchiveUrl,
} from "./archiveGuard.js";
export {
  ARCHIVE_HOST,
  ARCHIVE_ORIGIN,
  DEFAULT_ARCHIVE_OPTIONS,
  needsArchiveFallback,
  normalizeArchiveTimestamp,
  withArchiveFields,
  type ArchiveOptions,
  type ArchivedTitleRecord,
} from "./archiveTypes.js";

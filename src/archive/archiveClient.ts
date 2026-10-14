import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { TitleRecord } from "../imdb/types.js";
import {
  archiveCdxFetch,
  archiveFetch,
  archiveHtmlHeaders,
  assertArchiveUrl,
  buildArchiveCdxUrl,
  buildArchiveUrl,
  extractArchiveTimestamp,
} from "./archiveGuard.js";
import {
  type ArchiveOptions,
  type ArchivedTitleRecord,
  needsArchiveFallback,
  withArchiveFields,
} from "./archiveTypes.js";
import {
  canonicalImageId,
  extractGallery as extractLiveGallery,
  extractJsonLdBlocks,
  extractNextData,
  formatMinutes,
  isWafChallengeHtml,
  parseIso8601DurationToMinutes,
} from "../crawler/extractors.js";
import { countryName, parseTitleNode, titleNode } from "../crawler/graphql.js";

// ---------------------------------------------------------------------------
// ArchiveClient — BETA Wayback fallback for archived IMDb snapshots.
// Isolated in src/archive/ (see AGENTS.md §5). No edits to src/imdb/* or
// src/crawler/*. Pure HTML parsers are reused as functions on strings;
// network + politeness are owned here. Strictly opt-in + last-resort.
// ---------------------------------------------------------------------------

const ARCHIVE_POLITENESS_MS = 3000;
const ARCHIVE_TIMEOUT_MS = 30_000;
/** CDX metadata lookups are retried this many times (Wayback 503s often). */
const ARCHIVE_CDX_RETRIES = 3;
/** Snapshot fetches per IMDb URL form (newest-first, stop at first rich). */
const ARCHIVE_SNAPSHOTS_PER_URL = 3;
/** How many recent CDX captures to consider per IMDb URL form. */
const ARCHIVE_CDX_CANDIDATES = 8;

let lastArchiveFetchAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function politeWait(): Promise<void> {
  const elapsed = Date.now() - lastArchiveFetchAt;
  if (elapsed < ARCHIVE_POLITENESS_MS) await sleep(ARCHIVE_POLITENESS_MS - elapsed);
}

/** Politeness applies to real archive I/O only. Injected fetch doubles
 * (offline unit tests) skip the wait but keep the retry/ordering logic. */
async function politeWaitLive(live: boolean): Promise<void> {
  if (live) await politeWait();
}

/** Archived IMDb error pages (404 state) must never count as snapshots.
 * Live-verified Oct 2026: Wayback serves IMDb's own 404 page
 * (`<title>404 Error - IMDb</title>`, ~78KB, WITH __NEXT_DATA__ but no title
 * node) for unknown ids like tt9999999. Without this check such pages score
 * >= 0 and their "404 Error" heading would poison the merged record. */
export function isArchiveErrorPage(html: string): boolean {
  // NOTE: generic phrases like "title not found" MUST NOT be used here —
  // IMDb embeds `"common_title_not_found":"Title not found"` in the i18n
  // bundle of every healthy page (false-positive proven live, Oct 2026).
  // Only structural 404 markers count.
  if (/<title>\s*404\s+Error\s*-\s*IMDb\s*<\/title>/i.test(html)) return true;
  if (/<h1[^>]*>\s*404\s+Error/i.test(html)) return true;
  return false;
}

/** Richness score for an archived HTML payload (isolated copy of the idea).
 * Strict by design (live-verified Oct 2026):
 *   2 = embedded title graph present (usable),
 *   0 = title-like JSON-LD only (partial, still usable),
 *  -1 = challenge / miss / error / unparseable (rejected).
 * NEXT_DATA without a title node and ad-hoc big-HTML pages score -1:
 * they are error/edge pages (e.g. IMDb 404 with NEXT_DATA but no title). */
export function scoreArchiveRichness(html: string): number {
  if (!html || html.length < 200) return -1;
  if (isWafChallengeHtml(html)) return -1;
  if (isWaybackMiss(html)) return -1;
  if (isArchiveErrorPage(html)) return -1;
  try {
    const nd = extractNextData(html);
    if (nd) {
      try {
        if (titleNode(nd)) return 2;
      } catch {
        // fall through to reject below
      }
      // NEXT_DATA but no title node: not a title page (404 state,
      // foreign template). Never accept.
      return -1;
    }
  } catch {
    // fall through
  }
  try {
    const blocks = extractJsonLdBlocks(html);
    if (blocks.some(isTitleJsonLd)) return 0;
  } catch {
    // fall through
  }
  return -1;
}

/** True for Movie/TVSeries/TVEpisode blocks with a usable title payload.
 * Generic `WebSite`/`Organization` blocks (e.g. {"name":"IMDb"}) are NOT
 * title data — accepting them poisoned titles with site-chrome strings. */
export function isTitleJsonLd(b: unknown): boolean {
  const o = b as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return false;
  const t = (o as Record<string, unknown>)["@type"];
  const isTitleType = t === "Movie" || t === "TVSeries" || t === "TVEpisode";
  const rec = o as { name?: unknown; description?: unknown; datePublished?: unknown; aggregateRating?: unknown };
  const hasName = typeof rec.name === "string" && rec.name.trim().length > 0;
  if (!hasName) return false;
  if (isTitleType) return true;
  // Untyped but title-shaped (name + story/rating facts).
  return rec.description != null || rec.datePublished != null || rec.aggregateRating != null;
}

export function isWaybackMiss(html: string): boolean {
  return (
    html.includes("Wayback Machine has not archived that URL") ||
    html.includes("No captures found for this URL") ||
    html.includes("The requested URL was not found in the Wayback Machine") ||
    html.includes("will not be archived")
  );
}

/**
 * Extract IMDb-CDN image URLs from archived HTML. Wayback rewrites srcs to
 * /web/<ts>im_/https://m.media-amazon.com/... — the inner IMDb URL is
 * still the source of truth, so scan for the CDN substring directly instead
 * of validating the outer archive host.
 */
export function extractArchiveGallery(html: string, limit = 20): string[] {
  const viaLive = (() => {
    try {
      return extractLiveGallery(html, limit);
    } catch {
      return [] as string[];
    }
  })();
  const out: string[] = [...viaLive];
  // Dedupe by canonical image id (live-verified Oct 2026: the same still
  // appears in several crops, e.g. poster `...@._V1_.jpg` vs gallery
  // `...@._V1_QL75_UX190_CR0,2,190,281_.jpg` — string compare keeps both).
  const seen = new Set<string>(out.map((u) => canonicalImageId(u) ?? (u.split("?")[0] as string)));
  const re = /https?:\/\/[^\s"'<>\\]*?m\.media-amazon\.com\/images\/[^\s"'<>\\]*?\.(?:jpg|jpeg|png|webp)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    let u = (m[0] as string).replace(/\\/g, "");
    // Strip any leading archive prefix that got glued on (im_ rewriting).
    // Accept both schemes: old captures rewrite http:// CDN URLs.
    const innerHttp = u.indexOf("http://m.media-amazon.com");
    const innerHttps = u.indexOf("https://m.media-amazon.com");
    const inner = innerHttps > 0 ? innerHttps : innerHttp > 0 ? innerHttp : -1;
    if (inner > 0) u = u.slice(inner);
    if (u.startsWith("http://")) u = `https://${u.slice("http://".length)}`;
    const base = u.split("?")[0] as string;
    const id = canonicalImageId(base) ?? base;
    if (!seen.has(id) && !/favicon|spinner|transparent|blank/i.test(base)) {
      seen.add(id);
      out.push(base);
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

function unwrapArchiveImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // Prefer the inner IMDb CDN URL when Wayback wrapped it.
  // Old captures rewrite http:// CDN URLs — accept both, normalize to https.
  const inner = url.match(/https?:\/\/m\.media-amazon\.com\/images\/[^"'\\\s]+?\.(?:jpg|jpeg|png|webp)/i);
  if (inner) {
    const hit = inner[0] as string;
    return hit.startsWith("http://") ? `https://${hit.slice("http://".length)}` : hit;
  }
  if (/m\.media-amazon\.com\/images\//i.test(url)) return url;
  return undefined;
}

/** True when a JSON-LD block carries an explicit title @type. */
export function isTitleBlockType(b: unknown): boolean {
  const t = (b as Record<string, unknown> | null)?.["@type"];
  return t === "Movie" || t === "TVSeries" || t === "TVEpisode";
}

/** Isolated kind derivation (mirrors live crawler — archive owns its copy). */
function archiveKindFromGql(p: { isSeries?: boolean; isEpisode?: boolean; titleTypeId?: string }): TitleRecord["kind"] {
  if (p.isEpisode || p.titleTypeId === "tvepisode") return "episode";
  if (p.isSeries || (p.titleTypeId && p.titleTypeId.includes("tvseries")) || p.titleTypeId === "tvminiseries") return "series";
  if (p.titleTypeId === "movie" || p.titleTypeId === "short" || p.titleTypeId === "tvmovie" || p.titleTypeId === "video") return "movie";
  return "unknown";
}

/** Minimal archived-title parse (GQL → JSON-LD → DOM), IMDb-CDN images only. */
export function parseArchiveTitle(html: string): Partial<TitleRecord> {
  const patch: Partial<TitleRecord> = {};
  const nextData = (() => {
    try {
      return extractNextData(html);
    } catch {
      return null;
    }
  })();
  const gNode = nextData ? titleNode(nextData) : null;
  const g = gNode ? parseTitleNode(gNode) : null;
  if (g) {
    if (g.title) patch.title = g.title;
    if (g.originalTitle) patch.originalTitle = g.originalTitle;
    if (g.titleTypeId) patch.titleType = g.titleTypeId;
    const gKind = archiveKindFromGql(g);
    if (gKind !== "unknown") patch.kind = gKind;
    if (typeof g.isAdult === "boolean") patch.isAdult = g.isAdult;
    if (g.akas?.length) patch.akas = g.akas.map((a) => ({ title: a }));
    if (g.year) {
      patch.year = String(g.year);
      patch.date = String(g.year);
    }
    if (g.endYear) patch.endYear = String(g.endYear);
    if (g.releaseDate) {
      patch.releaseDate = g.releaseDate;
      patch.date = g.releaseDate;
    }
    if (g.rating != null) patch.rating = String(g.rating);
    if (g.votes != null) patch.votes = g.votes;
    if (g.topRank != null) patch.top250Rank = g.topRank;
    if (g.metascore != null) patch.metascore = g.metascore;
    if (g.plot) {
      patch.plot = g.plot;
      patch.description = g.plot;
    }
    if (g.genres?.length) patch.genres = g.genres;
    if (g.keywords?.length) patch.keywords = g.keywords;
    if (g.runtimeSeconds) {
      patch.runtimeMinutes = Math.round(g.runtimeSeconds / 60);
      patch.runtime = formatMinutes(patch.runtimeMinutes);
    }
    if (g.certificate) patch.contentRating = g.certificate;
    if (g.budget || g.openingWeekend || g.grossUSA || g.grossWorldwide) {
      patch.boxOffice = {
        budget: g.budget,
        openingWeekend: g.openingWeekend,
        grossUSA: g.grossUSA,
        grossWorldwide: g.grossWorldwide,
      };
    }
    if (g.countryIds?.length) patch.countries = g.countryIds.map(countryName);
    if (g.languages?.length) patch.languages = g.languages;
    if (g.filmingLocations?.length) patch.filmingLocations = g.filmingLocations;
    if (g.companies?.length) patch.productionCompanies = [...new Set(g.companies)].slice(0, 10);
    if (g.awardsSummary) patch.awardsSummary = g.awardsSummary;
    if (g.directors?.length) patch.directors = g.directors.map((d) => d.name);
    if (g.writers?.length) patch.writers = g.writers.map((d) => d.name);
    if (g.creators?.length) patch.creators = g.creators.map((d) => d.name);
    if (g.cast?.length) patch.cast = g.cast.map((c) => ({ name: c.name, imdbId: c.id }));
    const poster = unwrapArchiveImageUrl(g.poster);
    if (poster) {
      patch.poster = poster;
      patch.posterCaption = g.posterCaption ?? null;
    }
    if (g.photoCount != null) patch.photoCount = g.photoCount;
    if (g.videoCount != null) patch.videoCount = g.videoCount;
    if (g.reviewCount != null) patch.reviewCount = g.reviewCount;
    if (g.trailers?.length) patch.trailers = g.trailers;
  }

  // JSON-LD second opinion for gaps. Only title-shaped blocks count:
  // generic site-chrome blocks (WebSite {"name":"IMDb"}) must never become
  // the record title (live-verified poisoning risk, Oct 2026).
  try {
    const blocks = extractJsonLdBlocks(html);
    const ld =
      blocks.find((b) => b && isTitleJsonLd(b) && isTitleBlockType(b)) ??
      blocks.find((b) => b && isTitleJsonLd(b)) ??
      null;
    if (ld) {
      if (!patch.title && ld.name) patch.title = ld.name;
      if ((!patch.plot || !patch.description) && ld.description) {
        patch.plot = ld.description;
        patch.description = ld.description;
      }
      if (!patch.year && ld.datePublished) {
        patch.year = ld.datePublished.slice(0, 4);
        if (!patch.date) patch.date = ld.datePublished;
        if (!patch.releaseDate) patch.releaseDate = ld.datePublished;
      }
      if ((!patch.rating || !patch.votes) && ld.aggregateRating) {
        if (!patch.rating && ld.aggregateRating.ratingValue != null) {
          patch.rating = String(ld.aggregateRating.ratingValue);
        }
        if (!patch.votes && typeof ld.aggregateRating.ratingCount === "number") {
          patch.votes = ld.aggregateRating.ratingCount;
        }
      }
      if ((!patch.genres || !patch.genres.length) && ld.genre) patch.genres = ld.genre;
      if (!patch.contentRating && typeof ld.contentRating === "string") {
        patch.contentRating = ld.contentRating;
      }
      if (!patch.runtimeMinutes && ld.duration) {
        const mins = parseIso8601DurationToMinutes(ld.duration);
        if (mins) {
          patch.runtimeMinutes = mins;
          patch.runtime = formatMinutes(mins);
        }
      }
      if (!patch.poster && typeof ld.image === "string") {
        const p = unwrapArchiveImageUrl(ld.image);
        if (p) patch.poster = p;
      }
    }
  } catch {
    // best effort
  }

  // DOM last resort (stable data-testid / semantic selectors, local copy).
  try {
    const $ = cheerio.load(html);
    const text = (sel: string): string | null => {
      const t = $(sel).first().text().trim().replace(/\s+/g, " ");
      return t || null;
    };
    if (!patch.title) {
      const t =
        text('[data-testid="hero__pageTitle"]') ??
        text('[data-testid="hero-title-block__title"]') ??
        text("h1") ??
        text("title");
      // Never let error chrome become the title (404 pages carry h1/title
      // but no title node — scoreArchiveRichness already rejects them, this
      // is defense in depth for direct merge callers).
      if (t && !/^\s*404\b/i.test(t) && !/error\s*-\s*imdb/i.test(t)) {
        patch.title = t.replace(/\s*\(\d{4}\).*$/, "").trim() || t;
      }
    }
    if (!patch.rating) {
      const r = text('[data-testid="hero-rating-bar__aggregate-rating__score"]');
      if (r) patch.rating = r.split("/")[0]?.trim();
    }
    if (!patch.plot && !patch.description) {
      const p =
        text('[data-testid="plot"]') ??
        text('[data-testid="storyline-plot-summary"]') ??
        text('p[data-testid="plot"]');
      if (p) {
        patch.plot = p;
        patch.description = p;
      }
    }
  } catch {
    // best effort
  }

  return patch;
}

/** Merge an archived snapshot into a partial live record (pure, tested). */
export function mergeArchiveIntoRecord(
  base: TitleRecord,
  html: string,
  archiveUrl: string,
  snapshotTimestamp: string,
): ArchivedTitleRecord {
  const patch = parseArchiveTitle(html);
  const gallery = extractArchiveGallery(html, 20);
  const rec: ArchivedTitleRecord = {
    ...withArchiveFields(base),
    archivedAt: snapshotTimestamp,
    archiveUrl,
  };
  const missing = new Set(rec.missing ?? []);
  const filled = (field: string, value: unknown): boolean => {
    if (value == null) return false;
    if (Array.isArray(value) && !value.length) return false;
    if (typeof value === "string" && !value.trim()) return false;
    return true;
  };
  const take = <K extends keyof TitleRecord>(key: K): void => {
    const v = patch[key];
    const cur = rec[key];
    const curEmpty =
      cur == null || (Array.isArray(cur) && !cur.length) || (typeof cur === "string" && !cur.trim());
    // Live partial records use the bare tt id as a title placeholder when
    // datasets are absent — treat that as empty so the archive can fill it.
    const isPlaceholderTitle =
      key === "title" &&
      typeof cur === "string" &&
      (cur.trim().toLowerCase() === rec.imdbId.toLowerCase() || /^tt\d{7,10}$/i.test(cur.trim()));
    // "unknown" kind is the live placeholder for undetermined media type.
    const isUnknownKind = key === "kind" && cur === "unknown";
    if ((curEmpty || isPlaceholderTitle || isUnknownKind) && filled(key, v)) {
      (rec as unknown as Record<string, unknown>)[key] = v;
      missing.delete(key);
    }
  };
  for (const k of [
    "title",
    "originalTitle",
    "titleType",
    "kind",
    "isAdult",
    "akas",
    "year",
    "date",
    "releaseDate",
    "endYear",
    "rating",
    "votes",
    "metascore",
    "top250Rank",
    "plot",
    "description",
    "genres",
    "keywords",
    "runtime",
    "runtimeMinutes",
    "contentRating",
    "countries",
    "languages",
    "filmingLocations",
    "productionCompanies",
    "boxOffice",
    "awardsSummary",
    "directors",
    "writers",
    "creators",
    "cast",
    "poster",
    "posterCaption",
    "photoCount",
    "videoCount",
    "reviewCount",
    "trailers",
  ] as const) {
    take(k);
  }
  if ((!rec.gallery || !rec.gallery.length) && gallery.length) {
    rec.gallery = gallery.map((url) => ({ url }));
    missing.delete("gallery");
  }
  // Keep poster leading the gallery when possible (compare by canonical
  // image id — poster and stills of the same frame differ in crop params).
  if (rec.poster && gallery.length) {
    const posterId = canonicalImageId(rec.poster) ?? (rec.poster.split("?")[0] as string);
    const hasPoster = gallery.some((g) => (canonicalImageId(g) ?? g) === posterId);
    if (!hasPoster) {
      rec.gallery = [{ url: rec.poster }, ...((rec.gallery ?? []) as { url: string }[])].slice(0, 20);
    }
  }
  missing.delete("page-html (WAF-blocked, partial record from datasets)");
  missing.delete("embedded-graphql");
  for (const m of [...missing]) {
    if (m.includes("page-html") || m === "embedded-graphql") missing.delete(m);
  }
  // Honest audit for fields the title-snapshot path cannot recover.
  // Archive only retries title/reference pages — reviews, guide, tagline
  // subpages and episode enumeration stay missing when still empty.
  const stillMiss = (f: string, empty: boolean): void => {
    if (empty) missing.add(f);
    else missing.delete(f);
  };
  const titlePlaceholder =
    typeof rec.title !== "string" ||
    !rec.title.trim() ||
    rec.title.trim().toLowerCase() === rec.imdbId.toLowerCase() ||
    /^tt\d{7,10}$/i.test(rec.title.trim());
  stillMiss("title", titlePlaceholder);
  stillMiss("rating", rec.rating == null || (typeof rec.rating === "string" && !rec.rating.trim()));
  stillMiss("plot", !rec.plot && !rec.description);
  stillMiss("cast", !rec.cast?.length);
  if (rec.kind === "series") {
    stillMiss("creators", !rec.creators?.length);
  } else if (rec.kind === "movie" || rec.kind === "episode") {
    stillMiss("directors", !rec.directors?.length);
    stillMiss("writers", !rec.writers?.length);
  }
  stillMiss("tagline", !rec.tagline);
  stillMiss("countries", !rec.countries?.length);
  stillMiss("keywords", !rec.keywords?.length);
  stillMiss("kind", rec.kind === "unknown");
  // Subpage lists are only expected when the live crawl requested them
  // (null/[] = requested but unrecovered; undefined = not requested).
  if (rec.reviews !== undefined) stillMiss("reviews", !rec.reviews?.length);
  if (rec.parentsGuide !== undefined) stillMiss("parentsGuide", !rec.parentsGuide?.length);
  if (rec.kind === "series" && rec.episodes !== undefined) {
    stillMiss("episodes", !rec.episodes?.length);
  }
  if (Array.isArray(rec.gallery) && !rec.gallery.length) stillMiss("gallery", true);
  rec.missing = [...missing];
  const prov = `archive:${snapshotTimestamp}:${base.url}`;
  if (!rec.provenance.includes(prov)) rec.provenance = [...rec.provenance, prov];
  if (!rec.provenance.includes(`archive-url:${archiveUrl}`)) {
    rec.provenance = [...rec.provenance, `archive-url:${archiveUrl}`];
  }
  rec.scrapedAt = new Date().toISOString();
  return rec;
}

export interface ArchiveFetchResult {
  html: string;
  archiveUrl: string;
  finalUrl: string;
  snapshotTimestamp: string;
  originalImdbUrl: string;
}

/** Compare snapshot timestamps newest-first (length then lexicographic,
 * so mixed 4–14 digit prefixes order correctly). */
function compareSnapshotDesc(a: string, b: string): number {
  if (a.length !== b.length) return b.length - a.length;
  return a > b ? -1 : a < b ? 1 : 0;
}

/** Newest-first 4–14 digit snapshot timestamps from a CDX JSON payload. */
export function pickRecentCdxTimestamps(json: unknown, limit = ARCHIVE_CDX_CANDIDATES): string[] {
  if (!Array.isArray(json) || json.length < 2) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of json.slice(1)) {
    if (!Array.isArray(row) || !row.length) continue;
    const ts = String(row[0] ?? "").trim();
    if (!/^\d{4,14}$/.test(ts) || seen.has(ts)) continue;
    seen.add(ts);
    out.push(ts);
  }
  out.sort(compareSnapshotDesc);
  return out.slice(0, Math.max(1, Math.min(20, Math.floor(limit) || ARCHIVE_CDX_CANDIDATES)));
}

/** Pick the newest 4–14 digit snapshot timestamp from a CDX JSON payload. */
export function pickLatestCdxTimestamp(json: unknown): string | null {
  return pickRecentCdxTimestamps(json, 1)[0] ?? null;
}

function cdxBackoff(attempt: number, live = true): Promise<void> {
  // 1s, 2s, 4s … + jitter, bounded (Wayback CDX 503s are transient).
  // Injected-fetch (offline-test) retries run without the wait.
  if (!live) return Promise.resolve();
  const ms = Math.min(8000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
  return sleep(ms);
}

/** Sanitize a snapshot timestamp for provenance (redirect tokens → label). */
export function snapshotLabel(ts: string | null | undefined, fallback: string): string {
  if (ts && /^\d{4,14}$/.test(ts)) return ts;
  return /^\d{4,14}$/.test(fallback) ? fallback : "latest";
}

/** Expand title candidates with the m.imdb.com mirror (archive-owned).
 * Live-verified Oct 2026: the www title snapshot is sometimes a WAF
 * interstitial while the m-mirror capture of the same entity is rich
 * (and reference/ snapshots replay empty). Pure, bounded, tested. */
export function expandArchiveCandidates(urls: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: string): void => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  for (const u of urls) push(u);
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      const host = parsed.hostname.toLowerCase();
      if (host === "www.imdb.com") {
        parsed.hostname = "m.imdb.com";
        push(parsed.toString());
      } else if (host === "m.imdb.com") {
        parsed.hostname = "www.imdb.com";
        push(parsed.toString());
      }
    } catch {
      // ignore unparseable candidates
    }
  }
  return out.slice(0, 4);
}

export class ArchiveClient {
  readonly opts: ArchiveOptions;

  constructor(opts: ArchiveOptions) {
    this.opts = { enabled: Boolean(opts.enabled), timestamp: opts.timestamp ?? "latest" };
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** Snapshot URL for an IMDb URL (explicit timestamp; latest → fallback redirect). */
  snapshotUrl(imdbUrl: string): string {
    const ts = this.opts.timestamp === "latest" ? "2" : this.opts.timestamp;
    return buildArchiveUrl(imdbUrl, ts);
  }

  /**
   * Auto-resolve recent snapshot timestamps (newest-first) for the exact
   * IMDb URL via the Wayback CDX lookup (same host, metadata only). Retries
   * transient CDX failures (503s are common). Returns [] when no usable
   * capture exists. Pure fetch is injectable for offline tests.
   */
  async resolveRecentTimestamps(
    imdbUrl: string,
    fetchImpl: typeof fetch = fetch,
    count: number = ARCHIVE_CDX_CANDIDATES,
  ): Promise<string[]> {
    if (!this.opts.enabled) return [];
    let cdxUrl: string;
    try {
      cdxUrl = buildArchiveCdxUrl(imdbUrl, count);
    } catch {
      return [];
    }
    const useGuarded = fetchImpl === fetch;
    for (let attempt = 0; attempt < ARCHIVE_CDX_RETRIES; attempt++) {
      await politeWaitLive(useGuarded);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ARCHIVE_TIMEOUT_MS);
      try {
        const res = useGuarded
          ? await archiveCdxFetch(cdxUrl, { headers: archiveHtmlHeaders(), signal: ctrl.signal })
          : await fetchImpl(cdxUrl, { headers: archiveHtmlHeaders(), signal: ctrl.signal });
        lastArchiveFetchAt = Date.now();
        if (!res.ok) {
          // Transient (503/429/500): retry with backoff; permanent: stop.
          if ((res.status === 503 || res.status === 429 || (res.status >= 500 && res.status < 600)) && attempt + 1 < ARCHIVE_CDX_RETRIES) {
            logger.warn(`Archive BETA CDX retry for ${imdbUrl}: HTTP ${res.status} (attempt ${attempt + 1})`);
            clearTimeout(t);
            await cdxBackoff(attempt, useGuarded);
            continue;
          }
          logger.warn(`Archive BETA miss for ${imdbUrl}: CDX HTTP ${res.status}`);
          return [];
        }
        const json = (await res.json()) as unknown;
        const list = pickRecentCdxTimestamps(json, count);
        if (list.length) {
          logger.warn(`Archive BETA resolved ${list.length} snapshot(s) for ${imdbUrl}: newest ${list[0] as string}`);
        } else {
          logger.warn(`Archive BETA miss for ${imdbUrl}: CDX has no captures`);
        }
        return list;
      } catch (e) {
        lastArchiveFetchAt = Date.now();
        if (attempt + 1 < ARCHIVE_CDX_RETRIES) {
          logger.warn(`Archive BETA CDX retry for ${imdbUrl}: ${(e as Error).message} (attempt ${attempt + 1})`);
          clearTimeout(t);
          await cdxBackoff(attempt, useGuarded);
          continue;
        }
        logger.warn(`Archive BETA miss for ${imdbUrl}: CDX lookup failed (${(e as Error).message})`);
        return [];
      } finally {
        clearTimeout(t);
      }
    }
    return [];
  }

  /**
   * Auto-resolve the newest available snapshot timestamp for the exact IMDb
   * URL via the Wayback CDX lookup (same host, metadata only). Returns null
   * when no usable capture exists. Pure fetch is injectable for offline tests.
   */
  async resolveLatestTimestamp(
    imdbUrl: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<string | null> {
    return (await this.resolveRecentTimestamps(imdbUrl, fetchImpl, 5))[0] ?? null;
  }

  /**
   * Snapshot URL with automatic latest-resolution: explicit timestamps build
   * directly; "latest" queries CDX first and falls back to the Wayback "2id_"
   * redirect when CDX is unreachable or empty.
   */
  async resolveSnapshotUrl(
    imdbUrl: string,
    fetchImpl?: typeof fetch,
  ): Promise<string> {
    if (this.opts.timestamp !== "latest") return buildArchiveUrl(imdbUrl, this.opts.timestamp);
    const ts = await this.resolveLatestTimestamp(imdbUrl, fetchImpl ?? fetch);
    if (ts) return buildArchiveUrl(imdbUrl, ts);
    return this.snapshotUrl(imdbUrl);
  }

  /** Fetch one snapshot URL (single attempt, polite, guarded). */
  private async fetchSingleSnapshot(
    imdbUrl: string,
    archiveUrl: string,
    fetchImpl?: typeof fetch,
  ): Promise<ArchiveFetchResult | null> {
    assertArchiveUrl(archiveUrl);
    await politeWaitLive(!fetchImpl || fetchImpl === fetch);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ARCHIVE_TIMEOUT_MS);
    try {
      const res = fetchImpl && fetchImpl !== fetch
        ? await fetchImpl(archiveUrl, {
            headers: archiveHtmlHeaders(),
            signal: ctrl.signal,
            redirect: "follow",
          })
        : await archiveFetch(archiveUrl, {
            headers: archiveHtmlHeaders(),
            signal: ctrl.signal,
            redirect: "follow",
          });
      lastArchiveFetchAt = Date.now();
      const finalUrl = res.url || archiveUrl;
      const text = await res.text();
      if (!res.ok) {
        logger.warn(`Archive BETA miss for ${imdbUrl}: HTTP ${res.status} at ${finalUrl}`);
        return null;
      }
      if (!text || text.length < 500) {
        logger.warn(`Archive BETA miss for ${imdbUrl}: empty/throttled payload (HTTP ${res.status}, ${text?.length ?? 0}B) at ${finalUrl}`);
        return null;
      }
      if (isWaybackMiss(text) || isWafChallengeHtml(text) || isArchiveErrorPage(text)) {
        const kind = isWaybackMiss(text) ? "unarchived" : isWafChallengeHtml(text) ? "WAF-challenge" : "IMDb-error";
        logger.warn(`Archive BETA miss for ${imdbUrl}: ${kind} payload at ${finalUrl}`);
        return null;
      }
      // Richness gate: never hand error/challenge/chrome pages to the merge
      // (live Oct 2026: newest capture is often a WAF interstitial, and
      // unknown-id captures replay IMDb's 404 page with HTTP 200).
      if (scoreArchiveRichness(text) < 0) {
        logger.warn(`Archive BETA miss for ${imdbUrl}: thin snapshot at ${finalUrl} (no title data)`);
        return null;
      }
      const ts = snapshotLabel(
        extractArchiveTimestamp(finalUrl),
        this.opts.timestamp === "latest" ? "latest" : this.opts.timestamp,
      );
      return { html: text, archiveUrl, finalUrl, snapshotTimestamp: ts, originalImdbUrl: imdbUrl };
    } catch (e) {
      lastArchiveFetchAt = Date.now();
      logger.warn(`Archive BETA miss for ${imdbUrl}: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  async fetchSnapshot(
    imdbUrl: string,
    fetchImpl?: typeof fetch,
    cdxFetchImpl?: typeof fetch,
  ): Promise<ArchiveFetchResult | null> {
    if (!this.opts.enabled) return null;
    // Explicit timestamp: single bounded attempt (unchanged semantics).
    if (this.opts.timestamp !== "latest") {
      return this.fetchSingleSnapshot(imdbUrl, this.snapshotUrl(imdbUrl), fetchImpl);
    }
    // Latest: walk recent CDX captures newest-first (skips WAF-challenge
    // captures — live Oct 2026 the newest capture is often the challenge
    // interstitial while an older one is rich). Bounded attempts.
    let timestamps: string[] = [];
    try {
      timestamps = await this.resolveRecentTimestamps(imdbUrl, cdxFetchImpl ?? fetchImpl ?? fetch, ARCHIVE_CDX_CANDIDATES);
    } catch {
      timestamps = [];
    }
    // CDX empty/unreachable: ONE redirect attempt (legacy fallback).
    if (!timestamps.length) {
      return this.fetchSingleSnapshot(imdbUrl, this.snapshotUrl(imdbUrl), fetchImpl);
    }
    const hits: ArchiveFetchResult[] = [];
    for (const ts of timestamps.slice(0, ARCHIVE_SNAPSHOTS_PER_URL)) {
      let snap: string;
      try {
        snap = buildArchiveUrl(imdbUrl, ts);
      } catch {
        continue;
      }
      const r = await this.fetchSingleSnapshot(imdbUrl, snap, fetchImpl);
      if (r) {
        hits.push(r);
        // A full title graph wins immediately; partial (JSON-LD only)
        // keeps trying older captures while the budget lasts.
        if (scoreArchiveRichness(r.html) >= 2) break;
      }
    }
    if (!hits.length) {
      logger.warn(`Archive BETA miss for ${imdbUrl}: no rich snapshot among recent captures`);
      return null;
    }
    // Richest first, newest timestamp breaks ties.
    hits.sort((a, b) =>
      scoreArchiveRichness(b.html) - scoreArchiveRichness(a.html) ||
      (a.snapshotTimestamp < b.snapshotTimestamp ? 1 : -1),
    );
    return hits[0] as ArchiveFetchResult;
  }

  /**
   * Last-resort enhancement: only runs when enabled AND the live record
   * still misses page-html. Tries title/reference forms plus the m.imdb.com
   * mirror via archive, keeps the richest payload (bounded attempts).
   */
  async enhance(
    base: TitleRecord,
    candidateImdbUrls: string[],
    fetchFn?: (imdbUrl: string) => Promise<ArchiveFetchResult | null>,
  ): Promise<TitleRecord> {
    if (!this.opts.enabled) return base;
    if (!needsArchiveFallback(base)) return base;
    const runFetch = fetchFn ?? ((u: string) => this.fetchSnapshot(u));
    let best: ArchiveFetchResult | null = null;
    let bestScore = -1;
    for (const imdbUrl of expandArchiveCandidates(candidateImdbUrls).slice(0, 4)) {
      let r: ArchiveFetchResult | null = null;
      try {
        r = await runFetch(imdbUrl);
      } catch (e) {
        logger.warn(`Archive BETA miss for ${base.imdbId}: ${(e as Error).message}`);
        continue;
      }
      if (!r) continue;
      const s = scoreArchiveRichness(r.html);
      if (s > bestScore) {
        bestScore = s;
        best = r;
      }
      if (s >= 2) break;
    }
    if (!best || bestScore < 0) {
      logger.warn(`Archive BETA miss for ${base.imdbId}: no usable snapshot`);
      return base;
    }
    logger.warn(
      `Archive BETA fallback for ${base.imdbId}: ${best.finalUrl} (snapshot ${best.snapshotTimestamp})`,
    );
    try {
      return mergeArchiveIntoRecord(base, best.html, best.finalUrl, best.snapshotTimestamp);
    } catch (e) {
      logger.warn(`Archive BETA miss for ${base.imdbId}: merge failed (${(e as Error).message})`);
      return base;
    }
  }
}

/** Convenience: archive-enhance a partial record with default candidates. */
export async function enhanceWithArchiveBeta(
  base: TitleRecord,
  archiveOpts: ArchiveOptions,
  candidateImdbUrls?: string[],
  fetchFn?: (imdbUrl: string) => Promise<ArchiveFetchResult | null>,
): Promise<TitleRecord> {
  const client = new ArchiveClient(archiveOpts);
  const candidates = candidateImdbUrls?.length ? candidateImdbUrls : [base.url];
  return client.enhance(base, candidates, fetchFn);
}

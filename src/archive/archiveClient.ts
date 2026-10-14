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

let lastArchiveFetchAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function politeWait(): Promise<void> {
  const elapsed = Date.now() - lastArchiveFetchAt;
  if (elapsed < ARCHIVE_POLITENESS_MS) await sleep(ARCHIVE_POLITENESS_MS - elapsed);
}

/** Richness score for an archived HTML payload (isolated copy of the idea). */
export function scoreArchiveRichness(html: string): number {
  if (!html || html.length < 200) return -1;
  if (isWafChallengeHtml(html)) return -1;
  if (isWaybackMiss(html)) return -1;
  try {
    const nd = extractNextData(html);
    if (nd) {
      try {
        if (titleNode(nd)) return 2;
      } catch {
        // fall through
      }
      return 1;
    }
  } catch {
    // fall through
  }
  if (html.includes("application/ld+json")) return 0;
  return html.length > 1000 ? 0 : -1;
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
  const seen = new Set<string>(out.map((u) => u.split("?")[0] as string));
  const re = /https?:\/\/[^\s"'<>\\]*?m\.media-amazon\.com\/images\/[^\s"'<>\\]*?\.(?:jpg|jpeg|png|webp)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    let u = (m[0] as string).replace(/\\/g, "");
    // Strip any leading archive prefix that got glued on (im_ rewriting).
    const inner = u.indexOf("https://m.media-amazon.com");
    if (inner > 0) u = u.slice(inner);
    const base = u.split("?")[0] as string;
    if (!seen.has(base) && !/favicon|spinner|transparent|blank/i.test(base)) {
      seen.add(base);
      out.push(base);
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

function unwrapArchiveImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // Prefer the inner IMDb CDN URL when Wayback wrapped it.
  const inner = url.match(/https:\/\/m\.media-amazon\.com\/images\/[^"'\\\s]+?\.(?:jpg|jpeg|png|webp)/i);
  if (inner) return inner[0];
  if (/m\.media-amazon\.com\/images\//i.test(url)) return url;
  return undefined;
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

  // JSON-LD second opinion for gaps.
  try {
    const blocks = extractJsonLdBlocks(html);
    const ld = blocks.find((b) => b) ?? null;
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
        text('h1[data-testid="hero__primary-text"]') ?? text("h1") ?? text("title");
      if (t) patch.title = t.replace(/\s*\(\d{4}\).*$/, "").trim() || t;
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
    if ((curEmpty || isPlaceholderTitle) && filled(key, v)) {
      (rec as unknown as Record<string, unknown>)[key] = v;
      missing.delete(key);
    }
  };
  for (const k of [
    "title",
    "originalTitle",
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
    "boxOffice",
    "awardsSummary",
    "directors",
    "writers",
    "creators",
    "cast",
    "poster",
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
  if (rec.poster && gallery.length && !gallery.includes(rec.poster.split("?")[0] as string)) {
    // Keep poster leading the gallery when possible.
    rec.gallery = [{ url: rec.poster }, ...((rec.gallery ?? []) as { url: string }[])].slice(0, 20);
  }
  missing.delete("page-html (WAF-blocked, partial record from datasets)");
  missing.delete("embedded-graphql");
  for (const m of [...missing]) {
    if (m.includes("page-html") || m === "embedded-graphql") missing.delete(m);
  }
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

/** Pick the newest 4–14 digit snapshot timestamp from a CDX JSON payload. */
export function pickLatestCdxTimestamp(json: unknown): string | null {
  if (!Array.isArray(json) || json.length < 2) return null;
  let best: string | null = null;
  for (const row of json.slice(1)) {
    if (!Array.isArray(row) || !row.length) continue;
    const ts = String(row[0] ?? "").trim();
    if (!/^\d{4,14}$/.test(ts)) continue;
    if (best == null || ts > best) best = ts;
  }
  return best;
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
   * Auto-resolve the newest available snapshot timestamp for the exact IMDb
   * URL via the Wayback CDX lookup (same host, metadata only). Returns null
   * when no usable capture exists. Pure fetch is injectable for offline tests.
   */
  async resolveLatestTimestamp(
    imdbUrl: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<string | null> {
    if (!this.opts.enabled) return null;
    let cdxUrl: string;
    try {
      cdxUrl = buildArchiveCdxUrl(imdbUrl, 5);
    } catch {
      return null;
    }
    await politeWait();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ARCHIVE_TIMEOUT_MS);
    try {
      const res = await (fetchImpl === fetch
        ? archiveCdxFetch(cdxUrl, { headers: archiveHtmlHeaders(), signal: ctrl.signal })
        : fetchImpl(cdxUrl, { headers: archiveHtmlHeaders(), signal: ctrl.signal }));
      lastArchiveFetchAt = Date.now();
      if (!res.ok) {
        logger.warn(`Archive BETA miss for ${imdbUrl}: CDX HTTP ${res.status}`);
        return null;
      }
      const json = (await res.json()) as unknown;
      const ts = pickLatestCdxTimestamp(json);
      if (ts) {
        logger.warn(`Archive BETA resolved latest snapshot for ${imdbUrl}: ${ts}`);
      } else {
        logger.warn(`Archive BETA miss for ${imdbUrl}: CDX has no captures`);
      }
      return ts;
    } catch (e) {
      lastArchiveFetchAt = Date.now();
      logger.warn(`Archive BETA miss for ${imdbUrl}: CDX lookup failed (${(e as Error).message})`);
      return null;
    } finally {
      clearTimeout(t);
    }
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

  async fetchSnapshot(
    imdbUrl: string,
    fetchImpl?: typeof fetch,
    cdxFetchImpl?: typeof fetch,
  ): Promise<ArchiveFetchResult | null> {
    if (!this.opts.enabled) return null;
    // Auto-find newest snapshot when timestamp=latest (CDX first, redirect fallback).
    const archiveUrl = this.opts.timestamp === "latest"
      ? await this.resolveSnapshotUrl(imdbUrl, cdxFetchImpl ?? fetchImpl ?? fetch)
      : this.snapshotUrl(imdbUrl);
    assertArchiveUrl(archiveUrl);
    await politeWait();
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
      if (!text || text.length < 500 || isWaybackMiss(text) || isWafChallengeHtml(text)) {
        logger.warn(`Archive BETA miss for ${imdbUrl}: empty/unarchived payload at ${finalUrl}`);
        return null;
      }
      const ts = extractArchiveTimestamp(finalUrl) ?? (this.opts.timestamp === "latest" ? "latest" : this.opts.timestamp);
      return { html: text, archiveUrl, finalUrl, snapshotTimestamp: ts, originalImdbUrl: imdbUrl };
    } catch (e) {
      lastArchiveFetchAt = Date.now();
      logger.warn(`Archive BETA miss for ${imdbUrl}: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Last-resort enhancement: only runs when enabled AND the live record
   * still misses page-html. Tries title + reference URL forms via archive,
   * keeps the richest payload (ONE bounded attempt per form).
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
    for (const imdbUrl of candidateImdbUrls.slice(0, 4)) {
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

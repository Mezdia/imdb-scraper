import * as cheerio from "cheerio";
import { episodesUrl, parentalGuideUrl, referenceUrl, reviewsUrl, titleUrl } from "../imdb/ids.js";
import type { CrawlOptions, EpisodeRef, TitleRecord } from "../imdb/types.js";
import { BrowserEngine, fetchImdbHtml } from "./engine.js";
import {
  extractCastFallback,
  extractEpisodeIds,
  extractJsonLdBlocks,
  extractNextData,
  extractParentalGuideFallback,
  extractReviewsFallback,
  formatMinutes,
  isWafChallengeHtml,
  parseIso8601DurationToMinutes,
  textOf,
} from "./extractors.js";
import { SELECTORS } from "../imdb/selectors.js";
import { readCachedDataset } from "../imdb/datasets.js";
import { searchTitles } from "../imdb/suggestion.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Title crawler: datasets -> suggestion -> HTTP -> browser, all IMDb-only.
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function detectKind(nextData: Record<string, unknown> | null, ldType?: string, titleType?: string): TitleRecord["kind"] {
  const hay = JSON.stringify(nextData ?? {}).toLowerCase();
  if (ldType === "tvepisode" || titleType === "tvepisode") return "episode";
  if (ldType === "tvseries" || titleType === "tvseries" || titleType === "tvminiseries" || hay.includes('"titleType":{"id":"tvseries"')) return "series";
  if (hay.includes("tvseries") && hay.includes("episode")) return "series";
  if (titleType === "movie" || ldType === "movie") return "movie";
  return "unknown";
}

function ldToRecord(imdbId: string, url: string, html: string): Partial<TitleRecord> & { missing: string[] } {
  const missing: string[] = [];
  const blocks = extractJsonLdBlocks(html);
  const ld = blocks[0];
  const $ = cheerio.load(html);
  const nextData = extractNextData(html);

  const out: Partial<TitleRecord> & { missing: string[] } = { missing };

  if (ld) {
    out.title = ld.name;
    out.description = ld.description ?? undefined;
    out.plot = ld.description ?? undefined;
    out.date = ld.datePublished ?? undefined;
    out.year = ld.datePublished?.slice(0, 4) ?? undefined;
    if (ld.aggregateRating) {
      out.rating = String(ld.aggregateRating.ratingValue ?? "");
      out.votes = typeof ld.aggregateRating.ratingCount === "number" ? ld.aggregateRating.ratingCount : undefined;
    }
    if (ld.genre) out.genres = ld.genre;
    const mins = ld.duration ? parseIso8601DurationToMinutes(ld.duration) : null;
    out.runtimeMinutes = mins;
    out.runtime = formatMinutes(mins) ?? undefined;
    if (Array.isArray(ld.actor)) {
      out.cast = ld.actor.slice(0, 20).map((a) => ({
        name: a.name ?? "Unknown",
        imdbId: a.url ? (a.url.match(/(nm\d+)/i)?.[1]?.toLowerCase() ?? undefined) : undefined,
      }));
    }
    const dirs = ld.director ? (Array.isArray(ld.director) ? ld.director : [ld.director]) : [];
    if (dirs.length) out.directors = dirs.map((d) => d.name ?? "").filter(Boolean);
    if (ld.image && typeof ld.image === "string") out.poster = ld.image;
  }

  // DOM fallbacks for anything JSON-LD missed.
  if (!out.title) {
    const t = textOf($, SELECTORS.title);
    if (t) out.title = t;
    else missing.push("title");
  }
  if (!out.rating) {
    const r = textOf($, SELECTORS.rating);
    if (r) out.rating = r.split("/")[0]?.trim();
    else missing.push("rating");
  }
  if (!out.plot && !out.description) {
    const p = textOf($, SELECTORS.plot);
    if (p) {
      out.plot = p;
      out.description = p;
    } else missing.push("plot");
  }
  if (!out.genres?.length) {
    const g = $(SELECTORS.genres.join(",")).toArray().map((el) => $(el).text().trim()).filter(Boolean);
    if (g.length) out.genres = [...new Set(g)].slice(0, 8);
  }
  if (!out.cast?.length) {
    const c = extractCastFallback(html);
    if (c.length) out.cast = c;
    else missing.push("cast");
  }
  const kind = detectKind(nextData, (blocks[0] as Record<string, string> | undefined)?.["@type"] as string | undefined);
  out.kind = kind;
  return out;
}

async function loadTitleHtml(imdbId: string, engine: BrowserEngine | null, provenance: string[]): Promise<{ html: string; via: string } | null> {
  const urls = [titleUrl(imdbId), referenceUrl(imdbId)];
  for (const u of urls) {
    const http = await fetchImdbHtml(u);
    if (http && !isWafChallengeHtml(http)) {
      provenance.push(`http:${u}`);
      return { html: http, via: "http" };
    }
    logger.warn(`HTTP path failed, trying browser engine for ${u}`);
  }
  if (engine) {
    for (const u of urls) {
      try {
        const snap = await engine.goto(u);
        if (!snap.wafChallenge && snap.html.length > 1000) {
          provenance.push(`browser:${u}`);
          return { html: snap.html, via: "browser" };
        }
        logger.warn(`Browser still challenged for ${u}`);
      } catch (e) {
        logger.warn(`Browser failed for ${u}: ${(e as Error).message}`);
      }
    }
  }
  return null;
}

async function loadAuxHtml(imdbId: string, kind: "reviews" | "pg" | "episodes", engine: BrowserEngine | null): Promise<string | null> {
  const u = kind === "reviews" ? reviewsUrl(imdbId) : kind === "pg" ? parentalGuideUrl(imdbId) : episodesUrl(imdbId);
  const http = await fetchImdbHtml(u).catch(() => null);
  if (http) return http;
  if (engine) {
    try {
      const snap = await engine.goto(u);
      if (!snap.wafChallenge) return snap.html;
    } catch {
      return null;
    }
  }
  return null;
}

export function suggestionKindToMediaKind(q: string): TitleRecord["kind"] {
  const s = q.toLowerCase();
  if (s.includes("tvseries") || s.includes("tv series") || s === "tvseries" || s.includes("series")) return "series";
  if (s.includes("tvepisode") || s.includes("episode")) return "episode";
  if (s.includes("feature") || s.includes("movie") || s.includes("tvmovie") || s.includes("tv movie") || s.includes("video") || s.includes("short")) return "movie";
  return "unknown";
}

export async function crawlTitle(
  imdbId: string,
  opts: CrawlOptions,
  engine: BrowserEngine | null,
): Promise<TitleRecord> {
  const id = imdbId.toLowerCase();
  const url = titleUrl(id);
  const provenance: string[] = [];
  const missing: string[] = [];

  // --- Layer 1: official datasets (WAF-free) enrich base facts ------------
  let dsTitle: string | undefined;
  let dsYear: string | undefined;
  let dsRuntime: number | null = null;
  let dsGenres: string[] | undefined;
  let dsKind: TitleRecord["kind"] | undefined;
  const basics = readCachedDataset("title.basics.tsv.gz");
  if (basics) {
    provenance.push("datasets:title.basics");
    for (const line of basics.split("\n").slice(1)) {
      if (line.startsWith(id + "\t")) {
        const c = line.split("\t");
        const ttype = c[1] ?? "";
        dsTitle = c[2] || undefined;
        dsYear = c[5] && c[5] !== "\\N" ? c[5] : undefined;
        dsRuntime = c[7] && c[7] !== "\\N" ? Number(c[7]) : null;
        dsGenres = c[8] && c[8] !== "\\N" ? c[8].split(",") : undefined;
        dsKind = ttype.includes("tvSeries") || ttype.includes("tvMiniSeries") ? "series" : ttype === "tvEpisode" ? "episode" : ttype === "movie" ? "movie" : undefined;
        break;
      }
    }
  }
  let dsRating: string | undefined;
  let dsVotes: number | undefined;
  const ratings = readCachedDataset("title.ratings.tsv.gz");
  if (ratings) {
    for (const line of ratings.split("\n").slice(1)) {
      if (line.startsWith(id + "\t")) {
        const c = line.split("\t");
        dsRating = c[1] && c[1] !== "\\N" ? c[1] : undefined;
        dsVotes = c[2] && c[2] !== "\\N" ? Number(c[2]) : undefined;
        provenance.push("datasets:title.ratings");
        break;
      }
    }
  }

  // --- Layer 2: page HTML (HTTP -> browser with WAF solving) ---------------
  const loaded = await loadTitleHtml(id, engine, provenance);
  const base: TitleRecord = {
    imdbId: id,
    url,
    title: dsTitle ?? id,
    kind: dsKind ?? "unknown",
    year: dsYear ?? null,
    date: dsYear ?? null,
    rating: dsRating ?? null,
    votes: dsVotes ?? null,
    description: null,
    plot: null,
    runtime: dsRuntime ? (formatMinutes(dsRuntime) ?? null) : null,
    runtimeMinutes: dsRuntime,
    genres: dsGenres,
    directors: undefined,
    writers: undefined,
    cast: undefined,
    poster: null,
    parentsGuide: opts.includeParentsGuide ? null : undefined,
    reviews: opts.includeReviews ? null : undefined,
    episodes: opts.includeEpisodes ? null : undefined,
    episodeCount: null,
    missing,
    scrapedAt: nowIso(),
    provenance,
  };

  if (!loaded) {
    // --- Layer 3: suggestion API as last IMDb-only resort ------------------
    try {
      const sug = await searchTitles(id, 3);
      const hit = sug.find((s) => s.id.toLowerCase() === id);
      if (hit) {
        base.title = hit.label || base.title;
        base.poster = hit.poster ?? base.poster;
        if (hit.year) {
          base.year = String(hit.year);
          if (!base.date) base.date = String(hit.year);
        }
        if (base.kind === "unknown") base.kind = suggestionKindToMediaKind(hit.kind);
        provenance.push("suggestion:v3.sg.media-imdb.com");
      }
    } catch (e) {
      logger.warn(`Suggestion fallback failed for ${id}: ${(e as Error).message}`);
    }
    missing.push("page-html (WAF-blocked, partial record from datasets)");
    base.missing = [...new Set(missing)];
    return base;
  }

  const partial = ldToRecord(id, url, loaded.html);
  const rec: TitleRecord = {
    ...base,
    title: partial.title ?? base.title,
    kind: partial.kind && partial.kind !== "unknown" ? partial.kind : base.kind,
    year: partial.year ?? base.year,
    date: partial.year ?? base.date,
    rating: partial.rating ?? base.rating,
    votes: partial.votes ?? base.votes,
    description: partial.description ?? base.description,
    plot: partial.plot ?? base.plot,
    runtime: partial.runtime ?? base.runtime,
    runtimeMinutes: partial.runtimeMinutes ?? base.runtimeMinutes,
    genres: partial.genres ?? base.genres,
    directors: partial.directors,
    cast: partial.cast,
    poster: partial.poster ?? base.poster,
  };
  for (const m of partial.missing) if (!missing.includes(m)) missing.push(m);

  // --- Reviews / Parental guide / Episodes ---------------------------------
  if (opts.includeReviews) {
    const html = await loadAuxHtml(id, "reviews", engine);
    if (html) {
      const revs = extractReviewsFallback(html, opts.deepReviews ? 100 : 25);
      rec.reviews = revs;
      provenance.push("page:reviews");
      if (!revs.length) missing.push("reviews");
    } else {
      missing.push("reviews");
      rec.reviews = [];
    }
  }
  if (opts.includeParentsGuide) {
    const html = await loadAuxHtml(id, "pg", engine);
    if (html) {
      const pg = extractParentalGuideFallback(html);
      rec.parentsGuide = pg;
      provenance.push("page:parentalguide");
      if (!pg.length) missing.push("parentsGuide");
    } else {
      missing.push("parentsGuide");
      rec.parentsGuide = [];
    }
  }
  if (opts.includeEpisodes && (rec.kind === "series" || opts.engine === "browser")) {
    const epTsv = readCachedDataset("title.episode.tsv.gz");
    const eps: EpisodeRef[] = [];
    if (epTsv) {
      provenance.push("datasets:title.episode");
      for (const line of epTsv.split("\n").slice(1)) {
        const c = line.split("\t");
        if (c[1] === id) {
          eps.push({
            imdbId: c[0] as string,
            season: c[2] !== "\\N" ? Number(c[2]) : null,
            episode: c[3] !== "\\N" ? Number(c[3]) : null,
          });
          if (eps.length >= opts.maxEpisodes) break;
        }
      }
    }
    if (!eps.length) {
      const html = await loadAuxHtml(id, "episodes", engine);
      if (html) {
        for (const eid of extractEpisodeIds(html, opts.maxEpisodes)) eps.push({ imdbId: eid });
        provenance.push("page:episodes");
      }
    }
    // Enrich episode titles from suggestion API (WAF-free, IMDb-only).
    rec.episodes = eps.slice(0, opts.maxEpisodes);
    rec.episodeCount = rec.episodes.length || null;
    if (!rec.episodes.length) missing.push("episodes");
  }

  rec.missing = [...new Set(missing)];
  rec.provenance = provenance;
  rec.scrapedAt = nowIso();
  return rec;
}

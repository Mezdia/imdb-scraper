import * as cheerio from "cheerio";
import {
  episodesUrl,
  fullCreditsUrl,
  parentalGuideUrl,
  photosUrl,
  referenceUrl,
  reviewsUrl,
  titleUrl,
} from "../imdb/ids.js";
import type { CrawlOptions, EpisodeRef, TitleRecord } from "../imdb/types.js";
import { BrowserEngine, fetchImdbHtml } from "./engine.js";
import {
  collectByKey,
  extractCastFallback,
  extractCreditsDetailed,
  extractDetailsFallback,
  extractEmbeddedFacts,
  extractEpisodeIds,
  extractGallery,
  extractJsonLdBlocks,
  extractKeywords,
  extractNextData,
  extractParentalGuideRich,
  extractReviewsRich,
  formatMinutes,
  isWafChallengeHtml,
  normalizeAkas,
  parseIso8601DurationToMinutes,
  textOf,
} from "./extractors.js";
import { SELECTORS } from "../imdb/selectors.js";
import {
  akasForTitle,
  basicsForTitle,
  episodesForSeries,
  ratingsForTitle,
  readCachedDataset,
} from "../imdb/datasets.js";
import { searchTitles } from "../imdb/suggestion.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Title crawler: datasets -> suggestion -> HTTP -> browser, all IMDb-only.
// Field groups: A identity, B dates/origin, C ratings, D story, E production,
// F money, G people, H gallery, I guidance/reviews, J series.
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function nn(v: string | undefined): string | undefined {
  return v && v !== "\\N" && v.trim() ? v : undefined;
}

function detectKind(nextData: Record<string, unknown> | null, ldType?: string, titleType?: string): TitleRecord["kind"] {
  const hay = JSON.stringify(nextData ?? {}).toLowerCase();
  if (ldType === "tvepisode" || titleType === "tvepisode") return "episode";
  if (ldType === "tvseries" || titleType === "tvseries" || titleType === "tvminiseries" || hay.includes('"titleType":{"id":"tvseries"')) return "series";
  if (hay.includes("tvseries") && hay.includes("episode")) return "series";
  if (titleType === "movie" || ldType === "movie") return "movie";
  return "unknown";
}

function detectKindFromBasics(titleType: string | undefined): TitleRecord["kind"] | undefined {
  if (!titleType) return undefined;
  const t = titleType.toLowerCase();
  if (t.includes("tvseries") || t.includes("tvminiseries")) return "series";
  if (t === "tvepisode") return "episode";
  if (t === "movie" || t === "short" || t === "tvmovie" || t === "video") return "movie";
  return undefined;
}

function ldToRecord(html: string): Partial<TitleRecord> & { missing: string[] } {
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
    out.releaseDate = ld.datePublished ?? undefined;
    if (ld.aggregateRating) {
      const rv = ld.aggregateRating.ratingValue;
      out.rating = rv != null && String(rv) ? String(rv) : undefined;
      out.votes = typeof ld.aggregateRating.ratingCount === "number" ? ld.aggregateRating.ratingCount : undefined;
    }
    if (ld.genre) out.genres = ld.genre;
    if (typeof ld.keywords === "string" && ld.keywords.trim()) {
      out.keywords = ld.keywords.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean).slice(0, 30);
    }
    if (typeof ld.contentRating === "string") out.contentRating = ld.contentRating;
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
    const creators = ld.creator ? (Array.isArray(ld.creator) ? ld.creator : [ld.creator]) : [];
    if (creators.length) out.creators = creators.map((d) => d.name ?? "").filter(Boolean);
    if (ld.image && typeof ld.image === "string") out.poster = ld.image;
  }

  // Embedded __NEXT_DATA__ deep-scan (B/C/D/E/F facts).
  if (nextData) {
    const facts = extractEmbeddedFacts(nextData);
    if (facts.budget || facts.openingWeekend || facts.grossUSA || facts.grossWorldwide) {
      out.boxOffice = {
        budget: facts.budget,
        openingWeekend: facts.openingWeekend,
        grossUSA: facts.grossUSA,
        grossWorldwide: facts.grossWorldwide,
      };
    }
    if (facts.metascore != null) out.metascore = facts.metascore;
    if (facts.top250Rank != null) out.top250Rank = Math.round(facts.top250Rank);
    if (facts.releaseDate && !out.releaseDate) {
      out.releaseDate = facts.releaseDate;
      if (!out.date) out.date = facts.releaseDate;
      if (!out.year) out.year = facts.releaseDate.slice(0, 4);
    }
    if (facts.countries) out.countries = facts.countries;
    if (facts.languages) out.languages = facts.languages;
    if (facts.filmingLocations) out.filmingLocations = facts.filmingLocations;
    if (facts.productionCompanies) out.productionCompanies = facts.productionCompanies;
    if (facts.tagline && !out.tagline) out.tagline = facts.tagline;
    if (facts.awardsSummary) out.awardsSummary = facts.awardsSummary;
    // Series season count often hides under keys like numberOfSeasons/totalSeasons.
    const seasons = collectByKey(nextData, /^(numberOfSeasons|totalSeasons|seasonCount)$/i, 3);
    for (const s of seasons) {
      const n = Number(s);
      if (Number.isFinite(n) && n > 0) {
        out.totalSeasons = Math.round(n);
        break;
      }
    }
  }

  // DOM fallbacks for anything embedded data missed.
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
  if (!out.directors?.length || !out.writers?.length) {
    const creds = extractCreditsDetailed(html);
    if (!out.directors?.length && creds.directors.length) out.directors = creds.directors;
    if (creds.writers.length) out.writers = creds.writers;
    if (!out.creators?.length && creds.stars.length && out.kind === "series") {
      // Series "Created by" names land in the principal-credit stars bucket.
    }
    if (!out.directors?.length) missing.push("directors");
    if (!creds.writers.length) missing.push("writers");
  }
  const det = extractDetailsFallback(html);
  if (det.releaseDate && !out.releaseDate) {
    out.releaseDate = det.releaseDate;
    if (!out.date) out.date = det.releaseDate;
  }
  if (det.countries && !out.countries) out.countries = det.countries;
  if (det.languages && !out.languages) out.languages = det.languages;
  if (det.filmingLocations && !out.filmingLocations) out.filmingLocations = det.filmingLocations;
  if (det.productionCompanies && !out.productionCompanies) out.productionCompanies = det.productionCompanies;
  if (det.tagline && !out.tagline) out.tagline = det.tagline;
  if (det.colorInfo) out.colorInfo = det.colorInfo;
  if (det.soundMix) out.soundMix = det.soundMix;
  if (!out.tagline) missing.push("tagline");
  if (!out.countries) missing.push("countries");
  if (!out.keywords?.length) {
    const kw = extractKeywords(html);
    if (kw.length) out.keywords = kw;
    else missing.push("keywords");
  }

  const kind = detectKind(nextData, (blocks[0] as Record<string, string> | undefined)?.["@type"] as string | undefined);
  out.kind = kind;
  return out;
}

async function loadHtml(urls: string[], engine: BrowserEngine | null, provenance: string[], tag: string): Promise<string | null> {
  for (const u of urls) {
    const http = await fetchImdbHtml(u);
    if (http && !isWafChallengeHtml(http)) {
      provenance.push(`http:${u}`);
      return http;
    }
    logger.warn(`HTTP ${tag} failed for ${u} — escalate to browser engine`);
  }
  if (engine) {
    for (const u of urls) {
      try {
        const snap = await engine.goto(u);
        if (!snap.wafChallenge && snap.html.length > 1000) {
          provenance.push(`browser:${u}`);
          return snap.html;
        }
        logger.warn(`Browser ${tag} still challenged for ${u}`);
      } catch (e) {
        logger.warn(`Browser ${tag} failed for ${u}: ${(e as Error).message}`);
      }
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

  // --- Layer 1: official datasets (WAF-free) --------------------------------
  const basicsText = readCachedDataset("title.basics.tsv.gz");
  const bRow = basicsText ? basicsForTitle(basicsText, id) : null;
  if (basicsText) provenance.push("datasets:title.basics");
  const dsTitle = bRow ? nn(bRow.primaryTitle) : undefined;
  const dsOriginal = bRow ? nn(bRow.originalTitle) : undefined;
  const dsYear = bRow ? nn(bRow.startYear) : undefined;
  const dsEndYear = bRow ? nn(bRow.endYear) : undefined;
  const dsRuntime = bRow && nn(bRow.runtimeMinutes) ? Number(bRow.runtimeMinutes) : null;
  const dsGenres = bRow && nn(bRow.genres) ? (nn(bRow.genres) as string).split(",") : undefined;
  const dsKind = detectKindFromBasics(bRow?.titleType);
  const dsAdult = bRow ? (bRow.isAdult === "1" ? true : bRow.isAdult === "0" ? false : null) : null;
  const dsType = bRow ? nn(bRow.titleType) : undefined;

  const ratingsText = readCachedDataset("title.ratings.tsv.gz");
  const rRow = ratingsText ? ratingsForTitle(ratingsText, id) : null;
  if (ratingsText) provenance.push("datasets:title.ratings");
  const dsRating = rRow ? nn(rRow.averageRating) : undefined;
  const dsVotes = rRow && nn(rRow.numVotes) ? Number(rRow.numVotes) : undefined;

  const akasText = readCachedDataset("title.akas.tsv.gz");
  const dsAkas = akasText ? normalizeAkas(akasForTitle(akasText, id)) : null;
  if (akasText) provenance.push("datasets:title.akas");

  const base: TitleRecord = {
    imdbId: id,
    url,
    title: dsTitle ?? id,
    originalTitle: dsOriginal ?? null,
    titleType: dsType ?? null,
    kind: dsKind ?? "unknown",
    isAdult: dsAdult,
    akas: dsAkas?.length ? dsAkas : null,
    year: dsYear ?? null,
    date: dsYear ?? null,
    endYear: dsEndYear ?? null,
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
    gallery: opts.includeGallery ? [] : null,
    parentsGuide: opts.includeParentsGuide ? null : undefined,
    reviews: opts.includeReviews ? null : undefined,
    episodes: opts.includeEpisodes ? null : undefined,
    episodeCount: null,
    missing,
    scrapedAt: nowIso(),
    provenance,
  };

  // --- Layer 2: page HTML (HTTP -> browser with WAF solving) ---------------
  const html = await loadHtml([url, referenceUrl(id)], engine, provenance, "title");
  if (!html) {
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

  const partial = ldToRecord(html);
  const rec: TitleRecord = {
    ...base,
    title: partial.title ?? base.title,
    kind: partial.kind && partial.kind !== "unknown" ? partial.kind : base.kind,
    year: partial.year ?? base.year,
    date: partial.date ?? base.date,
    releaseDate: partial.releaseDate ?? base.date,
    rating: partial.rating ?? base.rating,
    votes: partial.votes ?? base.votes,
    description: partial.description ?? base.description,
    plot: partial.plot ?? base.plot,
    tagline: partial.tagline,
    runtime: partial.runtime ?? base.runtime,
    runtimeMinutes: partial.runtimeMinutes ?? base.runtimeMinutes,
    genres: partial.genres ?? base.genres,
    keywords: partial.keywords,
    contentRating: partial.contentRating,
    colorInfo: partial.colorInfo,
    soundMix: partial.soundMix,
    awardsSummary: partial.awardsSummary,
    boxOffice: partial.boxOffice,
    metascore: partial.metascore,
    top250Rank: partial.top250Rank,
    countries: partial.countries,
    languages: partial.languages,
    filmingLocations: partial.filmingLocations,
    productionCompanies: partial.productionCompanies,
    directors: partial.directors,
    writers: partial.writers,
    creators: partial.creators,
    cast: partial.cast,
    poster: partial.poster ?? base.poster,
    totalSeasons: partial.totalSeasons,
  };
  for (const m of partial.missing) if (!missing.includes(m)) missing.push(m);

  // Gallery from title page images (IMDb CDN only).
  const gallery = extractGallery(html, opts.maxGalleryPhotos);
  if (rec.poster && !gallery.includes(rec.poster) && gallery.length < opts.maxGalleryPhotos) {
    gallery.unshift(rec.poster);
  }
  if (opts.includeGallery) {
    const photosHtml = await loadHtml([photosUrl(id)], engine, provenance, "photos");
    if (photosHtml) {
      for (const g of extractGallery(photosHtml, opts.maxGalleryPhotos)) {
        if (gallery.length >= opts.maxGalleryPhotos) break;
        if (!gallery.includes(g)) gallery.push(g);
      }
      provenance.push("page:mediaindex");
    } else {
      missing.push("gallery-photos-page");
    }
    rec.gallery = gallery;
    if (!gallery.length) missing.push("gallery");
  } else {
    rec.gallery = gallery.length ? gallery : null;
  }

  // Full credits page: authoritative writers/creators names when available.
  const creditsHtml = await loadHtml([fullCreditsUrl(id)], engine, provenance, "fullcredits");
  if (creditsHtml) {
    const creds = extractCreditsDetailed(creditsHtml);
    if (creds.directors.length && (!rec.directors || !rec.directors.length)) rec.directors = creds.directors;
    if (creds.writers.length) rec.writers = creds.writers;
    if (!rec.creators?.length && rec.kind === "series" && creds.stars.length) rec.creators = creds.stars.slice(0, 5);
    provenance.push("page:fullcredits");
  } else {
    missing.push("fullcredits");
  }

  // --- Reviews / Parental guide / Episodes ---------------------------------
  if (opts.includeReviews) {
    const rHtml = await loadHtml([reviewsUrl(id)], engine, provenance, "reviews");
    if (rHtml) {
      const revs = extractReviewsRich(rHtml, opts.deepReviews ? 100 : 25);
      rec.reviews = revs;
      provenance.push("page:reviews");
      if (!revs.length) missing.push("reviews");
    } else {
      missing.push("reviews");
      rec.reviews = [];
    }
  }
  if (opts.includeParentsGuide) {
    const pHtml = await loadHtml([parentalGuideUrl(id)], engine, provenance, "pg");
    if (pHtml) {
      const pg = extractParentalGuideRich(pHtml);
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
      for (const e of episodesForSeries(epTsv, id).slice(0, opts.maxEpisodes)) {
        eps.push({ imdbId: e.tconst, season: e.seasonNumber !== "\\N" ? Number(e.seasonNumber) : null, episode: e.episodeNumber !== "\\N" ? Number(e.episodeNumber) : null });
      }
    }
    if (!eps.length) {
      const eHtml = await loadHtml([episodesUrl(id)], engine, provenance, "episodes");
      if (eHtml) {
        for (const eid of extractEpisodeIds(eHtml, opts.maxEpisodes)) eps.push({ imdbId: eid });
        provenance.push("page:episodes");
      }
    }
    rec.episodes = eps.slice(0, opts.maxEpisodes);
    rec.episodeCount = rec.episodes.length || null;
    const seasons = rec.episodes.map((e) => e.season).filter((s): s is number => typeof s === "number");
    if (!rec.totalSeasons && seasons.length) rec.totalSeasons = Math.max(...seasons);
    if (!rec.episodes.length) missing.push("episodes");
  }

  rec.missing = [...new Set(missing)];
  rec.provenance = provenance;
  rec.scrapedAt = nowIso();
  return rec;
}

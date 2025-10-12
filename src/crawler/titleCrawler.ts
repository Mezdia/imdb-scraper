import * as cheerio from "cheerio";
import {
  episodesUrl,
  parentalGuideUrl,
  photosUrl,
  referenceUrl,
  reviewsUrl,
  taglinesUrl,
  titleUrl,
} from "../imdb/ids.js";
import type { CrawlOptions, EpisodeRef, TitleRecord } from "../imdb/types.js";
import { BrowserEngine, fetchImdbHtml } from "./engine.js";
import {
  canonicalImageId,
  extractCastFallback,
  extractDetailsFallback,
  extractGallery,
  extractJsonLdBlocks,
  extractKeywords,
  extractNextData,
  formatMinutes,
  isWafChallengeHtml,
  normalizeAkas,
  parseIso8601DurationToMinutes,
  textOf,
} from "./extractors.js";
import {
  countryName,
  parseEpisodeItems,
  parseGalleryNodes,
  parseGuideCategories,
  parseReviewNodes,
  parseSeriesStructure,
  parseTaglines,
  parseTitleNode,
  reviewTotal,
  titleNode,
} from "./graphql.js";
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
// Title crawler, GraphQL-first: IMDb embeds a precise GraphQL payload in
// __NEXT_DATA__ on every page. That is the primary source; JSON-LD second;
// stable data-testid DOM only as a last resort. All IMDb-only (see guard).
// Field groups: A identity, B dates/origin, C ratings, D story, E production,
// F money, G people, H media, I guidance/reviews, J series.
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function nn(v: string | undefined): string | undefined {
  return v && v !== "\\N" && v.trim() ? v : undefined;
}

function detectKindFromBasics(titleType: string | undefined): TitleRecord["kind"] | undefined {
  if (!titleType) return undefined;
  const t = titleType.toLowerCase();
  if (t.includes("tvseries") || t.includes("tvminiseries")) return "series";
  if (t === "tvepisode") return "episode";
  if (t === "movie" || t === "short" || t === "tvmovie" || t === "video") return "movie";
  return undefined;
}

function kindFromGql(p: { isSeries?: boolean; isEpisode?: boolean; titleTypeId?: string }): TitleRecord["kind"] {
  if (p.isEpisode || p.titleTypeId === "tvepisode") return "episode";
  if (p.isSeries || (p.titleTypeId && p.titleTypeId.includes("tvseries")) || p.titleTypeId === "tvminiseries") return "series";
  if (p.titleTypeId === "movie" || p.titleTypeId === "short" || p.titleTypeId === "tvmovie" || p.titleTypeId === "video") return "movie";
  return "unknown";
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

function runtimeText(mins: number | null | undefined): string | null {
  return formatMinutes(mins ?? null);
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
  const miss = (f: string) => {
    if (!missing.includes(f)) missing.push(f);
  };

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
    rating: rRow && nn(rRow.averageRating) ? (nn(rRow.averageRating) as string) : null,
    votes: rRow && nn(rRow.numVotes) ? Number(rRow.numVotes) : null,
    description: null,
    plot: null,
    runtime: runtimeText(dsRuntime),
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

  // --- Layer 2: title page (HTTP -> browser with WAF solving) --------------
  const html = await loadHtml([url, referenceUrl(id)], engine, provenance, "title");
  if (!html) {
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
    miss("page-html (WAF-blocked, partial record from datasets)");
    base.missing = [...new Set(missing)];
    return base;
  }

  const nextData = extractNextData(html);
  const gNode = nextData ? titleNode(nextData) : null;
  const g = gNode ? parseTitleNode(gNode) : null;
  if (gNode) provenance.push("page:__NEXT_DATA__");

  const rec: TitleRecord = { ...base };
  if (g) {
    if (g.title) rec.title = g.title;
    if (g.originalTitle) rec.originalTitle = g.originalTitle;
    if (g.titleTypeId) rec.titleType = g.titleTypeId;
    const gKind = kindFromGql(g);
    if (gKind !== "unknown") rec.kind = gKind;
    if (g.year) {
      rec.year = String(g.year);
      if (!rec.date) rec.date = String(g.year);
    }
    if (g.endYear) rec.endYear = String(g.endYear);
    if (g.releaseDate) {
      rec.releaseDate = g.releaseDate;
      rec.date = g.releaseDate;
    }
    if (g.rating != null) rec.rating = String(g.rating);
    if (g.votes != null) rec.votes = g.votes;
    if (g.topRank != null) rec.top250Rank = g.topRank;
    if (g.metascore != null) rec.metascore = g.metascore;
    if (g.plot) {
      rec.plot = g.plot;
      rec.description = g.plot;
    }
    if (g.genres?.length) rec.genres = g.genres;
    if (g.keywords?.length) rec.keywords = g.keywords;
    if (g.runtimeSeconds) {
      rec.runtimeMinutes = Math.round(g.runtimeSeconds / 60);
      rec.runtime = runtimeText(rec.runtimeMinutes);
    }
    if (g.certificate) rec.contentRating = g.certificate;
    if (g.budget || g.openingWeekend || g.grossUSA || g.grossWorldwide) {
      rec.boxOffice = { budget: g.budget, openingWeekend: g.openingWeekend, grossUSA: g.grossUSA, grossWorldwide: g.grossWorldwide };
    }
    if (g.countryIds?.length) rec.countries = g.countryIds.map(countryName);
    if (g.languages?.length) rec.languages = g.languages;
    if (g.filmingLocations?.length) rec.filmingLocations = g.filmingLocations;
    if (g.awardsSummary) rec.awardsSummary = g.awardsSummary;
    if (g.akas?.length && (!rec.akas || !rec.akas.length)) {
      rec.akas = g.akas.map((a) => ({ title: a }));
    }
    if (g.directors?.length) rec.directors = g.directors.map((d) => d.name);
    if (g.writers?.length) rec.writers = g.writers.map((d) => d.name);
    if (g.creators?.length) rec.creators = g.creators.map((d) => d.name);
    if (g.cast?.length) {
      rec.cast = g.cast.map((c) => ({ name: c.name, imdbId: c.id }));
    }
    if (g.poster) {
      rec.poster = g.poster;
      rec.posterCaption = g.posterCaption ?? null;
    }
    if (g.photoCount != null) rec.photoCount = g.photoCount;
    if (g.videoCount != null) rec.videoCount = g.videoCount;
    if (g.reviewCount != null) rec.reviewCount = g.reviewCount;
    if (g.trailers?.length) rec.trailers = g.trailers;
    if (gNode) {
      const { seasons, years } = parseSeriesStructure(gNode);
      if (seasons.length) rec.totalSeasons = Math.max(...seasons);
      if (years.length && !rec.year) rec.year = String(years[0]);
      if (years.length > 1 && !rec.endYear) rec.endYear = String(years[years.length - 1]);
    }
  } else {
    miss("embedded-graphql");
  }

  // --- JSON-LD second opinion (director/poster/description gaps) ------------
  const blocks = extractJsonLdBlocks(html);
  const ld = blocks.find((b) => b) ?? null;
  if (ld) {
    if (!rec.title && ld.name) rec.title = ld.name;
    const desc = ld.description;
    if ((!rec.plot || !rec.description) && desc) {
      rec.plot = desc;
      rec.description = desc;
    }
    if (!rec.year && ld.datePublished) {
      rec.year = ld.datePublished.slice(0, 4);
      rec.date = ld.datePublished;
      rec.releaseDate = ld.datePublished;
    }
    if ((!rec.rating || !rec.votes) && ld.aggregateRating) {
      const rv = ld.aggregateRating.ratingValue;
      if (!rec.rating && rv != null && String(rv)) rec.rating = String(rv);
      if (!rec.votes && typeof ld.aggregateRating.ratingCount === "number") rec.votes = ld.aggregateRating.ratingCount;
    }
    if ((!rec.genres || !rec.genres.length) && ld.genre) rec.genres = ld.genre;
    if ((!rec.keywords || !rec.keywords.length) && typeof ld.keywords === "string" && ld.keywords.trim()) {
      rec.keywords = ld.keywords.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean).slice(0, 30);
    }
    if (!rec.contentRating && typeof ld.contentRating === "string") rec.contentRating = ld.contentRating;
    if (!rec.runtimeMinutes && ld.duration) {
      const mins = parseIso8601DurationToMinutes(ld.duration);
      if (mins) {
        rec.runtimeMinutes = mins;
        rec.runtime = runtimeText(mins);
      }
    }
    const personNames = (v: unknown): string[] => {
      const arr = Array.isArray(v) ? v : v ? [v] : [];
      return (arr as { "@type"?: string; name?: string }[])
        .filter((p) => p && p["@type"] === "Person" && p.name)
        .map((p) => p.name as string);
    };
    if ((!rec.directors || !rec.directors.length) && ld.director) {
      const d = personNames(ld.director);
      if (d.length) rec.directors = d;
    }
    // schema.org puts writers under "creator" for movies.
    if ((!rec.writers || !rec.writers.length) && ld.creator && rec.kind !== "series") {
      const w = personNames(ld.creator);
      if (w.length) rec.writers = w;
    }
    if (rec.kind === "series" && (!rec.creators || !rec.creators.length) && ld.creator) {
      const c = personNames(ld.creator);
      if (c.length) rec.creators = c;
    }
    if ((!rec.cast || !rec.cast.length) && Array.isArray(ld.actor)) {
      rec.cast = ld.actor.slice(0, 20).map((a) => ({
        name: a.name ?? "Unknown",
        imdbId: a.url ? (a.url.match(/(nm\d+)/i)?.[1]?.toLowerCase() ?? undefined) : undefined,
      }));
    }
    if (!rec.poster && ld.image && typeof ld.image === "string") rec.poster = ld.image;
    if ((!rec.trailers || !rec.trailers.length) && ld.trailer) {
      const trs = Array.isArray(ld.trailer) ? ld.trailer : [ld.trailer];
      const mapped: { id: string; name?: string; url?: string }[] = [];
      for (const t of trs) {
        const eu = typeof t.embedUrl === "string" ? t.embedUrl : undefined;
        if (!eu || !eu.startsWith("https://www.imdb.com/video/vi")) continue;
        const vid = eu.match(/(vi\d+)/)?.[1] ?? "";
        if (!vid) continue;
        mapped.push({ id: vid, name: typeof t.name === "string" ? t.name : undefined, url: eu });
      }
      if (mapped.length) rec.trailers = mapped;
    }
  }

  // --- DOM last resort (roles, details names, plot/rating gaps) -------------
  const $ = cheerio.load(html);
  if (!rec.title) {
    const t = textOf($, SELECTORS.title);
    if (t) rec.title = t;
    else miss("title");
  }
  if (!rec.rating) {
    const r = textOf($, SELECTORS.rating);
    if (r) rec.rating = r.split("/")[0]?.trim();
    else miss("rating");
  }
  if (!rec.plot && !rec.description) {
    const p = textOf($, SELECTORS.plot);
    if (p) {
      rec.plot = p;
      rec.description = p;
    } else miss("plot");
  }
  // Attach character roles to GraphQL cast (DOM has the roles).
  const domCast = extractCastFallback(html);
  if (domCast.length) {
    if (rec.cast?.length) {
      rec.cast = rec.cast.map((c, i) => ({ ...c, role: domCast[i]?.role ?? c.role }));
    } else {
      rec.cast = domCast;
    }
  } else if (!rec.cast?.length) {
    miss("cast");
  }
  const det = extractDetailsFallback(html);
  if (det.releaseDate && !rec.releaseDate) {
    rec.releaseDate = det.releaseDate;
    if (!rec.date) rec.date = det.releaseDate;
  }
  if (det.countries && !rec.countries?.length) rec.countries = det.countries;
  if (det.languages && !rec.languages?.length) rec.languages = det.languages;
  if (det.filmingLocations && !rec.filmingLocations?.length) rec.filmingLocations = det.filmingLocations;
  if (det.productionCompanies && !rec.productionCompanies?.length) rec.productionCompanies = det.productionCompanies;
  if (det.colorInfo) rec.colorInfo = det.colorInfo;
  if (det.soundMix) rec.soundMix = det.soundMix;
  if (!rec.keywords?.length) {
    const kw = extractKeywords(html);
    if (kw.length) rec.keywords = kw;
  }

  // --- Tagline (own IMDb subpage) --------------------------------------------
  if (!rec.tagline) {
    const tagHtml = await loadHtml([taglinesUrl(id)], engine, provenance, "taglines");
    if (tagHtml) {
      const tagNd = extractNextData(tagHtml);
      const tags = tagNd ? parseTaglines(tagNd) : [];
      if (tags.length) {
        rec.tagline = tags[0];
        provenance.push("page:taglines");
      } else {
        miss("tagline");
      }
    } else {
      miss("tagline");
    }
  }

  // --- Gallery (title <img> always; mediaindex when requested) ----------------
  // Entries carry captions where IMDb provides them (mediaindex nodes).
  const gallery: { url: string; caption?: string }[] = [];
  const seenUrls = new Set<string>();
  const addPhoto = (url: string | undefined, caption?: string) => {
    if (!url || gallery.length >= opts.maxGalleryPhotos) return;
    // Dedupe by canonical image id so crop variants of one still collapse.
    const key = canonicalImageId(url) ?? url;
    if (seenUrls.has(key)) {
      if (caption) {
        const existing = gallery.find((g) => (canonicalImageId(g.url) ?? g.url) === key);
        if (existing && !existing.caption) existing.caption = caption;
      }
      return;
    }
    seenUrls.add(key);
    gallery.push(caption ? { url, caption } : { url });
  };
  for (const u of extractGallery(html, opts.maxGalleryPhotos)) addPhoto(u);
  // Poster leads the gallery.
  if (rec.poster) {
    const at = gallery.findIndex((g) => g.url === rec.poster);
    if (at >= 0) gallery.splice(at, 1);
    gallery.unshift(
      rec.posterCaption ? { url: rec.poster, caption: rec.posterCaption } : { url: rec.poster },
    );
  }
  if (opts.includeGallery) {
    const photosHtml = await loadHtml([photosUrl(id)], engine, provenance, "photos");
    if (photosHtml) {
      const photoNd = extractNextData(photosHtml);
      if (photoNd) {
        for (const ph of parseGalleryNodes(photoNd, opts.maxGalleryPhotos)) {
          addPhoto(ph.url, ph.caption);
        }
      }
      for (const gh of extractGallery(photosHtml, opts.maxGalleryPhotos)) {
        addPhoto(gh);
      }
      provenance.push("page:mediaindex");
    } else {
      miss("gallery-photos-page");
    }
    rec.gallery = gallery;
    if (!gallery.length) miss("gallery");
  } else {
    rec.gallery = gallery.length ? gallery : null;
  }

  // --- Reviews (GraphQL nodes first, DOM fallback) -----------------------------
  if (opts.includeReviews) {
    let rHtml: string | null = null;
    if (opts.deepReviews && engine) {
      // Deep mode: scroll the reviews page to load more client-side.
      try {
        const snap = await engine.gotoWithScroll(reviewsUrl(id), "article, [data-testid*=\"review\"]", 8);
        if (!snap.wafChallenge && snap.html.length > 1000) {
          rHtml = snap.html;
          provenance.push(`browser-scroll:${reviewsUrl(id)}`);
        }
      } catch (e) {
        logger.warn(`Deep-review scroll failed for ${id}: ${(e as Error).message}`);
      }
    }
    rHtml ??= await loadHtml([reviewsUrl(id)], engine, provenance, "reviews");
    if (rHtml) {
      const rNd = extractNextData(rHtml);
      const gql = rNd ? parseReviewNodes(rNd, opts.deepReviews ? 100 : 25) : [];
      const { extractReviewsRich, mergeReviews } = await import("./extractors.js");
      const dom = extractReviewsRich(rHtml, opts.deepReviews ? 100 : 25);
      const revs = mergeReviews(gql, dom, opts.deepReviews ? 100 : 25);
      rec.reviews = revs;
      const total = rNd ? reviewTotal(rNd) : undefined;
      if (total != null) rec.reviewCount = total;
      provenance.push("page:reviews");
      if (!revs.length) miss("reviews");
    } else {
      miss("reviews");
      rec.reviews = [];
    }
  }

  // --- Parental guide (GraphQL categories first, DOM fallback) ------------------
  if (opts.includeParentsGuide) {
    const pHtml = await loadHtml([parentalGuideUrl(id)], engine, provenance, "pg");
    if (pHtml) {
      const pNd = extractNextData(pHtml);
      let pg = pNd ? parseGuideCategories(pNd) : [];
      if (!pg.length) {
        const { extractParentalGuideRich } = await import("./extractors.js");
        pg = extractParentalGuideRich(pHtml);
      }
      rec.parentsGuide = pg;
      provenance.push("page:parentalguide");
      if (!pg.length) miss("parentsGuide");
    } else {
      miss("parentsGuide");
      rec.parentsGuide = [];
    }
  }

  // --- Episodes (GraphQL items per season, TSV fallback) -------------------------
  if (opts.includeEpisodes && rec.kind === "series") {
    const eps: EpisodeRef[] = [];
    const seen = new Set<string>();
    // Seasons known from the title payload; fall back to season 1..N probe.
    let seasons: number[] = [];
    if (gNode) {
      seasons = parseSeriesStructure(gNode).seasons;
    }
    if (!seasons.length && rec.totalSeasons) {
      seasons = Array.from({ length: rec.totalSeasons }, (_, i) => i + 1);
    }
    if (seasons.length) provenance.push("page:__NEXT_DATA__");
    for (const s of seasons.slice(0, 60)) {
      if (eps.length >= opts.maxEpisodes) break;
      const eHtml = await loadHtml([episodesUrl(id, s)], engine, provenance, "episodes");
      if (!eHtml) continue;
      const eNd = extractNextData(eHtml);
      const items = eNd ? parseEpisodeItems(eNd, opts.maxEpisodes) : [];
      for (const it of items) {
        if (eps.length >= opts.maxEpisodes) break;
        if (!seen.has(it.imdbId)) {
          seen.add(it.imdbId);
          eps.push(it);
        }
      }
      if (!items.length) {
        const { extractEpisodeIds } = await import("./extractors.js");
        for (const eid of extractEpisodeIds(eHtml, opts.maxEpisodes)) {
          if (eps.length >= opts.maxEpisodes || seen.has(eid)) break;
          seen.add(eid);
          eps.push({ imdbId: eid });
        }
      }
    }
    if (!eps.length) {
      const epTsv = readCachedDataset("title.episode.tsv.gz");
      if (epTsv) {
        provenance.push("datasets:title.episode");
        for (const e of episodesForSeries(epTsv, id).slice(0, opts.maxEpisodes)) {
          eps.push({
            imdbId: e.tconst,
            season: e.seasonNumber !== "\\N" ? Number(e.seasonNumber) : null,
            episode: e.episodeNumber !== "\\N" ? Number(e.episodeNumber) : null,
          });
        }
      }
    }
    rec.episodes = eps.slice(0, opts.maxEpisodes);
    rec.episodeCount = rec.episodes.length || null;
    const seasonNums = rec.episodes.map((e) => e.season).filter((x): x is number => typeof x === "number");
    if (!rec.totalSeasons && seasonNums.length) rec.totalSeasons = Math.max(...seasonNums);
    if (rec.episodes.length) provenance.push("page:episodes");
    else miss("episodes");
  } else if (opts.includeEpisodes) {
    rec.episodes = null;
  }

  // --- Required-field audit ------------------------------------------------------
  // Series are "created", movies are "directed/written" — audit accordingly.
  if (rec.kind === "series") {
    if (!rec.creators?.length) miss("creators");
  } else {
    if (!rec.directors?.length) miss("directors");
    if (!rec.writers?.length) miss("writers");
  }
  if (!rec.tagline) miss("tagline");
  if (!rec.countries?.length) miss("countries");
  if (!rec.keywords?.length) miss("keywords");
  if (rec.kind === "unknown") miss("kind");

  rec.missing = [...new Set(missing)];
  rec.provenance = provenance;
  rec.scrapedAt = nowIso();
  return rec;
}

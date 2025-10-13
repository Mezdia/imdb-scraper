import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TitleRecord } from "../imdb/types.js";
import { logger } from "../logger.js";

export function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim().slice(0, 120) || "untitled";
}

export interface StoredPaths {
  dir: string;
  jsonPath: string;
  legacyMainJs: string;
  legacyReviewJs: string;
  indexHtml: string;
}

export function titleDir(outRoot: string, rec: TitleRecord, listName?: string): string {
  if (listName) return join(outRoot, "Lists", safeName(listName));
  const year = rec.year ?? "Unknown";
  const folder = `${safeName(rec.title)} (${year}) [${rec.imdbId}]`;
  return rec.kind === "series" || rec.kind === "episode"
    ? join(outRoot, "Series", folder)
    : join(outRoot, "Movies", folder);
}

function mainEntry(rec: TitleRecord): Record<string, unknown> {
  return {
    Title: rec.title,
    OriginalTitle: rec.originalTitle,
    TitleType: rec.titleType,
    Date: rec.date,
    ReleaseDate: rec.releaseDate,
    EndYear: rec.endYear,
    Rate: rec.rating,
    Votes: rec.votes,
    Metascore: rec.metascore,
    Top250Rank: rec.top250Rank,
    Description: rec.description ?? rec.plot,
    Tagline: rec.tagline,
    Runtime: rec.runtime,
    ContentRating: rec.contentRating,
    Countries: rec.countries,
    Languages: rec.languages,
    FilmingLocations: rec.filmingLocations,
    ProductionCompanies: rec.productionCompanies,
    BoxOffice: rec.boxOffice,
    Awards: rec.awardsSummary,
    Keywords: rec.keywords,
    Akas: rec.akas,
    Cast: rec.cast,
    Directors: rec.directors,
    Writers: rec.writers,
    Creators: rec.creators,
    Genres: rec.genres,
    Poster: rec.poster,
    Gallery: rec.gallery,
    ParentsGuide: rec.parentsGuide,
    Kind: rec.kind,
    Year: rec.year,
    Url: rec.url,
  };
}

function parseJsMapFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const cur = readFileSync(path, "utf8");
    const m = cur.match(/\{[\s\S]*\}$/);
    if (!m) return {};
    const parsed: unknown = JSON.parse(m[0]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function parseListFile(path: string): TitleRecord[] {
  try {
    if (!existsSync(path)) return [];
    const cur = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(cur) ? (cur as TitleRecord[]) : [];
  } catch {
    return [];
  }
}

export function storeRecord(outRoot: string, rec: TitleRecord, listName?: string): StoredPaths {
  const dir = titleDir(outRoot, rec, listName);
  mkdirSync(join(dir, "data"), { recursive: true });
  const jsonPath = join(dir, "data.json");
  const legacyMainJs = join(dir, "data", "main.js");
  const legacyReviewJs = join(dir, "data", "review.js");

  if (listName) {
    // List mode: data.json is an ARRAY of records; legacy maps merge.
    const arr = parseListFile(jsonPath);
    const idx = arr.findIndex((r) => r.imdbId === rec.imdbId);
    if (idx >= 0) arr[idx] = rec;
    else arr.push(rec);
    writeFileSync(jsonPath, JSON.stringify(arr, null, 2), "utf8");

    const mainMap = parseJsMapFile(legacyMainJs);
    mainMap[rec.imdbId] = mainEntry(rec);
    writeFileSync(legacyMainJs, `const MAIN_DATA = ${JSON.stringify(mainMap, null, 2)}`, "utf8");

    const revMap = parseJsMapFile(legacyReviewJs);
    revMap[rec.imdbId] = { Reviews: rec.reviews ?? [] };
    writeFileSync(legacyReviewJs, `const REVIEW_DATA = ${JSON.stringify(revMap, null, 2)}`, "utf8");
  } else {
    writeFileSync(jsonPath, JSON.stringify(rec, null, 2), "utf8");

    // Legacy compat: data/main.js + data/review.js (MAIN_DATA / REVIEW_DATA)
    const mainJs: Record<string, unknown> = { [rec.imdbId]: mainEntry(rec) };
    writeFileSync(legacyMainJs, `const MAIN_DATA = ${JSON.stringify(mainJs, null, 2)}`, "utf8");
    const reviewJs: Record<string, unknown> = { [rec.imdbId]: { Reviews: rec.reviews ?? [] } };
    writeFileSync(legacyReviewJs, `const REVIEW_DATA = ${JSON.stringify(reviewJs, null, 2)}`, "utf8");
  }

  logger.debug(`Stored ${rec.imdbId} -> ${jsonPath}`);
  return { dir, jsonPath, legacyMainJs, legacyReviewJs, indexHtml: join(dir, "index.html") };
}

export function alreadyScraped(outRoot: string, rec: { imdbId: string; title: string; year?: string | null; kind: string }, listName?: string): boolean {
  if (listName) {
    const dir = titleDir(outRoot, rec as TitleRecord, listName);
    const arr = parseListFile(join(dir, "data.json"));
    return arr.some((r) => r.imdbId === rec.imdbId);
  }
  // NOTE: the stored folder name embeds the real title/year, which the
  // pre-crawl stub (title=id) cannot predict — so scan for the id-tagged
  // folder instead of reconstructing the path. Checks both Movies/Series.
  return findRecordDir(outRoot, rec.imdbId) !== null;
}

/** Locate an existing record dir by its [tt...] id tag (any section). */
export function findRecordDir(outRoot: string, imdbId: string): string | null {
  for (const root of [join(outRoot, "Movies"), join(outRoot, "Series")]) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.includes(`[${imdbId}]`) && existsSync(join(root, e, "data.json"))) {
        return join(root, e);
      }
    }
  }
  return null;
}

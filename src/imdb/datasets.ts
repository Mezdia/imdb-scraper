import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { DATASETS_ORIGIN, type DatasetFile } from "./constants.js";
import { assertImdbOnlyUrl, imdbFetch } from "./guard.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Official IMDb bulk datasets (datasets.imdbws.com). 100% IMDb, WAF-free.
// Docs: https://developer.imdb.com/non-commercial-datasets/
// ---------------------------------------------------------------------------

export interface BasicsRow {
  tconst: string;
  titleType: string;
  primaryTitle: string;
  originalTitle: string;
  isAdult: string;
  startYear: string;
  endYear: string;
  runtimeMinutes: string;
  genres: string;
}

export interface RatingRow {
  tconst: string;
  averageRating: string;
  numVotes: string;
}

export interface CrewRow {
  tconst: string;
  directors: string;
  writers: string;
}

export interface EpisodeRow {
  tconst: string;
  parentTconst: string;
  seasonNumber: string;
  episodeNumber: string;
}

export interface PrincipalRow {
  tconst: string;
  ordering: string;
  nconst: string;
  category: string;
  job: string;
  characters: string;
}

export interface NameRow {
  nconst: string;
  primaryName: string;
  birthYear: string;
  deathYear: string;
  primaryProfession: string;
  knownForTitles: string;
}

export function datasetUrl(file: DatasetFile): string {
  return assertImdbOnlyUrl(`${DATASETS_ORIGIN}/${file}`);
}

/** Split a TSV text (header + rows) into objects. Pure + unit-tested. */
export function parseTsv(text: string): Record<string, string>[] {
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = (lines[0] ?? "").split("\t");
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = (lines[i] ?? "").split("\t");
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) row[header[c] as string] = cols[c] ?? "";
    out.push(row);
  }
  return out;
}

export function parseBasicsTsv(text: string): BasicsRow[] {
  return parseTsv(text) as unknown as BasicsRow[];
}

export function indexRatingsTsv(text: string): Map<string, RatingRow> {
  const map = new Map<string, RatingRow>();
  for (const r of parseTsv(text)) map.set(r["tconst"] as string, r as unknown as RatingRow);
  return map;
}

export function episodesForSeries(episodeTsv: string, seriesId: string): EpisodeRow[] {
  // title.episode is sorted by episode tconst (not parent), so single-pass
  // line scan without materializing every row as an object.
  const out: EpisodeRow[] = [];
  const lines = episodeTsv.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line) continue;
    const c = line.split("\t");
    if (c[1] === seriesId) {
      out.push({ tconst: c[0] as string, parentTconst: c[1] as string, seasonNumber: c[2] as string, episodeNumber: c[3] as string });
    }
  }
  return out.sort(
    (a, b) =>
      Number(a.seasonNumber || 0) - Number(b.seasonNumber || 0) ||
      Number(a.episodeNumber || 0) - Number(b.episodeNumber || 0),
  );
}

export function principalsForTitle(principalsTsv: string, titleId: string, limit = 15): PrincipalRow[] {
  // title.principals is sorted by tconst — early-exit scan, no full parse.
  const rows = rowsForId(principalsTsv, titleId) as unknown as PrincipalRow[];
  return rows
    .sort((a, b) => Number(a.ordering) - Number(b.ordering))
    .slice(0, limit);
}

/**
 * Sorted-file early-exit scan. Official IMDb TSVs are sorted by tconst, so we
 * stop at the first row greater than the target instead of reading everything.
 */
function rowsForId(text: string, id: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const lines = text.split("\n");
  if (lines.length === 0) return out;
  const header = (lines[0] ?? "").split("\t");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line) continue;
    if (line < id && !line.startsWith(id)) {
      // Rows are sorted; a row strictly smaller (and not our prefix) can be skipped.
      // Cannot break yet — keep scanning.
      continue;
    }
    if (line.startsWith(id + "\t")) {
      const cols = line.split("\t");
      const row: Record<string, string> = {};
      for (let c = 0; c < header.length; c++) row[header[c] as string] = cols[c] ?? "";
      out.push(row);
      continue;
    }
    if (out.length > 0) break; // passed our block
    if (line > id && !line.startsWith(id)) break; // passed where our block would be
  }
  return out;
}

/** Single ratings row for a title. */
export function ratingsForTitle(ratingsTsv: string, titleId: string): RatingRow | null {
  const rows = rowsForId(ratingsTsv, titleId);
  return (rows[0] as unknown as RatingRow) ?? null;
}

/** Single basics row for a title (originalTitle, titleType, years, ...). */
export function basicsForTitle(basicsTsv: string, titleId: string): BasicsRow | null {
  const rows = rowsForId(basicsTsv, titleId);
  return (rows[0] as unknown as BasicsRow) ?? null;
}

/** Director/writer nconsts for a title from official title.crew. */
export function crewForTitle(crewTsv: string, titleId: string): CrewRow | null {
  const rows = rowsForId(crewTsv, titleId);
  return (rows[0] as unknown as CrewRow) ?? null;
}

export function splitNconsts(field: string): string[] {
  if (!field || field === "\\N") return [];
  return field.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Localized titles for a title from official title.akas. */
export function akasForTitle(
  akasTsv: string,
  titleId: string,
  limit = 25,
): { title: string; region?: string; language?: string; types?: string; isOriginal?: boolean }[] {
  return rowsForId(akasTsv, titleId)
    .slice(0, limit)
    .map((r) => ({
      title: r["title"] as string,
      region: r["region"] !== "\\N" ? (r["region"] as string) : undefined,
      language: r["language"] !== "\\N" ? (r["language"] as string) : undefined,
      types: r["types"] !== "\\N" ? (r["types"] as string) : undefined,
      isOriginal: r["isOriginalTitle"] === "1",
    }))
    .filter((a) => a.title);
}

export function namesIndex(nameTsv: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of parseTsv(nameTsv) as unknown as NameRow[]) map.set(r.nconst, r.primaryName);
  return map;
}

// ---------------------------------------------------------------------------
// Download + local cache (datasets are ~200MB; cache under .cache/imdb/)
// ---------------------------------------------------------------------------

export function cacheDir(base = process.cwd()): string {
  const dir = join(base, ".cache", "imdb");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cachedPath(file: DatasetFile, base = process.cwd()): string {
  return join(cacheDir(base), file.replace(/\.gz$/, ""));
}

export async function ensureDataset(file: DatasetFile, base = process.cwd()): Promise<string> {
  const dest = cachedPath(file, base);
  if (existsSync(dest)) {
    logger.debug(`Dataset cache hit: ${dest}`);
    return dest;
  }
  const url = datasetUrl(file);
  logger.info(`Downloading official IMDb dataset ${file} (one-time, ~large)…`);
  const res = await imdbFetch(url);
  if (!res.ok || !res.body) throw new Error(`Dataset download failed ${res.status}: ${file}`);
  const tmp = `${dest}.part`;
  const gzPath = `${dest}.gz`;
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(gzPath, buf);
    const out = createWriteStream(tmp);
    await pipeline(
      (await import("node:fs")).createReadStream(gzPath),
      createGunzip(),
      out,
    );
    (await import("node:fs")).renameSync(tmp, dest);
  } catch (e) {
    try {
      (await import("node:fs")).unlinkSync(tmp);
    } catch {
      // best effort cleanup
    }
    throw e;
  }
  logger.success(`Cached dataset: ${dest}`);
  return dest;
}

export function readCachedDataset(file: DatasetFile, base = process.cwd()): string | null {
  const p = cachedPath(file, base);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

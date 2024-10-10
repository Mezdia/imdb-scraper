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
  const rows = parseTsv(episodeTsv) as unknown as EpisodeRow[];
  return rows
    .filter((r) => r.parentTconst === seriesId)
    .sort(
      (a, b) =>
        Number(a.seasonNumber || 0) - Number(b.seasonNumber || 0) ||
        Number(a.episodeNumber || 0) - Number(b.episodeNumber || 0),
    );
}

export function principalsForTitle(principalsTsv: string, titleId: string, limit = 15): PrincipalRow[] {
  const rows = parseTsv(principalsTsv) as unknown as PrincipalRow[];
  return rows
    .filter((r) => r.tconst === titleId)
    .sort((a, b) => Number(a.ordering) - Number(b.ordering))
    .slice(0, limit);
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
  const out = createWriteStream(tmp);
  const nodeStream = res.body as unknown as NodeJS.ReadableStream;
  const gunzip = createGunzip();
  // res.body is a web stream; convert via async iteration is complex — use Response.arrayBuffer for simplicity
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(`${dest}.gz`, buf);
  await pipeline(
    (await import("node:fs")).createReadStream(`${dest}.gz`),
    createGunzip(),
    out,
  );
  void gunzip;
  void nodeStream;
  (await import("node:fs")).renameSync(tmp, dest);
  logger.success(`Cached dataset: ${dest}`);
  return dest;
}

export function readCachedDataset(file: DatasetFile, base = process.cwd()): string | null {
  const p = cachedPath(file, base);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

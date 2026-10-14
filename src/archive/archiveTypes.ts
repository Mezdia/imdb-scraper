import type { TitleRecord } from "../imdb/types.js";

/** Isolated archive (Wayback) types — BETA. See AGENTS.md §5. */

export const ARCHIVE_HOST = "web.archive.org";
export const ARCHIVE_ORIGIN = "https://web.archive.org";

export interface ArchiveOptions {
  enabled: boolean;
  /** "latest" or YYYYMMDDHHMMSS (prefix allowed). */
  timestamp: string;
}

export const DEFAULT_ARCHIVE_OPTIONS: ArchiveOptions = {
  enabled: false,
  timestamp: "latest",
};

export function normalizeArchiveTimestamp(input: unknown): string {
  if (input == null || input === "") return "latest";
  const s = String(input).trim().toLowerCase();
  if (s === "latest" || s === "2") return "latest";
  const digits = s.replace(/\D/g, "");
  if (/^\d{4,14}$/.test(digits)) return digits;
  throw new Error(`Invalid --archive-timestamp (expected latest or YYYYMMDDHHMMSS): ${String(input)}`);
}

/** TitleRecord plus beta archive provenance (no edits to src/imdb/*). */
export type ArchivedTitleRecord = TitleRecord & {
  archivedAt: string | null;
  archiveUrl: string | null;
};

export function withArchiveFields(rec: TitleRecord): ArchivedTitleRecord {
  const r = rec as Partial<ArchivedTitleRecord>;
  return {
    ...rec,
    archivedAt: r.archivedAt ?? null,
    archiveUrl: r.archiveUrl ?? null,
  };
}

/** True when the live crawl left no usable page-html (archive trigger). */
export function needsArchiveFallback(rec: TitleRecord): boolean {
  return (rec.missing ?? []).some((m) => m.includes("page-html"));
}

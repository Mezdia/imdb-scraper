import { isImdbOnlyUrl } from "../imdb/guard.js";
import { ARCHIVE_HOST, ARCHIVE_ORIGIN } from "./archiveTypes.js";

/**
 * Beta-only Wayback guard. Isolated from src/imdb/guard.ts by design:
 * web.archive.org is NEVER added to ALLOWED_HOSTS. See AGENTS.md §5.2.
 */

export class NonArchivedImdbUrlError extends Error {
  constructor(url: string) {
    super(
      `Blocked non-archived-IMDb URL (archive BETA rule, see AGENTS.md §5): ${url}. ` +
        `Expected https://web.archive.org/web/<timestamp>id_/https://www.imdb.com/...`,
    );
    this.name = "NonArchivedImdbUrlError";
  }
}

const TIMESTAMP_RE = /^(\d{1,14})(id_)?$/i;

function embeddedFromPath(pathname: string): { timestamp: string; idSuffix: boolean; embedded: string } | null {
  // pathname: /web/<timestamp>[id_]/<embedded-url>
  const m = pathname.match(/^\/web\/([^/]+)\/(.+)$/i);
  if (!m) return null;
  const tsRaw = (m[1] as string).trim();
  const embedded = (m[2] as string).trim();
  const ts = tsRaw.match(TIMESTAMP_RE);
  if (!ts) return null;
  return { timestamp: ts[1] as string, idSuffix: Boolean(ts[2]), embedded };
}

/** True only for Wayback snapshot URLs whose embedded URL is IMDb-owned. */
export function isArchiveUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.hostname.toLowerCase() !== ARCHIVE_HOST) return false;
  const parts = embeddedFromPath(u.pathname);
  if (!parts) return false;
  // Reject liveweb / rewritten modifiers; only digits (+ optional id_).
  if (!TIMESTAMP_RE.test(`${parts.timestamp}${parts.idSuffix ? "id_" : ""}`)) return false;
  let embedded = parts.embedded;
  // Wayback strips the scheme slash sometimes; restore minimal scheme check.
  if (!/^https?:\/\//i.test(embedded)) return false;
  try {
    // Embedded must itself be IMDb-only (www/m + imdb.com).
    return isImdbOnlyUrl(embedded);
  } catch {
    return false;
  }
}

export function assertArchiveUrl(url: string): string {
  if (!isArchiveUrl(url)) throw new NonArchivedImdbUrlError(url);
  return url;
}

/** Fetch wrapper that refuses non-archive-IMDb URLs before any I/O. */
export async function archiveFetch(url: string, init?: RequestInit): Promise<Response> {
  assertArchiveUrl(url);
  return fetch(url, init);
}

/** Build a snapshot URL for an IMDb URL. Validates embedded IMDb-only. */
export function buildArchiveUrl(imdbUrl: string, timestamp: string = "latest"): string {
  let normalizedTimestamp = timestamp.trim().toLowerCase();
  if (normalizedTimestamp === "latest" || normalizedTimestamp === "2") normalizedTimestamp = "2";
  if (!/^\d{1,14}$/.test(normalizedTimestamp)) {
    throw new NonArchivedImdbUrlError(`${ARCHIVE_ORIGIN}/web/${timestamp}/${imdbUrl}`);
  }
  if (!isImdbOnlyUrl(imdbUrl)) throw new NonArchivedImdbUrlError(`${ARCHIVE_ORIGIN}/web/${normalizedTimestamp}id_/${imdbUrl}`);
  return assertArchiveUrl(`${ARCHIVE_ORIGIN}/web/${normalizedTimestamp}id_/${imdbUrl}`);
}

/** Extract the embedded original IMDb URL, or null. */
export function extractEmbeddedImdbUrl(archiveUrl: string): string | null {
  try {
    const u = new URL(archiveUrl);
    if (u.hostname.toLowerCase() !== ARCHIVE_HOST) return null;
    const parts = embeddedFromPath(u.pathname);
    if (!parts) return null;
    return isImdbOnlyUrl(parts.embedded) ? parts.embedded : null;
  } catch {
    return null;
  }
}

/** Extract the snapshot timestamp token, or null. */
export function extractArchiveTimestamp(archiveUrl: string): string | null {
  try {
    const u = new URL(archiveUrl);
    if (u.hostname.toLowerCase() !== ARCHIVE_HOST) return null;
    const parts = embeddedFromPath(u.pathname);
    return parts ? parts.timestamp : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CDX lookup guard (same host, metadata only). Snapshot fetches MUST use
// isArchiveUrl/assertArchiveUrl above; "latest" auto-resolution uses the
// helpers below. The CDX endpoint never serves page-html itself — it only
// returns capture timestamps for the exact same IMDb URL.
// ---------------------------------------------------------------------------

/** Build a CDX query URL for the exact IMDb URL (latest-snapshot lookup). */
export function buildArchiveCdxUrl(imdbUrl: string, limit = 5): string {
  if (!isImdbOnlyUrl(imdbUrl)) {
    throw new NonArchivedImdbUrlError(`${ARCHIVE_ORIGIN}/cdx/search/cdx?url=${imdbUrl}`);
  }
  const n = Math.max(1, Math.min(50, Math.floor(limit) || 5));
  const u = new URL(`${ARCHIVE_ORIGIN}/cdx/search/cdx`);
  u.searchParams.set("url", imdbUrl);
  u.searchParams.set("output", "json");
  u.searchParams.set("filter", "statuscode:200");
  u.searchParams.set("fl", "timestamp,original,statuscode,mimetype");
  u.searchParams.set("collapse", "digest");
  u.searchParams.set("limit", String(-n));
  return assertArchiveCdxUrl(u.toString());
}

/** True only for Wayback CDX query URLs whose `url=` param is IMDb-owned. */
export function isArchiveCdxUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.hostname.toLowerCase() !== ARCHIVE_HOST) return false;
  if (u.pathname !== "/cdx/search/cdx") return false;
  const target = u.searchParams.get("url");
  if (!target) return false;
  try {
    return isImdbOnlyUrl(target);
  } catch {
    return false;
  }
}

export function assertArchiveCdxUrl(url: string): string {
  if (!isArchiveCdxUrl(url)) throw new NonArchivedImdbUrlError(url);
  return url;
}

/** Fetch wrapper for CDX metadata lookups (refuses non-IMDb targets). */
export async function archiveCdxFetch(url: string, init?: RequestInit): Promise<Response> {
  assertArchiveCdxUrl(url);
  return fetch(url, init);
}

/** Real-browser headers for Wayback HTML (isolated copy, no imdb import). */
export function archiveHtmlHeaders(referer = "https://www.google.com/"): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: referer,
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
  };
}

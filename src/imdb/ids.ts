import { assertImdbOnlyUrl } from "./guard.js";
import { IMDB_ORIGIN } from "./constants.js";

const TITLE_ID_RE = /(tt\d{7,10})/i;

/** Extract `ttxxxxxxx` from any IMDb title URL or bare id. */
export function extractTitleId(input: string): string | null {
  const m = input.match(TITLE_ID_RE);
  return m ? m[1].toLowerCase() : null;
}

export function isTitleId(input: string): boolean {
  return /^tt\d{7,10}$/i.test(input.trim());
}

/** Canonical IMDb title URL for an id. Always validated IMDb-only. */
export function titleUrl(imdbId: string): string {
  const id = imdbId.trim().toLowerCase();
  if (!isTitleId(id)) throw new Error(`Not a valid IMDb title id: ${imdbId}`);
  return assertImdbOnlyUrl(`${IMDB_ORIGIN}/title/${id}/`);
}

export function reviewsUrl(imdbId: string): string {
  return assertImdbOnlyUrl(`${IMDB_ORIGIN}/title/${imdbId.toLowerCase()}/reviews/`);
}

export function parentalGuideUrl(imdbId: string): string {
  return assertImdbOnlyUrl(`${IMDB_ORIGIN}/title/${imdbId.toLowerCase()}/parentalguide/`);
}

export function episodesUrl(imdbId: string): string {
  return assertImdbOnlyUrl(`${IMDB_ORIGIN}/title/${imdbId.toLowerCase()}/episodes/`);
}

export function referenceUrl(imdbId: string): string {
  return assertImdbOnlyUrl(`${IMDB_ORIGIN}/title/${imdbId.toLowerCase()}/reference/`);
}

/**
 * Normalize user input (bare id, imdb URL with or without protocol) into a
 * canonical IMDb title URL. Throws for non-IMDb hosts and non-title inputs.
 */
export function normalizeTitleInput(input: string): { imdbId: string; url: string } {
  const raw = input.trim();
  const imdbId = extractTitleId(raw);
  if (!imdbId) throw new Error(`Could not find an IMDb title id (tt...) in: ${input}`);
  let url = titleUrl(imdbId);
  // If the user gave a full URL, validate its host is IMDb-owned.
  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    assertImdbOnlyUrl(u.href);
  }
  return { imdbId, url };
}

import { ALLOWED_HOSTS } from "./constants.js";

export class NonImdbSourceError extends Error {
  constructor(url: string) {
    super(
      `Blocked non-IMDb URL (IMDb-only rule, see AGENTS.md): ${url}. ` +
        `Allowed hosts: ${[...ALLOWED_HOSTS].join(", ")}`,
    );
    this.name = "NonImdbSourceError";
  }
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/** True when the URL points at IMDb-owned infrastructure. */
export function isImdbOnlyUrl(url: string): boolean {
  let h: string;
  try {
    h = hostOf(url);
  } catch {
    return false;
  }
  if (ALLOWED_HOSTS.has(h)) return true;
  // Allow subdomains of imdb.com / media-imdb.com / imdbws.com only.
  return (
    h.endsWith(".imdb.com") ||
    h.endsWith(".media-imdb.com") ||
    h.endsWith(".imdbws.com")
  );
}

/**
 * Enforce the IMDb-only rule. Throws NonImdbSourceError for anything else.
 * EVERY network call in this codebase must pass through here.
 */
export function assertImdbOnlyUrl(url: string): string {
  if (!isImdbOnlyUrl(url)) throw new NonImdbSourceError(url);
  return url;
}

/**
 * Fetch wrapper that refuses non-IMDb URLs before any I/O happens.
 */
export async function imdbFetch(url: string, init?: RequestInit): Promise<Response> {
  assertImdbOnlyUrl(url);
  return fetch(url, init);
}

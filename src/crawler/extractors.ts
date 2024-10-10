import * as cheerio from "cheerio";
import { SELECTORS } from "../imdb/selectors.js";
import type { CastMember, ParentalGuideItem, Review } from "../imdb/types.js";

// ---------------------------------------------------------------------------
// Embedded-data-first extraction. IMDb embeds official JSON in the HTML:
//   <script type="application/ld+json"> and <script id="__NEXT_DATA__">.
// These are stable; DOM class names are not. DOM is the last resort.
// ---------------------------------------------------------------------------

export interface LdJsonTitle {
  name?: string;
  datePublished?: string;
  aggregateRating?: { ratingValue?: string | number; ratingCount?: number };
  description?: string;
  genre?: string[];
  actor?: { name?: string; url?: string }[];
  director?: { name?: string }[] | { name?: string };
  duration?: string;
  image?: string;
  contentRating?: string;
}

export function extractJsonLdBlocks(html: string): LdJsonTitle[] {
  const $ = cheerio.load(html);
  const out: LdJsonTitle[] = [];
  $(SELECTORS.jsonLd).each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        const o = item as Record<string, unknown>;
        if (o && (o["@type"] === "Movie" || o["@type"] === "TVSeries" || o["@type"] === "TVEpisode" || o["name"])) {
          out.push(o as unknown as LdJsonTitle);
        }
      }
    } catch {
      // Ignore non-JSON blocks.
    }
  });
  return out;
}

export function extractNextData(html: string): Record<string, unknown> | null {
  const $ = cheerio.load(html);
  const raw = $(SELECTORS.nextData).first().text().trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Detect the AWS WAF JS-challenge interstitial (202 + challenge.js). */
export function isWafChallengeHtml(html: string): boolean {
  return (
    html.includes("AwsWafIntegration") ||
    html.includes("challenge.js") ||
    html.includes("gokuProps") ||
    html.includes('id="challenge-container"')
  );
}

export function textOf($: cheerio.CheerioAPI, selectors: readonly string[]): string | null {
  for (const sel of selectors) {
    const t = $(sel).first().text().trim();
    if (t) return t;
  }
  return null;
}

export function parseIso8601DurationToMinutes(iso: string): number | null {
  // e.g. PT2H22M, PT45M
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  if (!h && !min) return null;
  return h * 60 + min;
}

export function formatMinutes(min: number | null | undefined): string | null {
  if (min == null || !Number.isFinite(min) || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export function extractCastFallback(html: string, limit = 20): CastMember[] {
  const $ = cheerio.load(html);
  const names = $(SELECTORS.castActor).toArray().slice(0, limit);
  const roles = $(SELECTORS.castRole).toArray();
  return names.map((el, i) => {
    const name = $(el).text().trim().replace(/\s+/g, " ");
    const href = $(el).attr("href") ?? "";
    const idm = href.match(/(nm\d{7,10})/i);
    const role = roles[i] ? $(roles[i]).text().trim().replace(/\s+/g, " ") : undefined;
    return { name, role, imdbId: idm ? idm[1]?.toLowerCase() : undefined };
  }).filter((c) => c.name);
}

export function extractReviewsFallback(html: string, limit = 25): Review[] {
  const $ = cheerio.load(html);
  const titles = $(SELECTORS.reviewTitle).toArray();
  const bodies = $(SELECTORS.reviewBody).toArray();
  const n = Math.min(titles.length, bodies.length, limit);
  const out: Review[] = [];
  for (let i = 0; i < n; i++) {
    const title = $(titles[i]).text().trim().replace(/\s+/g, " ");
    const content = $(bodies[i]).text().trim().replace(/\s+/g, " ");
    if (title || content) out.push({ title: title || "Review", content });
  }
  return out;
}

export function extractParentalGuideFallback(html: string): ParentalGuideItem[] {
  const $ = cheerio.load(html);
  const items = $(SELECTORS.parentalItem).toArray();
  const out: ParentalGuideItem[] = [];
  for (const li of items) {
    const type = $(li).find(".ipc-metadata-list-item__label, label").first().text().trim();
    const rate = $(li).find(".ipc-html-content-inner-div").first().text().trim();
    if (type) out.push({ type, rating: rate || "Unknown" });
  }
  return out;
}

/** "tt0111161" from an /title/tt... href. */
export function titleIdFromHref(href: string): string | null {
  const m = href.match(/(tt\d{7,10})/i);
  return m ? (m[1] as string).toLowerCase() : null;
}

export function extractEpisodeIds(html: string, limit = 500): string[] {
  const $ = cheerio.load(html);
  const ids: string[] = [];
  const seen = new Set<string>();
  $(SELECTORS.episodeCard).each((_, el) => {
    if (ids.length >= limit) return false;
    const href = $(el).attr("href") ?? "";
    const id = titleIdFromHref(href);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
    return undefined;
  });
  return ids;
}

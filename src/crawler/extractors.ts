import * as cheerio from "cheerio";
import { SELECTORS } from "../imdb/selectors.js";
import { isImdbOnlyUrl } from "../imdb/guard.js";
import type { AkaEntry, BoxOffice, CastMember, CreditEntry, ParentalGuideItem, Review } from "../imdb/types.js";

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
  keywords?: string;
  actor?: { name?: string; url?: string }[];
  director?: { name?: string }[] | { name?: string };
  creator?: { name?: string }[] | { name?: string };
  author?: { name?: string }[] | { name?: string };
  duration?: string;
  image?: string;
  contentRating?: string;
  trailer?: { embedUrl?: string; name?: string; thumbnail?: { contentUrl?: string } | string } | { embedUrl?: string; name?: string; thumbnail?: { contentUrl?: string } | string }[];
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

/** Detect the AWS WAF JS-challenge interstitial (202 empty shell).
 * Solved IMDb pages ALWAYS embed the WAF SDK (challenge.js) for bot
 * protection — that substring alone is NOT diagnostic and must never flag
 * a page that already carries the rich payload. Only the interstitial
 * markers (challenge-container / gokuProps / Human Verification) count. */
export function isWafChallengeHtml(html: string): boolean {
  if (html.includes("__NEXT_DATA__")) return false;
  if (html.includes('id="challenge-container"')) return true;
  if (html.includes("gokuProps")) return true;
  if (html.includes("<title>Human Verification</title>")) return true;
  if (html.includes("AwsWafIntegration") && html.length < 20000) return true;
  return false;
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

// ---------------------------------------------------------------------------
// Generic __NEXT_DATA__ deep-scan. IMDb's embedded JSON paths rotate, so we
// search by key names instead of hard-coded paths. Returns first hits.
// ---------------------------------------------------------------------------

function walkJson(node: unknown, visit: (key: string, value: unknown) => void, depth = 0): void {
  if (depth > 12 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) walkJson(item, visit, depth + 1);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      visit(k, v);
      walkJson(v, visit, depth + 1);
    }
  }
}

/** Collect values whose key matches `re` (first `limit` hits, deduped). */
export function collectByKey(root: unknown, re: RegExp, limit = 10): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  walkJson(root, (key, value) => {
    if (out.length >= limit) return;
    if (re.test(key) && (typeof value === "string" || typeof value === "number")) {
      const sig = `${key}=${String(value)}`;
      if (!seen.has(sig)) {
        seen.add(sig);
        out.push(value);
      }
    }
  });
  return out;
}

function firstString(root: unknown, res: RegExp[]): string | null {
  for (const re of res) {
    const hits = collectByKey(root, re, 5);
    for (const h of hits) {
      if (typeof h === "string" && h.trim() && h !== "\\N") return h.trim();
    }
  }
  return null;
}

function firstNumber(root: unknown, res: RegExp[]): number | null {
  for (const re of res) {
    const hits = collectByKey(root, re, 5);
    for (const h of hits) {
      const n = typeof h === "number" ? h : Number(String(h).replace(/[^0-9.]/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/** Money, ratings, company, location facts from embedded page JSON. */
export function extractEmbeddedFacts(nextData: Record<string, unknown> | null): {
  budget?: string;
  openingWeekend?: string;
  grossUSA?: string;
  grossWorldwide?: string;
  metascore?: number | null;
  top250Rank?: number | null;
  releaseDate?: string;
  countries?: string[];
  languages?: string[];
  filmingLocations?: string[];
  productionCompanies?: string[];
  tagline?: string;
  awardsSummary?: string;
} {
  if (!nextData) return {};
  const str = (res: RegExp[]): string | undefined => firstString(nextData, res) ?? undefined;
  const num = (res: RegExp[]): number | null => firstNumber(nextData, res);
  return {
    budget: str([/^budget$/i, /productionBudget/i]),
    openingWeekend: str([/openingWeekend/i]),
    grossUSA: str([/^grossUSA$/i, /grossUs/i]),
    grossWorldwide: str([/worldwideGross/i, /^grossWorldwide$/i]),
    metascore: num([/^metascore$/i, /metaScore/i]),
    top250Rank: num([/top250Rank/i, /topRank/i]),
    releaseDate: str([/^releaseDate$/i]),
    tagline: str([/^tagline$/i, /^taglines$/i]),
    awardsSummary: str([/awardsSummary/i, /^awards$/i]),
    countries: collectStringsFor(nextData, [/originCountries/i, /countriesOfOrigin/i, /originCountry/i]),
    languages: collectStringsFor(nextData, [/spokenLanguages/i, /^languages$/i]),
    filmingLocations: collectStringsFor(nextData, [/filmingLocations/i]),
    productionCompanies: collectStringsFor(nextData, [/productionCompanies/i, /companies/i]),
  };
}

function collectStringsFor(root: unknown, res: RegExp[], cap = 8): string[] | undefined {
  const found: string[] = [];
  const seen = new Set<string>();
  walkJson(root, (key, value) => {
    if (found.length >= cap) return;
    if (!res.some((re) => re.test(key))) return;
    const push = (s: string) => {
      const t = s.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        found.push(t);
      }
    };
    if (typeof value === "string") push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") push(item);
        else if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          if (typeof o["name"] === "string") push(o["name"] as string);
          else if (typeof o["text"] === "string") push(o["text"] as string);
        }
      }
    }
  });
  return found.length ? found : undefined;
}

function detailList($: cheerio.CheerioAPI, testid: string): string[] {
  // Value links/items only — never the section label.
  const items = $(`li[data-testid="${testid}"] a, li[data-testid="${testid}"] .ipc-metadata-list-item__list-content-item`)
    .toArray()
    .filter((el) => !$(el).hasClass("ipc-metadata-list-item__label"))
    .map((el) => $(el).text().trim())
    .filter((t) => t && t.length < 120);
  return [...new Set(items)].slice(0, 8);
}

/** Details section DOM fallback (stable data-testid convention). */
export function extractDetailsFallback(html: string): {
  releaseDate?: string;
  countries?: string[];
  languages?: string[];
  filmingLocations?: string[];
  productionCompanies?: string[];
  tagline?: string;
  colorInfo?: string[];
  soundMix?: string[];
} {
  const $ = cheerio.load(html);
  const one = (id: string): string | undefined => {
    const li = $(`li[data-testid="${id}"]`).first();
    li.find(".ipc-metadata-list-item__label").remove();
    const t = li.text().trim().replace(/\s+/g, " ");
    return t || undefined;
  };
  const nz = (arr: string[]): string[] | undefined => (arr.length ? arr : undefined);
  return {
    releaseDate: one("title-details-releasedate"),
    countries: nz(detailList($, "title-details-origin")),
    languages: nz(detailList($, "title-details-languages")),
    filmingLocations: nz(detailList($, "title-details-filminglocations")),
    productionCompanies: nz(detailList($, "title-details-companies")),
    tagline: one("title-details-taglines") ?? textOf($, ['[data-testid="taglines"]'] as unknown as readonly string[]) ?? undefined,
    colorInfo: nz(detailList($, "title-techspec_color")),
    soundMix: nz(detailList($, "title-techspec_soundmix")),
  };
}

/** Box-office DOM fallback (stable title-boxoffice-* testids, verified live).
 * Covers lightweight page variants without embedded GraphQL money facts. */
export function extractBoxOfficeFallback(html: string): {
  budget?: string;
  grossUSA?: string;
  openingWeekend?: string;
  grossWorldwide?: string;
} {
  const $ = cheerio.load(html);
  const money = (id: string): string | undefined => {
    const li = $(`li[data-testid="${id}"]`).first();
    if (!li.length) return undefined;
    li.find(".ipc-metadata-list-item__label").remove();
    const t = li.text().trim().replace(/\s+/g, " ");
    // Keep the leading money token: "$160,000,000 (estimated)" -> "$160,000,000"
    const m = t.match(/([$€£¥₹A-Z]{0,4}\s?[\d,]+)/);
    return m ? (m[1] as string).trim() : t || undefined;
  };
  const out: { budget?: string; grossUSA?: string; openingWeekend?: string; grossWorldwide?: string } = {};
  const b = money("title-boxoffice-budget");
  if (b) out.budget = b;
  const g = money("title-boxoffice-grossdomestic");
  if (g) out.grossUSA = g;
  const o = money("title-boxoffice-openingweekenddomestic");
  if (o) out.openingWeekend = o;
  const w = money("title-boxoffice-cumulativeworldwidegross");
  if (w) out.grossWorldwide = w;
  return out;
}

/**
 * Principal-credits DOM parse: assigns names to Directors / Writers / Stars
 * by reading each block's label (v1 blindly took the first block).
 */
export function extractCreditsDetailed(html: string): {
  directors: string[];
  writers: string[];
  stars: string[];
} {
  const $ = cheerio.load(html);
  const directors: string[] = [];
  const writers: string[] = [];
  const stars: string[] = [];
  $('li[data-testid="title-pc-principal-credit"]').each((_, li) => {
    const label = $(li).find(".ipc-metadata-list-item__label").first().text().trim().toLowerCase();
    const names = $(li)
      .find('a[href*="/name/nm"]')
      .toArray()
      .map((a) => $(a).text().trim().replace(/\s+/g, " "))
      .filter(Boolean);
    const target = label.includes("director")
      ? directors
      : label.includes("writer")
        ? writers
        : label.includes("star") || label.includes("creator")
          ? stars
          : null;
    if (target) for (const n of names) if (!target.includes(n)) target.push(n);
    return undefined;
  });
  return {
    directors: directors.slice(0, 10),
    writers: writers.slice(0, 10),
    stars: stars.slice(0, 20),
  };
}

/**
 * Gallery: collect IMDb-CDN stills/posters. ONLY m.media-amazon.com/images
 * URLs are accepted (IMDb-only rule) — everything else is dropped.
 * Deduplicates by canonical image id (variant suffixes stripped) and drops
 * site chrome (/images/G/, favicons, spinners).
 */
export function canonicalImageId(url: string): string | null {
  const m = url.match(/m\.media-amazon\.com\/images\/M\/([^/.?]+)/i);
  if (m) return (m[1] as string).split(".")[0] as string;
  const g = url.match(/m\.media-amazon\.com\/images\/[^?]*?\/([^/?]+)\.(jpg|jpeg|png|webp)/i);
  return g ? (g[1] as string) : null;
}

export function extractGallery(html: string, limit = 20): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined | null) => {
    if (!raw || out.length >= limit) return;
    let u = raw.trim().replace(/&amp;/g, "&");
    if (u.startsWith("//")) u = `https:${u}`;
    if (!/^https?:\/\//i.test(u)) return;
    if (!isImdbOnlyUrl(u)) return;
    if (!/m\.media-amazon\.com\/images\/M\//i.test(u)) return;
    if (!/\.(jpg|jpeg|png|webp)/i.test(u)) return;
    if (/favicon|spinner|transparent|blank/i.test(u)) return;
    const id = canonicalImageId(u);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(u.split("?")[0] as string);
  };

  const $ = cheerio.load(html);
  $("img").each((_, el) => {
    push($(el).attr("src"));
    const srcset = $(el).attr("srcset") ?? $(el).attr("data-srcset") ?? "";
    for (const part of srcset.split(",")) push(part.trim().split(" ")[0]);
    push($(el).attr("data-src"));
    return undefined;
  });
  // Embedded JSON often holds the richest image list.
  const jsonUrls = html.match(/https?:\\?\/\\?\/m\.media-amazon\.com\\?\/images\\?\/[^"'\\\s]+?\.(?:jpg|jpeg|png|webp)/gi) ?? [];
  for (const j of jsonUrls) push(j.replace(/\\/g, ""));
  return out.slice(0, limit);
}

/** Rich reviews: summary + body + best-effort author/rating/helpfulness. */
export function extractReviewsRich(html: string, limit = 25): Review[] {
  const $ = cheerio.load(html);
  const cards = $('article[data-testid="review-card"], div[data-testid="review-card"], .review-container').toArray();
  const out: Review[] = [];
  const push = (r: Review) => {
    if (out.length < limit && (r.title || r.content)) out.push(r);
  };

  if (cards.length) {
    for (const card of cards) {
      const c = $(card);
      const title = c.find('[data-testid="review-summary"], .title').first().text().trim().replace(/\s+/g, " ");
      const content = c.find('[data-testid="review-content"], .content, .text').first().text().trim().replace(/\s+/g, " ");
      const authorEl = c.find('a[href*="/user/ur"], [data-testid="author"]').first();
      const author = authorEl.text().trim().replace(/\s+/g, " ") || undefined;
      const authorHref = authorEl.attr("href") ?? "";
      const authorId = (authorHref.match(/(ur\d+)/i)?.[1] ?? undefined)?.toLowerCase();
      const ratingMatch = c.text().match(/(\d{1,2})\s*\/\s*10/);
      const date = c.find('[data-testid="review-date"], .review-date').first().text().trim() || undefined;
      push({
        title: title || "Review",
        content,
        author,
        authorId,
        rating: ratingMatch ? Number(ratingMatch[1]) : null,
        date,
      });
    }
    if (out.length) return out;
  }
  // Fallback: parallel summary/body lists (legacy behavior).
  return extractReviewsFallback(html, limit);
}

/** Parental guide with best-effort vote counts + descriptions. */
export function extractParentalGuideRich(html: string): ParentalGuideItem[] {
  const $ = cheerio.load(html);
  const items = $('li[data-testid="rating-item"]').toArray();
  const out: ParentalGuideItem[] = [];
  for (const li of items) {
    const el = $(li);
    const type = el.find(".ipc-metadata-list-item__label, label").first().text().trim();
    const rating = el.find(".ipc-html-content-inner-div").first().text().trim() || "Unknown";
    const allText = el.text();
    const vm = allText.match(/([\d,]+)\s+votes?/i);
    const desc = el
      .find("p, .advisory-severity-vote__description, div:not(.ipc-html-content-inner-div):not(.ipc-metadata-list-item__label)")
      .first()
      .text()
      .trim()
      .slice(0, 300);
    if (type) {
      out.push({
        type,
        rating,
        votes: vm ? Number((vm[1] as string).replace(/,/g, "")) : null,
        description: desc || undefined,
      });
    }
  }
  return out.length ? out : extractParentalGuideFallback(html).map((p) => ({ ...p, votes: null }));
}

export function extractKeywords(html: string, limit = 30): string[] {  const $ = cheerio.load(html);
  const kws = $('[data-testid="storyline-plot-keywords"] a, a[href*="/keyword"]')
    .toArray()
    .map((el) => $(el).text().trim().toLowerCase())
    .filter((t) => t && t.length > 1 && t.length < 40);
  return [...new Set(kws)].slice(0, limit);
}

export function normalizeAkas(rows: { title: string; region?: string; language?: string; types?: string; isOriginal?: boolean }[]): AkaEntry[] {
  return rows.filter((r) => r.title).slice(0, 25);
}

/** Merge review lists, deduping by normalized author+title. */
export function mergeReviews(primary: Review[], extra: Review[], limit = 100): Review[] {
  const seen = new Set<string>();
  const out: Review[] = [];
  const key = (r: Review) => `${(r.author ?? "").toLowerCase()}|${(r.title ?? "").toLowerCase().slice(0, 80)}`;
  for (const r of [...primary, ...extra]) {
    if (out.length >= limit) break;
    const k = key(r);
    if (!r.title && !r.content) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

import type { EpisodeRef, ParentalGuideItem, Review } from "../imdb/types.js";

// ---------------------------------------------------------------------------
// Precise parsers for IMDb's embedded GraphQL payload (__NEXT_DATA__).
// Shapes were reverse-engineered from live imdb.com pages (Oct 2026):
//   title page:    props.pageProps.mainDetails / .aboveTheFoldData
//   reviews page:  props.pageProps.contentData.data.title.reviews.edges[].node
//   guide page:    props.pageProps.contentData.categories[]
//   episodes page: props.pageProps.contentData.section.episodes.items[]
//   taglines page: data.title.taglines.edges[].node.displayableProperty...
//   photos page:   image edges {position, node:{id, caption, height, width, url}}
// Unknown shapes degrade to undefined — never throw, never invent.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

/**
 * Find title nodes. The title page splits facts across `aboveTheFoldData`
 * (plot, ratings, credits) and `mainColumnData` (budget, akas, awards,
 * languages). Aux pages nest under `contentData.data.title`. All candidates
 * are merged (first-wins per key) so no fact source is missed.
 */
export function titleNodes(nextData: unknown): Json[] {
  const root = asObj(nextData);
  const props = asObj(root?.["props"]);
  const pageProps = asObj(props?.["pageProps"]);
  if (!pageProps) return [];
  const out: Json[] = [];
  const push = (v: unknown) => {
    const o = asObj(v);
    if (o && typeof o["id"] === "string" && (o["id"] as string).startsWith("tt")) out.push(o);
  };
  push(pageProps["mainColumnData"]);
  push(pageProps["aboveTheFoldData"]);
  push(pageProps["mainDetails"]);
  const content = asObj(pageProps["contentData"]);
  push(asObj(content?.["data"])?.["title"]);
  push(asObj(pageProps["data"])?.["title"]);
  return out;
}

/** Merged title node: priority order, first-wins per key. */
export function titleNode(nextData: unknown): Json | null {
  const nodes = titleNodes(nextData);
  if (!nodes.length) return null;
  const merged: Json = {};
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n)) {
      if (!(k in merged)) merged[k] = v;
    }
  }
  return merged;
}

function edgeNodes(conn: unknown): Json[] {
  const c = asObj(conn);
  const edges = Array.isArray(c?.["edges"]) ? (c?.["edges"] as unknown[]) : [];
  const out: Json[] = [];
  for (const e of edges) {
    const n = asObj(asObj(e)?.["node"]);
    if (n) out.push(n);
  }
  return out;
}

function plainText(v: unknown): string | undefined {
  const o = asObj(v);
  if (!o) return str(v);
  const val = o["value"];
  return (
    str(o["plainText"]) ??
    str(o["text"]) ??
    (typeof val === "string" ? val.trim() || undefined : undefined) ??
    str(asObj(o["plotText"])?.["plainText"]) ??
    str(asObj(val)?.["plainText"]) ??
    str(asObj(val)?.["text"])
  );
}

export interface ParsedTitle {
  title?: string;
  originalTitle?: string;
  titleTypeId?: string;
  titleTypeText?: string;
  isSeries?: boolean;
  isEpisode?: boolean;
  canHaveEpisodes?: boolean;
  isAdult?: boolean;
  year?: number;
  endYear?: number;
  releaseDate?: string;
  releaseCountry?: string;
  certificate?: string;
  rating?: number;
  votes?: number;
  topRank?: number;
  metascore?: number;
  runtimeSeconds?: number;
  plot?: string;
  genres?: string[];
  keywords?: string[];
  budget?: string;
  openingWeekend?: string;
  grossUSA?: string;
  grossWorldwide?: string;
  countryIds?: string[];
  languages?: string[];
  filmingLocations?: string[];
  companies?: string[];
  akas?: string[];
  awardsSummary?: string;
  directors?: { name: string; id?: string }[];
  writers?: { name: string; id?: string }[];
  creators?: { name: string; id?: string }[];
  stars?: { name: string; id?: string }[];
  cast?: { name: string; id?: string; role?: string }[];
  seasons?: number[];
  seriesYears?: number[];
  poster?: string;
  posterCaption?: string;
  photoCount?: number;
  videoCount?: number;
  reviewCount?: number;
  trailers?: { id: string; name?: string; url?: string; runtimeSeconds?: number }[];
}

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  KRW: "₩",
  INR: "₹",
};

export function formatMoney(amount: unknown, currency: unknown): string | undefined {
  const n = num(amount);
  if (n == null) return undefined;
  const cur = typeof currency === "string" ? currency : "";
  const sym = CURRENCY_SYMBOL[cur] ?? (cur ? `${cur} ` : "");
  return `${sym}${new Intl.NumberFormat("en-US").format(Math.round(n))}`;
}

function moneyOf(node: Json | null | undefined, ...paths: string[][]): string | undefined {
  for (const path of paths) {
    let cur: unknown = node;
    for (const p of path) cur = asObj(cur)?.[p];
    const total = asObj(asObj(cur)?.["total"]);
    const direct = asObj(cur);
    const amount = num(total?.["amount"] ?? direct?.["amount"]);
    const currency = total?.["currency"] ?? direct?.["currency"];
    const formatted = formatMoney(amount, currency);
    if (formatted) return formatted;
  }
  return undefined;
}

/** ISO country id -> English name for common production countries. */
const COUNTRY_NAMES: Record<string, string> = {
  US: "United States", GB: "United Kingdom", CA: "Canada", FR: "France", DE: "Germany",
  IN: "India", JP: "Japan", KR: "South Korea", ES: "Spain", IT: "Italy", AU: "Australia",
  CN: "China", MX: "Mexico", BR: "Brazil", RU: "Russia", SE: "Sweden", NL: "Netherlands",
  BE: "Belgium", CH: "Switzerland", AT: "Austria", IE: "Ireland", NZ: "New Zealand",
  DK: "Denmark", NO: "Norway", FI: "Finland", PL: "Poland", CZ: "Czech Republic",
  HU: "Hungary", GR: "Greece", PT: "Portugal", TR: "Turkey", AR: "Argentina",
  CL: "Chile", CO: "Colombia", ZA: "South Africa", IL: "Israel", HK: "Hong Kong",
  TW: "Taiwan", TH: "Thailand", AE: "United Arab Emirates", UA: "Ukraine",
  RO: "Romania", IS: "Iceland", PH: "Philippines", ID: "Indonesia", MY: "Malaysia",
  SG: "Singapore", PK: "Pakistan", VN: "Vietnam", EG: "Egypt", NG: "Nigeria",
  QA: "Qatar", SA: "Saudi Arabia", LU: "Luxembourg", HR: "Croatia", RS: "Serbia",
  SI: "Slovenia", SK: "Slovakia", BG: "Bulgaria", EE: "Estonia", LV: "Latvia",
  LT: "Lithuania", MT: "Malta", CY: "Cyprus",
};

export function countryName(id: string): string {
  return COUNTRY_NAMES[id] ?? id;
}

export function parseTitleNode(node: Json): ParsedTitle {
  const out: ParsedTitle = {};
  out.title = plainText(asObj(node["titleText"])) ?? str(node["titleText"]);
  out.originalTitle = plainText(asObj(node["originalTitleText"]));
  const tt = asObj(node["titleType"]);
  out.titleTypeId = str(tt?.["id"])?.toLowerCase();
  out.titleTypeText = str(tt?.["text"]);
  // Live titleType often omits boolean flags and only carries
  // {id, canHaveEpisodes}. Derive series-ness from canHaveEpisodes too.
  out.isSeries = tt?.["isSeries"] === true || tt?.["canHaveEpisodes"] === true;
  out.isEpisode = tt?.["isEpisode"] === true;
  out.canHaveEpisodes = tt?.["canHaveEpisodes"] === true;
  if (typeof node["isAdult"] === "boolean") out.isAdult = node["isAdult"] as boolean;

  const ry = asObj(node["releaseYear"]);
  out.year = num(ry?.["year"]) ?? undefined;
  const endYear = num(ry?.["endYear"]);
  if (endYear) out.endYear = endYear;

  const rd = asObj(node["releaseDate"]);
  if (rd && num(rd["year"])) {
    const y = num(rd["year"]) as number;
    const m = num(rd["month"]) ?? 1;
    const d = num(rd["day"]) ?? 1;
    out.releaseDate = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    out.releaseCountry = str(asObj(rd["country"])?.["text"]);
  }

  out.certificate = str(asObj(node["certificate"])?.["rating"]);

  const rs = asObj(node["ratingsSummary"]);
  out.rating = num(rs?.["aggregateRating"]) ?? undefined;
  out.votes = num(rs?.["voteCount"]) ?? undefined;
  const tr = asObj(rs?.["topRanking"]);
  if (tr && num(tr["rank"])) out.topRank = num(tr["rank"]);

  const mc = asObj(asObj(node["metacritic"])?.["metascore"]);
  out.metascore = num(mc?.["score"]) ?? undefined;

  const rt = asObj(node["runtime"]);
  const secs = num(rt?.["seconds"]);
  if (secs) out.runtimeSeconds = secs;

  out.plot = plainText(asObj(node["plot"])) ?? plainText(asObj(node["plotText"]));

  const genres = asObj(node["genres"]) ?? asObj(node["titleGenres"]);
  const gList = Array.isArray(genres?.["genres"]) ? (genres?.["genres"] as unknown[]) : [];
  const gNames = gList
    .map((g) => str(asObj(g)?.["text"]) ?? str(asObj(asObj(g)?.["genre"])?.["text"]))
    .filter((g): g is string => !!g);
  if (gNames.length) out.genres = [...new Set(gNames)];

  out.keywords = edgeNodes(node["keywords"])
    .map((n) => str(n["text"]))
    .filter((k): k is string => !!k)
    .slice(0, 30);
  if (!out.keywords.length) delete out.keywords;

  const pb = asObj(node["productionBudget"]);
  out.budget = moneyOf(pb ? { root: pb } : null, ["root", "budget"]) ?? moneyOf(node, ["productionBudget", "budget"]);
  out.grossWorldwide = moneyOf(node, ["lifetimeGross", "total"]);
  out.openingWeekend = moneyOf(node, ["openingWeekendGross", "gross", "total"]);

  const coo = asObj(node["countriesOfOrigin"]);
  const countries = Array.isArray(coo?.["countries"]) ? (coo?.["countries"] as unknown[]) : [];
  const ids = countries.map((c) => str(asObj(c)?.["id"])).filter((c): c is string => !!c);
  if (ids.length) out.countryIds = [...new Set(ids)];

  const sl = asObj(node["spokenLanguages"]);
  const langs = Array.isArray(sl?.["spokenLanguages"]) ? (sl?.["spokenLanguages"] as unknown[]) : [];
  const langNames = langs.map((l) => str(asObj(l)?.["text"])).filter((l): l is string => !!l);
  if (langNames.length) out.languages = [...new Set(langNames)];

  out.filmingLocations = edgeNodes(node["filmingLocations"])
    .map((n) => str(n["text"]) ?? str(n["location"]))
    .filter((x): x is string => !!x)
    .slice(0, 10);
  if (!out.filmingLocations.length) delete out.filmingLocations;

  // Company credits live behind a separate fullcredits connection; the Details
  // section DOM fallback (extractDetailsFallback) covers names precisely.

  out.akas = edgeNodes(node["akas"])
    .map((n) => str(n["text"]))
    .filter((x): x is string => !!x)
    .slice(0, 25);
  if (!out.akas.length) delete out.akas;

  // Principal credits grouped by department (three shapes across pages:
  // principalCreditsV2 with grouping.text, principalCredits with
  // category.text, or crewV2 with grouping.text). The /reference/ variant
  // omits grouping.text and only carries groupingId UUIDs, so known IMDb
  // category UUIDs are mapped as well (observed live Oct 2026).
  const DIRECTOR_GROUP_IDS = new Set([
    "amzn1.imdb.concept.name_credit_category.ace5cb4c-8708-4238-9542-04641e7c8171",
  ]);
  const WRITER_GROUP_IDS = new Set([
    "amzn1.imdb.concept.name_credit_category.c84ecaff-add5-4f2e-81db-102a41881fe3",
  ]);
  const groupsV2 = (Array.isArray(node["principalCreditsV2"]) ? (node["principalCreditsV2"] as unknown[]) : [])
    .map(asObj)
    .filter((g): g is Json => !!g);
  const groupsV1 = (Array.isArray(node["principalCredits"]) ? (node["principalCredits"] as unknown[]) : [])
    .map(asObj)
    .filter((g): g is Json => !!g);
  const groupsCrew = (Array.isArray(node["crewV2"]) ? (node["crewV2"] as unknown[]) : [])
    .map(asObj)
    .filter((g): g is Json => !!g);
  const groupLabel = (g: Json): { text: string; gid: string } => {
    const grouping = asObj(g["grouping"]);
    const category = asObj(g["category"]);
    return {
      text: (str(grouping?.["text"]) ?? str(category?.["text"]) ?? "").toLowerCase(),
      gid: str(grouping?.["groupingId"]) ?? str(category?.["id"]) ?? "",
    };
  };
  const labelMatches = (label: string, gid: string, names: string[]): boolean => {
    if (names.some((n) => label.includes(n))) return true;
    if (names.includes("director") && DIRECTOR_GROUP_IDS.has(gid)) return true;
    if (names.includes("writer") && WRITER_GROUP_IDS.has(gid)) return true;
    return false;
  };
  const byGroup = (names: string[]): { name: string; id?: string }[] => {
    const outG: { name: string; id?: string }[] = [];
    const pull = (label: string, gid: string, credits: unknown) => {
      if (!labelMatches(label, gid, names)) return;
      const list = Array.isArray(credits) ? credits : [];
      for (const c of list) {
        const name = asObj(asObj(c)?.["name"]);
        const nm = str(asObj(name?.["nameText"])?.["text"]);
        const nid = str(name?.["id"])?.toLowerCase();
        if (nm && !outG.some((e) => e.name === nm)) outG.push({ name: nm, id: nid });
      }
    };
    for (const g of groupsV2) {
      const { text, gid } = groupLabel(g);
      pull(text, gid, g["credits"]);
    }
    for (const g of groupsV1) {
      const { text, gid } = groupLabel(g);
      pull(text, gid, g["credits"]);
    }
    // crewV2 carries Director/Writer groups with text on the title page
    // (first-wins merge keeps node0's copy) — same matching rules.
    for (const g of groupsCrew) {
      const { text, gid } = groupLabel(g);
      pull(text, gid, g["credits"]);
    }
    return outG;
  };
  out.directors = byGroup(["director"]);
  out.writers = byGroup(["writer"]);
  out.creators = byGroup(["creator"]);
  const stars = byGroup(["star", "cast"]);
  if (stars.length) out.stars = stars.slice(0, 20);

  // Awards: authoritative win/nomination counts.
  const wins = num(asObj(node["wins"])?.["total"]);
  const noms = num(asObj(node["nominationsExcludeWins"])?.["total"]);
  if (wins != null || noms != null) {
    const parts: string[] = [];
    if (wins != null) parts.push(`${wins} wins`);
    if (noms != null) parts.push(`${noms} nominations`);
    const pa = asObj(node["prestigiousAwardSummary"]);
    const paWins = num(pa?.["wins"]);
    const paNoms = num(pa?.["nominations"]);
    if (pa && (paWins != null || paNoms != null)) {
      const awardName = str(asObj(pa["award"])?.["text"]) ?? "major awards";
      const bits: string[] = [];
      if (paWins != null) bits.push(`${paWins} wins`);
      if (paNoms != null) bits.push(`${paNoms} nominations`);
      if (bits.length) parts.push(`${awardName}: ${bits.join(", ")}`);
    }
    if (parts.length) out.awardsSummary = parts.join(" & ");
  }

  // castV2 (top-billed, authoritative ids).
  const castV2 = Array.isArray(node["castV2"]) ? (node["castV2"] as unknown[]) : [];
  const cast: { name: string; id?: string }[] = [];
  for (const grp of castV2) {
    const credits = Array.isArray(asObj(grp)?.["credits"]) ? (asObj(grp)?.["credits"] as unknown[]) : [];
    for (const c of credits) {
      const name = asObj(asObj(c)?.["name"]);
      const nm = str(asObj(name?.["nameText"])?.["text"]);
      const nid = str(name?.["id"])?.toLowerCase();
      if (nm) cast.push({ name: nm, id: nid });
      if (cast.length >= 20) break;
    }
  }
  if (cast.length) out.cast = cast;

  // Series structure (seasons/years) is parsed by parseSeriesStructure().

  const pi = asObj(node["primaryImage"]);
  const posterUrl = str(pi?.["url"]);
  if (posterUrl) {
    out.poster = posterUrl;
    out.posterCaption = plainText(asObj(pi?.["caption"]));
  }
  const images = asObj(node["images"]);
  if (num(images?.["total"])) out.photoCount = num(images?.["total"]);
  const videos = asObj(node["videos"]);
  if (num(videos?.["total"])) out.videoCount = num(videos?.["total"]);
  const reviews = asObj(node["reviews"]);
  if (num(reviews?.["total"])) out.reviewCount = num(reviews?.["total"]);

  const pv = asObj(node["primaryVideos"]);
  const trailers = edgeNodes(pv)
    .map((n) => {
      const id = str(n["id"]);
      if (!id || !id.startsWith("vi")) return null;
      return {
        id,
        name: plainText(asObj(n["name"])) ?? str(n["name"]),
        url: `https://www.imdb.com/video/${id}/`,
        runtimeSeconds: num(asObj(n["runtime"])?.["value"]) ?? undefined,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .slice(0, 5);
  if (trailers.length) out.trailers = trailers;

  return out;
}

/** Seasons/years declared on a series title node. */
export function parseSeriesStructure(node: Json): { seasons: number[]; years: number[]; episodeTotal?: number } {
  // Seasons nest under node.episodes ({episodes:{total}, seasons[], years[]}).
  const epSection = asObj(node["episodes"]);
  const seasonsRaw = (Array.isArray(node["seasons"]) ? (node["seasons"] as unknown[]) : []).concat(
    Array.isArray(epSection?.["seasons"]) ? (epSection?.["seasons"] as unknown[]) : [],
  );
  const seasons = [...new Set(
    seasonsRaw
      .map((s) => num(asObj(s)?.["number"]))
      .filter((n): n is number => n != null),
  )].sort((a, b) => a - b);
  const yearsRaw = (Array.isArray(node["years"]) ? (node["years"] as unknown[]) : []).concat(
    Array.isArray(epSection?.["years"]) ? (epSection?.["years"] as unknown[]) : [],
  );
  const years = [...new Set(
    yearsRaw
      .map((y) => num(asObj(y)?.["year"]))
      .filter((n): n is number => n != null),
  )].sort((a, b) => a - b);
  const total = num(asObj(epSection?.["episodes"])?.["total"]);
  return { seasons, years, episodeTotal: total };
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plaidText(v: unknown): string | undefined {
  const o = asObj(v);
  if (!o) return str(v);
  const raw = str(o["plaidHtml"]) ?? str(o["plainText"]) ?? str(o["text"]);
  if (!raw) return undefined;
  return htmlToText(raw) || undefined;
}

/** Precise review nodes from the reviews page payload. */
export function parseReviewNodes(nextData: unknown, limit = 25): Review[] {
  const root = asObj(nextData);
  const props = asObj(root?.["props"]);
  const pageProps = asObj(props?.["pageProps"]);
  const content = asObj(pageProps?.["contentData"]);
  const data = asObj(content?.["data"]);
  const title = asObj(data?.["title"]);
  const reviews = asObj(title?.["reviews"]);
  const nodes = edgeNodes(reviews).slice(0, limit);
  const out: Review[] = [];
  for (const n of nodes) {
    const author = asObj(n["author"]);
    const titleText = str(asObj(n["summary"])?.["originalText"]);
    const contentText = plaidText(asObj(n["text"])?.["originalText"]);
    if (!titleText && !contentText) continue;
    const helpful = asObj(n["helpfulness"]);
    out.push({
      title: titleText || "Review",
      content: contentText || "",
      author: str(asObj(author?.["username"])?.["text"]),
      authorId: str(author?.["userId"])?.toLowerCase(),
      rating: num(n["authorRating"]) ?? null,
      date: str(n["submissionDate"]),
      helpful: num(helpful?.["upVotes"]) ?? null,
    });
  }
  return out;
}

export function reviewTotal(nextData: unknown): number | undefined {
  const root = asObj(nextData);
  const props = asObj(root?.["props"]);
  const pageProps = asObj(props?.["pageProps"]);
  const content = asObj(pageProps?.["contentData"]);
  const data = asObj(content?.["data"]);
  const title = asObj(data?.["title"]);
  return num(asObj(title?.["reviews"])?.["total"]) ?? undefined;
}

/** Precise parental-guide categories from the guide page payload. */
export function parseGuideCategories(nextData: unknown): ParentalGuideItem[] {
  const root = asObj(nextData);
  const pageProps = asObj(asObj(root?.["props"])?.["pageProps"]);
  const content = asObj(pageProps?.["contentData"]);
  const cats = Array.isArray(content?.["categories"]) ? (content?.["categories"] as unknown[]) : [];
  const out: ParentalGuideItem[] = [];
  for (const c of cats) {
    const cat = asObj(c);
    if (!cat) continue;
    const type = str(cat["title"]);
    if (!type) continue;
    const summary = asObj(cat["severitySummary"]);
    const breakdownRaw = Array.isArray(cat["severityBreakdown"]) ? (cat["severityBreakdown"] as unknown[]) : [];
    const breakdown = breakdownRaw
      .map((b) => {
        const bo = asObj(b);
        const r = str(bo?.["text"]);
        const v = num(bo?.["votes"]);
        return r ? { rating: r, votes: v ?? 0 } : null;
      })
      .filter((x): x is { rating: string; votes: number } => !!x);
    const itemsRaw = Array.isArray(cat["items"]) ? (cat["items"] as unknown[]) : [];
    const details = itemsRaw
      .slice(0, 8)
      .map((it) => {
        const io = asObj(it);
        const text = str(io?.["text"]) ?? plaidText(asObj(io?.["machineTranslatedText"])?.["value"]);
        if (!text) return null;
        return { text, spoiler: io?.["isSpoiler"] === true };
      })
      .filter((x): x is { text: string; spoiler: boolean } => !!x);
    out.push({
      type,
      rating: str(summary?.["text"]) ?? "Unknown",
      votes: num(summary?.["votes"]) ?? null,
      totalVotes: num(cat["totalSeverityVotes"]) ?? null,
      breakdown: breakdown.length ? breakdown : undefined,
      description: details[0]?.spoiler === false ? details[0]?.text : details[0]?.text,
      details: details.length ? details : undefined,
    });
  }
  return out;
}

/** Precise episode items from the episodes page payload. */
export function parseEpisodeItems(nextData: unknown, limit = 500): EpisodeRef[] {
  const root = asObj(nextData);
  const pageProps = asObj(asObj(root?.["props"])?.["pageProps"]);
  const content = asObj(pageProps?.["contentData"]);
  const section = asObj(content?.["section"]);
  const epConn = asObj(section)?.["episodes"];
  const list: unknown[] = Array.isArray(asObj(epConn)?.["items"])
    ? (asObj(epConn)?.["items"] as unknown[])
    : [];
  const out: EpisodeRef[] = [];
  for (const it of list.slice(0, limit)) {
    const e = asObj(it);
    if (!e) continue;
    const id = str(e["id"])?.toLowerCase();
    if (!id || !id.startsWith("tt")) continue;
    const rd = asObj(e["releaseDate"]);
    const airDate =
      rd && num(rd["year"])
        ? `${num(rd["year"])}-${String(num(rd["month"]) ?? 1).padStart(2, "0")}-${String(num(rd["day"]) ?? 1).padStart(2, "0")}`
        : undefined;
    out.push({
      imdbId: id,
      season: num(e["season"]) ?? null,
      episode: num(e["episode"]) ?? null,
      title: str(e["titleText"]),
      airDate,
      rating: e["aggregateRating"] != null ? String(e["aggregateRating"]) : null,
      votes: num(e["voteCount"]) ?? null,
      poster: str(asObj(e["image"])?.["url"]),
      plot: (str(e["plot"]) ?? "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&") || undefined,
    });
  }
  return out;
}

/** Taglines from the taglines page payload. */
export function parseTaglines(nextData: unknown, limit = 10): string[] {
  const root = asObj(nextData);
  const pageProps = asObj(asObj(root?.["props"])?.["pageProps"]);
  const fromContent = asObj(asObj(asObj(pageProps?.["contentData"])?.["data"])?.["title"])?.["taglines"];
  const fromData = asObj(asObj(asObj(pageProps?.["data"])?.["title"])?.["taglines"]);
  const out: string[] = [];
  for (const n of edgeNodes(fromContent ?? fromData).slice(0, limit)) {
    const t = plaidText(asObj(asObj(n["displayableProperty"])?.["value"])) ?? plaidText(n["displayableProperty"]);
    if (t) out.push(t);
  }
  return out;
}

/** Gallery stills from the photos page payload (IMDb CDN only). */
export function parseGalleryNodes(nextData: unknown, limit = 20): { url: string; caption?: string }[] {
  const root = asObj(nextData);
  const pageProps = asObj(asObj(root?.["props"])?.["pageProps"]);
  const data = asObj(pageProps?.["data"]) ?? asObj(asObj(pageProps?.["contentData"])?.["data"]);
  const title = asObj(data?.["title"]) ?? titleNode(nextData);
  const seen = new Set<string>();
  const out: { url: string; caption?: string }[] = [];
  const collect = (conn: unknown) => {
    for (const n of edgeNodes(conn)) {
      if (out.length >= limit) break;
      const url = str(n["url"]);
      if (!url || !/m\.media-amazon\.com\/images/i.test(url)) continue;
      const base = url.split("?")[0] as string;
      if (seen.has(base)) continue;
      seen.add(base);
      const cap = asObj(n["caption"]);
      out.push({ url: base, caption: str(cap?.["plainText"]) ?? str(n["caption"]) });
    }
  };
  collect(title?.["images"]);
  // Live /mediaindex/ payload nests stills under `all_images` (Oct 2026);
  // the title page exposes hero stills under `titleMainImages`. Collect all.
  collect(title?.["all_images"]);
  collect(title?.["titleMainImages"]);
  const gall = asObj(asObj(asObj(asObj(root?.["props"])?.["pageProps"])?.["contentData"])?.["section"])?.["images"];
  if (gall) collect(gall);
  return out;
}

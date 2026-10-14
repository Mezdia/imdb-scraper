import { describe, it, expect } from "vitest";
import type { TitleRecord } from "../src/imdb/types.js";
import {
  ArchiveClient,
  expandArchiveCandidates,
  extractArchiveGallery,
  isArchiveErrorPage,
  isTitleJsonLd,
  mergeArchiveIntoRecord,
  pickLatestCdxTimestamp,
  pickRecentCdxTimestamps,
  scoreArchiveRichness,
  snapshotLabel,
} from "../src/archive/archiveClient.js";
import { needsArchiveFallback } from "../src/archive/archiveTypes.js";

function baseRecord(): TitleRecord {
  return {
    imdbId: "tt0111161",
    url: "https://www.imdb.com/title/tt0111161/",
    title: "tt0111161",
    kind: "unknown",
    year: null,
    date: null,
    rating: null,
    votes: null,
    description: null,
    plot: null,
    poster: null,
    gallery: null,
    missing: ["page-html (WAF-blocked, partial record from datasets)", "title", "rating"],
    scrapedAt: new Date().toISOString(),
    provenance: ["datasets:title.basics"],
  };
}

const MOVIE_SNAPSHOT_HTML = `<html><head>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"aboveTheFoldData":{"id":"tt0111161","titleText":{"text":"The Shawshank Redemption"},"titleType":{"id":"movie"},"releaseYear":{"year":1994},"ratingsSummary":{"aggregateRating":9.3,"voteCount":2800000},"genres":{"genres":[{"text":"Drama"}]},"plot":{"plotText":{"plainText":"Imprisoned for a crime he did not commit."}},"primaryImage":{"url":"https://m.media-amazon.com/images/M/MV5B_test123.jpg"}}}}}</script>
<script type="application/ld+json">{"@type":"Movie","name":"The Shawshank Redemption","datePublished":"1994-09-23","genre":["Drama"],"description":"Imprisoned for a crime he did not commit."}</script>
</head><body><h1>The Shawshank Redemption</h1><img src="https://m.media-amazon.com/images/M/MV5B_test123.jpg"/></body></html>`;

const SERIES_FRAGMENT_HTML = `<html><head>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"aboveTheFoldData":{"id":"tt0903747","titleText":{"text":"Breaking Bad"},"titleType":{"id":"tvSeries","canHaveEpisodes":true},"releaseYear":{"year":2008,"endYear":2013},"ratingsSummary":{"aggregateRating":9.5,"voteCount":1900000},"genres":{"genres":[{"text":"Crime"}]},"plot":{"plotText":{"plainText":"A chemistry teacher turns meth cook."}}}}}}</script>
</head><body><h1>Breaking Bad</h1></body></html>`;

const WAYBACK_MISS_HTML = `<html><head><title>Wayback Machine</title></head><body><h1>Wayback Machine has not archived that URL</h1><p>No captures found for this URL</p></body></html>`;

describe("archive client (BETA, offline)", () => {
  it("scores archived richness: gql=2, miss=-1", () => {
    expect(scoreArchiveRichness(MOVIE_SNAPSHOT_HTML)).toBe(2);
    expect(scoreArchiveRichness(SERIES_FRAGMENT_HTML)).toBe(2);
    expect(scoreArchiveRichness(WAYBACK_MISS_HTML)).toBe(-1);
    expect(scoreArchiveRichness("")).toBe(-1);
  });

  it("extracts IMDb-CDN gallery incl. Wayback-rewritten URLs", () => {
    const html = `<img src="https://web.archive.org/web/20240101im_/https://m.media-amazon.com/images/M/MV5B_rewritten.jpg"/><img src="https://web.archive.org/web/20240101im_/https://example.com/evil.jpg"/>`;
    const out = extractArchiveGallery(html, 10);
    expect(out.some((u) => u.includes("m.media-amazon.com"))).toBe(true);
    expect(out.some((u) => u.includes("example.com"))).toBe(false);
  });

  it("merges a movie snapshot: fills gaps + provenance + archivedAt", () => {
    const base = baseRecord();
    const merged = mergeArchiveIntoRecord(
      base,
      MOVIE_SNAPSHOT_HTML,
      "https://web.archive.org/web/20240101120000id_/https://www.imdb.com/title/tt0111161/",
      "20240101120000",
    );
    expect(merged.title).toBe("The Shawshank Redemption");
    expect(merged.rating).toBe("9.3");
    expect(merged.votes).toBe(2800000);
    expect(merged.poster).toContain("m.media-amazon.com");
    expect(merged.archivedAt).toBe("20240101120000");
    expect(merged.archiveUrl).toContain("web.archive.org");
    expect(merged.provenance.some((p) => p.startsWith("archive:20240101120000:"))).toBe(true);
    expect(merged.missing?.some((m) => m.includes("page-html"))).toBe(false);
  });

  it("merges kind/titleType/akas/isAdult from GQL (live Oct 2026 shapes)", async () => {
    const { parseArchiveTitle } = await import("../src/archive/archiveClient.js");
    const html = `<html><head><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"aboveTheFoldData":{"id":"tt0111161","titleText":{"text":"The Shawshank Redemption"},"titleType":{"id":"movie"},"isAdult":false,"releaseYear":{"year":1994},"akas":{"edges":[{"node":{"text":"Les Evades"}}]},"principalCredits":[{"category":{"text":"Director"},"credits":[{"name":{"nameText":{"text":"Frank Darabont"},"id":"nm0001104"}}]}]}}}}</script></head></html>`;
    const patch = parseArchiveTitle(html);
    expect(patch.kind).toBe("movie");
    expect(patch.titleType).toBe("movie");
    expect(patch.isAdult).toBe(false);
    expect(patch.akas).toEqual([{ title: "Les Evades" }]);
    const merged = mergeArchiveIntoRecord(
      baseRecord(),
      html,
      "https://web.archive.org/web/20240101120000id_/https://www.imdb.com/title/tt0111161/",
      "20240101120000",
    );
    expect(merged.kind).toBe("movie");
    expect(merged.titleType).toBe("movie");
    expect(merged.akas).toEqual([{ title: "Les Evades" }]);
    expect(merged.missing?.includes("kind")).toBe(false);
  });

  it("keeps honest missing[] for subpages the snapshot cannot recover", () => {
    const base: TitleRecord = {
      ...baseRecord(),
      reviews: null,
      parentsGuide: null,
    };
    const merged = mergeArchiveIntoRecord(
      base,
      MOVIE_SNAPSHOT_HTML,
      "https://web.archive.org/web/20240101120000id_/https://www.imdb.com/title/tt0111161/",
      "20240101120000",
    );
    // Title fields recovered, but reviews/guide/tagline subpages were never fetched.
    expect(merged.missing?.some((m) => m.includes("page-html"))).toBe(false);
    expect(merged.missing).toContain("reviews");
    expect(merged.missing).toContain("parentsGuide");
    expect(merged.missing).toContain("tagline");
  });

  it("merges a series fragment", () => {
    const base: TitleRecord = {
      ...baseRecord(),
      imdbId: "tt0903747",
      url: "https://www.imdb.com/title/tt0903747/",
    };
    const merged = mergeArchiveIntoRecord(
      base,
      SERIES_FRAGMENT_HTML,
      "https://web.archive.org/web/20240202120000id_/https://www.imdb.com/title/tt0903747/",
      "20240202120000",
    );
    expect(merged.title).toBe("Breaking Bad");
    expect(merged.year).toBe("2008");
  });

  it("flag-OFF performs zero archive I/O", async () => {
    const client = new ArchiveClient({ enabled: false, timestamp: "latest" });
    let calls = 0;
    const out = await client.enhance(baseRecord(), ["https://www.imdb.com/title/tt0111161/"], async () => {
      calls++;
      throw new Error("must not fetch when disabled");
    });
    expect(calls).toBe(0);
    expect(out.title).toBe("tt0111161");
    expect(needsArchiveFallback(out)).toBe(true);
  });

  it("flag-ON merges the richest snapshot (mocked fetch, no network)", async () => {
    const client = new ArchiveClient({ enabled: true, timestamp: "latest" });
    const out = await client.enhance(
      baseRecord(),
      ["https://www.imdb.com/title/tt0111161/"],
      async (imdbUrl) => ({
        html: MOVIE_SNAPSHOT_HTML,
        archiveUrl: `https://web.archive.org/web/2id_/${imdbUrl}`,
        finalUrl: "https://web.archive.org/web/20240101120000id_/https://www.imdb.com/title/tt0111161/",
        snapshotTimestamp: "20240101120000",
        originalImdbUrl: imdbUrl,
      }),
    );
    expect(out.title).toBe("The Shawshank Redemption");
    expect((out as { archiveUrl: string | null }).archiveUrl).toContain("web.archive.org");
  });

  it("flag-ON with unusable snapshot returns base untouched", async () => {
    const client = new ArchiveClient({ enabled: true, timestamp: "latest" });
    const base = baseRecord();
    const out = await client.enhance(base, ["https://www.imdb.com/title/tt0111161/"], async () => null);
    expect(out).toEqual(base);
  });

  it("skips archive when live record is already complete", async () => {
    const client = new ArchiveClient({ enabled: true, timestamp: "latest" });
    const complete: TitleRecord = { ...baseRecord(), missing: [] };
    let calls = 0;
    const out = await client.enhance(complete, ["https://www.imdb.com/title/tt0111161/"], async () => {
      calls++;
      return null;
    });
    expect(calls).toBe(0);
    expect(out).toEqual(complete);
  });

  it("picks the newest CDX timestamp (late-2026 aware)", () => {
    const payload = [
      ["timestamp", "original", "statuscode", "mimetype"],
      ["20240101120000", "https://www.imdb.com/title/tt0111161/", "200", "text/html"],
      ["20261001120000", "https://www.imdb.com/title/tt0111161/", "200", "text/html"],
      ["20260915080000", "https://www.imdb.com/title/tt0111161/", "200", "text/html"],
    ];
    expect(pickLatestCdxTimestamp(payload)).toBe("20261001120000");
    expect(pickLatestCdxTimestamp([["timestamp"]])).toBeNull();
    expect(pickLatestCdxTimestamp([])).toBeNull();
    expect(pickLatestCdxTimestamp(null)).toBeNull();
  });

  it("auto-resolves latest snapshot URL via mocked CDX (no network)", async () => {
    const client = new ArchiveClient({ enabled: true, timestamp: "latest" });
    const cdxPayload = [
      ["timestamp", "original", "statuscode", "mimetype"],
      ["20240101120000", "https://www.imdb.com/title/tt0111161/", "200", "text/html"],
      ["20261001120000", "https://www.imdb.com/title/tt0111161/", "200", "text/html"],
    ];
    const cdxFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => cdxPayload,
    })) as unknown as typeof fetch;
    const url = await client.resolveSnapshotUrl("https://www.imdb.com/title/tt0111161/", cdxFetch);
    expect(url).toBe(
      "https://web.archive.org/web/20261001120000id_/https://www.imdb.com/title/tt0111161/",
    );
  });

  it("falls back to redirect URL when CDX is empty/unreachable", async () => {
    const client = new ArchiveClient({ enabled: true, timestamp: "latest" });
    const emptyFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    })) as unknown as typeof fetch;
    expect(await client.resolveSnapshotUrl("https://www.imdb.com/title/tt0111161/", emptyFetch)).toBe(
      "https://web.archive.org/web/2id_/https://www.imdb.com/title/tt0111161/",
    );
    const failFetch = (async () => {
      throw new Error("cdx down");
    }) as unknown as typeof fetch;
    expect(await client.resolveSnapshotUrl("https://www.imdb.com/title/tt0111161/", failFetch)).toBe(
      "https://web.archive.org/web/2id_/https://www.imdb.com/title/tt0111161/",
    );
  });

  it("explicit timestamp skips CDX entirely (zero CDX I/O)", async () => {
    const client = new ArchiveClient({ enabled: true, timestamp: "20250102030405" });
    let calls = 0;
    const counting = (async (u: unknown) => {
      calls++;
      throw new Error(`must not call CDX: ${String(u)}`);
    }) as unknown as typeof fetch;
    const url = await client.resolveSnapshotUrl("https://www.imdb.com/title/tt0111161/", counting);
    expect(url).toBe(
      "https://web.archive.org/web/20250102030405id_/https://www.imdb.com/title/tt0111161/",
    );
    expect(calls).toBe(0);
  });

  it("flag-OFF resolve performs zero I/O", async () => {
    const client = new ArchiveClient({ enabled: false, timestamp: "latest" });
    let calls = 0;
    const counting = (async () => {
      calls++;
      throw new Error("must not fetch when disabled");
    }) as unknown as typeof fetch;
    expect(await client.resolveLatestTimestamp("https://www.imdb.com/title/tt0111161/", counting)).toBeNull();
    expect(calls).toBe(0);
  });

  // --- Live-verified Oct 2026 hardening (real web.archive.org probes) ------

  // Wayback replays IMDb's own 404 page for unknown ids (tt9999999):
  // ~78KB, HTTP 404, WITH __NEXT_DATA__ but no title node. It must score -1
  // so "404 Error" never becomes the merged record title.
  const NOT_FOUND_HTML = `<html><head><title>404 Error - IMDb</title></head><body>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"errorCode":404}}}</script>
<h1>404 Error</h1></body></html>`;

  const NEXT_WITHOUT_TITLE_HTML = `<html><head><title>IMDb</title></head><body>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"aboveTheFoldData":{"id":"not-a-title"}}}}</script>
</body></html>`;

  const WEBSITE_LD_HTML = `<html><head><title>Some Page</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"IMDb","url":"https://www.imdb.com/"}</script>
</head><body></body></html>`;

  const MOVIE_LD_ONLY_HTML = `<html><head><title>The Shawshank Redemption (1994) - IMDb</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Movie","name":"The Shawshank Redemption","datePublished":"1994-10-14","description":"Hope.","aggregateRating":{"ratingValue":9.3,"ratingCount":100}}</script>
</head><body></body></html>`;

  it("rejects IMDb 404/error pages even with NEXT_DATA", () => {
    expect(isArchiveErrorPage(NOT_FOUND_HTML)).toBe(true);
    expect(scoreArchiveRichness(NOT_FOUND_HTML)).toBe(-1);
    expect(isArchiveErrorPage(MOVIE_SNAPSHOT_HTML)).toBe(false);
  });

  it("rejects NEXT_DATA without a title node (not a title page)", () => {
    expect(scoreArchiveRichness(NEXT_WITHOUT_TITLE_HTML)).toBe(-1);
  });

  it("ignores site-chrome JSON-LD, accepts title-shaped JSON-LD", () => {
    expect(isTitleJsonLd({ "@type": "WebSite", name: "IMDb" })).toBe(false);
    expect(isTitleJsonLd({ "@type": "Movie", name: "X" })).toBe(true);
    expect(isTitleJsonLd({ name: "X", description: "Y" })).toBe(true);
    expect(isTitleJsonLd({ name: "X" })).toBe(false);
    expect(scoreArchiveRichness(WEBSITE_LD_HTML)).toBe(-1);
    expect(scoreArchiveRichness(MOVIE_LD_ONLY_HTML)).toBe(0);
  });

  it("never takes error chrome as the DOM title", async () => {
    const { parseArchiveTitle } = await import("../src/archive/archiveClient.js");
    const patch = parseArchiveTitle(NOT_FOUND_HTML);
    expect(patch.title).toBeUndefined();
    const site = parseArchiveTitle(WEBSITE_LD_HTML);
    expect(site.title).not.toBe("IMDb");
  });

  it("merges posterCaption from the snapshot", async () => {
    const { parseArchiveTitle } = await import("../src/archive/archiveClient.js");
    const html = `<html><head><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"aboveTheFoldData":{"id":"tt0111161","titleText":{"text":"The Shawshank Redemption"},"titleType":{"id":"movie"},"primaryImage":{"url":"https://m.media-amazon.com/images/M/MV5B_test999.jpg","caption":{"plainText":"Tim Robbins in prison"}}}}}}</script></head></html>`;
    expect(parseArchiveTitle(html).posterCaption).toBe("Tim Robbins in prison");
    const merged = mergeArchiveIntoRecord(
      baseRecord(),
      html,
      "https://web.archive.org/web/20240101120000id_/https://www.imdb.com/title/tt0111161/",
      "20240101120000",
    );
    expect(merged.poster).toContain("m.media-amazon.com");
    expect(merged.posterCaption).toBe("Tim Robbins in prison");
  });

  it("dedupes gallery crops of the same frame by canonical id", () => {
    const poster = "https://m.media-amazon.com/images/M/MV5BMDAyY2FhYjctNDc5OS00MDNlLThiMGUtY2UxYWVkNGY2ZjljXkEyXkFqcGc@._V1_.jpg";
    const crop = "https://m.media-amazon.com/images/M/MV5BMDAyY2FhYjctNDc5OS00MDNlLThiMGUtY2UxYWVkNGY2ZjljXkEyXkFqcGdeQWNncmlzY29t._V1_QL75_UX500_CR0,0,500,281_.jpg";
    const other = "https://m.media-amazon.com/images/M/MV5BNjQ2NDA3MDcxMF5BMl5BanBnXkFtZTgwMjE5NTU0NzE@._V1_QL75_UX500_CR0,47,500,281_.jpg";
    const html = `<html><body><img src="${poster}"/><img src="${crop}"/><img src="${crop}"/><img src="${other}"/></body></html>`;
    const out = extractArchiveGallery(html, 20);
    // poster + crop share the frames below? poster id differs from crop id
    // here (different MV5B digests) — same-crop duplicates must collapse.
    expect(out.filter((u) => u === crop).length).toBe(1);
    // True same-frame case: identical canonical id, different crop params.
    const sameA = "https://m.media-amazon.com/images/M/MV5BAAAA1111@._V1_.jpg";
    const sameB = "https://m.media-amazon.com/images/M/MV5BAAAA1111@._V1_QL75_UX190_CR0,2,190,281_.jpg";
    const out2 = extractArchiveGallery(`<img src="${sameA}"/><img src="${sameB}"/>`, 20);
    expect(out2.length).toBe(1);
  });

  it("lists recent CDX timestamps newest-first, deduped", () => {
    const payload = [
      ["timestamp", "original", "statuscode", "mimetype"],
      ["20240101120000", "https://www.imdb.com/title/tt0111161/", "200", "text/html"],
      ["20261001120000", "https://www.imdb.com/title/tt0111161/", "200", "text/html"],
      ["20261001120000", "https://www.imdb.com/title/tt0111161/", "200", "text/html"],
      ["bogus", "https://www.imdb.com/title/tt0111161/", "200", "text/html"],
    ];
    expect(pickRecentCdxTimestamps(payload, 5)).toEqual(["20261001120000", "20240101120000"]);
    expect(pickLatestCdxTimestamp(payload)).toBe("20261001120000");
    expect(snapshotLabel("2", "latest")).toBe("latest");
    expect(snapshotLabel("20240101120000", "latest")).toBe("20240101120000");
  });

  it("expands candidates with the m.imdb.com mirror (bounded)", () => {
    const out = expandArchiveCandidates([
      "https://www.imdb.com/title/tt0111161/",
      "https://www.imdb.com/title/tt0111161/reference/",
    ]);
    expect(out).toContain("https://www.imdb.com/title/tt0111161/");
    expect(out).toContain("https://m.imdb.com/title/tt0111161/");
    expect(out.length).toBeLessThanOrEqual(4);
    expect(expandArchiveCandidates(["https://www.imdb.com/title/tt0111161/"])).toEqual([
      "https://www.imdb.com/title/tt0111161/",
      "https://m.imdb.com/title/tt0111161/",
    ]);
  });

  it("retries transient CDX failures then resolves", async () => {
    const client = new ArchiveClient({ enabled: true, timestamp: "latest" });
    const payload = [
      ["timestamp", "original", "statuscode", "mimetype"],
      ["20240101120000", "https://www.imdb.com/title/tt0111161/", "200", "text/html"],
      ["20261001120000", "https://www.imdb.com/title/tt0111161/", "200", "text/html"],
    ];
    let n = 0;
    const flaky = (async () => {
      n++;
      if (n === 1) return { ok: false, status: 503, json: async () => [] };
      return { ok: true, status: 200, json: async () => payload };
    }) as unknown as typeof fetch;
    const list = await client.resolveRecentTimestamps("https://www.imdb.com/title/tt0111161/", flaky, 5);
    expect(list[0]).toBe("20261001120000");
    expect(n).toBe(2);
  });

  it("skips a WAF-challenge newest capture for an older rich one", async () => {
    const client = new ArchiveClient({ enabled: true, timestamp: "latest" });
    const WAF_HTML = `<html><head></head><body><div id="challenge-container"></div><script>window.gokuProps={};</script></body></html>`;
    const cdxPayload = [
      ["timestamp", "original", "statuscode", "mimetype"],
      ["20261010201402", "https://www.imdb.com/title/tt0111161/", "200", "text/html"],
      ["20261010042405", "https://www.imdb.com/title/tt0111161/", "200", "text/html"],
    ];
    const cdxFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => cdxPayload,
    })) as unknown as typeof fetch;
    const snapFetch = (async (url: unknown) => {
      const u = String(url);
      const html = u.includes("20261010201402") ? WAF_HTML : MOVIE_SNAPSHOT_HTML;
      return { ok: true, status: 200, url: u, text: async () => html };
    }) as unknown as typeof fetch;
    const r = await client.fetchSnapshot("https://www.imdb.com/title/tt0111161/", snapFetch, cdxFetch);
    expect(r).not.toBeNull();
    expect(r?.snapshotTimestamp).toBe("20261010042405");
    expect(r?.html).toContain("__NEXT_DATA__");
  });
});

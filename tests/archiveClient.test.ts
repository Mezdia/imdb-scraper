import { describe, it, expect } from "vitest";
import type { TitleRecord } from "../src/imdb/types.js";
import {
  ArchiveClient,
  extractArchiveGallery,
  mergeArchiveIntoRecord,
  pickLatestCdxTimestamp,
  scoreArchiveRichness,
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
});

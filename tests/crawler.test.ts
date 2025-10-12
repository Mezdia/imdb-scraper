import { describe, it, expect } from "vitest";
import { runWithConcurrency, backoffMs } from "../src/crawler/queue.js";
import { storeRecord, safeName } from "../src/store/jsonStore.js";
import { renderViewerHtml } from "../src/store/html.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { TitleRecord } from "../src/imdb/types.js";

describe("queue", () => {
  it("processes all items with bounded concurrency + retries", async () => {
    const seen: number[] = [];
    let attempts = 0;
    const { ok, failed } = await runWithConcurrency(
      [1, 2, 3, 4, 5],
      async (n) => {
        attempts++;
        if (n === 3 && attempts < 3) throw new Error("flaky");
        seen.push(n);
      },
      { concurrency: 2, politenessMs: 1, retries: 3 },
    );
    expect(ok).toBe(5);
    expect(failed).toBe(0);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts permanent failures", async () => {
    const r = await runWithConcurrency([1], async () => { throw new Error("boom"); }, { concurrency: 1, politenessMs: 0, retries: 1 });
    expect(r.failed).toBe(1);
  });

  it("backoff grows", () => {
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1));
  });
});

describe("store + viewer (IMDb-only)", () => {
  const rec: TitleRecord = {
    imdbId: "tt0111161",
    url: "https://www.imdb.com/title/tt0111161/",
    title: "The Shawshank Redemption",
    kind: "movie",
    year: "1994",
    date: "1994",
    rating: "9.3",
    votes: 2500000,
    description: "Imprisoned...",
    plot: "Imprisoned...",
    runtime: "2h 22m",
    runtimeMinutes: 142,
    genres: ["Drama"],
    directors: ["Frank Darabont"],
    cast: [{ name: "Tim Robbins", role: "Andy" }],
    poster: "https://m.media-amazon.com/images/M/abc.jpg",
    parentsGuide: [{ type: "Violence", rating: "Moderate" }],
    reviews: [{ title: "Great", content: "Loved it" }],
    missing: [],
    scrapedAt: new Date().toISOString(),
    provenance: ["test"],
  };

  it("sanitizes file names", () => {
    expect(safeName('A<B>C:"/\\|?*')).not.toMatch(/[<>:"/\\|?*]/);
  });

  it("stores json + legacy js", () => {
    const root = mkdtempSync(join(tmpdir(), "iscrape-"));
    const stored = storeRecord(root, rec);
    expect(existsSync(stored.jsonPath)).toBe(true);
    expect(existsSync(stored.legacyMainJs)).toBe(true);
    expect(existsSync(stored.legacyReviewJs)).toBe(true);
  });

  it("viewer contains IMDb data and no Bing fallback", () => {
    const html = renderViewerHtml(rec);
    expect(html).toContain("The Shawshank Redemption");
    expect(html).toContain("m.media-amazon.com");
    expect(html).not.toContain("bing.net");
    expect(html).not.toContain("tse2.mm.bing");
  });

  it("viewer renders captioned gallery + episode cards with stills", () => {
    const withMedia: TitleRecord = {
      ...rec,
      gallery: [
        { url: "https://m.media-amazon.com/images/M/a.jpg", caption: "Tim Robbins in chains" },
        { url: "https://m.media-amazon.com/images/M/b.jpg" },
      ],
      episodes: [
        {
          imdbId: "tt0959621",
          season: 1,
          episode: 1,
          title: "Pilot",
          airDate: "2008-01-20",
          rating: "9.1",
          votes: 86582,
          poster: "https://m.media-amazon.com/images/M/ep1.jpg",
          plot: "Diagnosis day.",
        },
      ],
      episodeCount: 1,
    };
    const html = renderViewerHtml(withMedia);
    expect(html).toContain("Tim Robbins in chains");
    expect(html).toContain("Pilot");
    expect(html).toContain("2008-01-20");
    expect(html).toContain("Diagnosis day.");
    expect(html).toContain("ep1.jpg");
    expect(html).toContain("86,582");
  });
});

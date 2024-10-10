import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { storeRecord, alreadyScraped } from "../src/store/jsonStore.js";
import { suggestionKindToMediaKind } from "../src/crawler/titleCrawler.js";
import type { TitleRecord } from "../src/imdb/types.js";

function rec(id: string, title: string): TitleRecord {
  return {
    imdbId: id,
    url: `https://www.imdb.com/title/${id}/`,
    title,
    kind: "movie",
    year: "2000",
    date: "2000",
    rating: "8.0",
    votes: 100,
    description: "d",
    plot: "d",
    runtime: "2h",
    runtimeMinutes: 120,
    genres: ["Drama"],
    directors: ["D"],
    cast: [],
    poster: null,
    parentsGuide: [],
    reviews: [],
    missing: [],
    scrapedAt: new Date().toISOString(),
    provenance: ["test"],
  };
}

describe("list mode (regression: resume + merge bugs)", () => {
  it("alreadyScraped checks membership, not folder existence", () => {
    const root = mkdtempSync(join(tmpdir(), "iscrape-list-"));
    const pre = { imdbId: "tt0111161", title: "x", kind: "movie", year: null };
    expect(alreadyScraped(root, pre, "MyList")).toBe(false);
    storeRecord(root, rec("tt0111161", "Shawshank"), "MyList");
    expect(alreadyScraped(root, pre, "MyList")).toBe(true);
    // A different id in the SAME list must NOT be reported as scraped.
    expect(
      alreadyScraped(root, { imdbId: "tt0468569", title: "x", kind: "movie", year: null }, "MyList"),
    ).toBe(false);
  });

  it("merges data.json array + legacy maps across records", () => {
    const root = mkdtempSync(join(tmpdir(), "iscrape-merge-"));
    storeRecord(root, rec("tt0111161", "Shawshank"), "MyList");
    storeRecord(root, rec("tt0468569", "Dark Knight"), "MyList");
    const arr = JSON.parse(readFileSync(join(root, "Lists", "MyList", "data.json"), "utf8")) as TitleRecord[];
    expect(arr).toHaveLength(2);
    const mainJs = readFileSync(join(root, "Lists", "MyList", "data", "main.js"), "utf8");
    expect(mainJs).toContain("tt0111161");
    expect(mainJs).toContain("tt0468569");
    const reviewJs = readFileSync(join(root, "Lists", "MyList", "data", "review.js"), "utf8");
    expect(reviewJs).toContain("tt0111161");
    expect(reviewJs).toContain("tt0468569");
  });
});

describe("suggestion kind mapping", () => {
  it("maps suggestion q to MediaKind", () => {
    expect(suggestionKindToMediaKind("feature")).toBe("movie");
    expect(suggestionKindToMediaKind("TV movie")).toBe("movie");
    expect(suggestionKindToMediaKind("TV series")).toBe("series");
    expect(suggestionKindToMediaKind("video")).toBe("movie");
    expect(suggestionKindToMediaKind("something-else")).toBe("unknown");
  });
});

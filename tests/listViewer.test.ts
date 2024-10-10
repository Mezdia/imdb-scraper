import { describe, it, expect } from "vitest";
import { renderListHtml } from "../src/store/html.js";
import type { TitleRecord } from "../src/imdb/types.js";

function rec(id: string, title: string): TitleRecord {
  return {
    imdbId: id,
    url: `https://www.imdb.com/title/${id}/`,
    title,
    kind: "movie",
    year: "2008",
    date: "2008",
    rating: "9.1",
    votes: 100,
    description: "d",
    plot: "d",
    runtime: null,
    runtimeMinutes: null,
    genres: [],
    directors: [],
    cast: [],
    poster: null,
    parentsGuide: [],
    reviews: [],
    missing: [],
    scrapedAt: new Date().toISOString(),
    provenance: ["test"],
  };
}

describe("list viewer", () => {
  it("renders all records with no external fallback", () => {
    const html = renderListHtml("MyList", [rec("tt0111161", "Shawshank"), rec("tt0468569", "Dark Knight")]);
    expect(html).toContain("Shawshank");
    expect(html).toContain("Dark Knight");
    expect(html).toContain("2 title(s)");
    expect(html).not.toContain("bing.net");
  });
});

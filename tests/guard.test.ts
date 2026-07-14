import { describe, it, expect } from "vitest";
import { assertImdbOnlyUrl, isImdbOnlyUrl, NonImdbSourceError } from "../src/imdb/guard.js";

describe("IMDb-only guard", () => {
  it("allows official IMDb hosts", () => {
    for (const u of [
      "https://www.imdb.com/title/tt0111161/",
      "https://m.imdb.com/title/tt0111161/",
      "https://v3.sg.media-imdb.com/suggestion/s/shawshank.json",
      "https://datasets.imdbws.com/title.basics.tsv.gz",
      "https://m.media-amazon.com/images/M/MV5B_test.jpg",
    ]) {
      expect(isImdbOnlyUrl(u)).toBe(true);
      expect(assertImdbOnlyUrl(u)).toBe(u);
    }
  });

  it("blocks external sources (tmdb, bing, wikipedia, proxies)", () => {
    for (const u of [
      "https://api.themoviedb.org/3/movie/278",
      "https://tse2.mm.bing.net/th?q=shawshank",
      "https://en.wikipedia.org/wiki/The_Shawshank_Redemption",
      "https://www.omdbapi.com/?i=tt0111161",
      "https://example-proxy.com/https://www.imdb.com/title/tt0111161/",
      "https://evil-imdb.com/title/tt0111161/",
      "https://media-amazon.com/images/M/fake.jpg",
      "https://images-na.ssl-images-amazon.com/images/I/fake.js",
    ]) {
      expect(isImdbOnlyUrl(u)).toBe(false);
      expect(() => assertImdbOnlyUrl(u)).toThrow(NonImdbSourceError);
    }
  });
});

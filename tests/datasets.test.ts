import { describe, it, expect } from "vitest";
import {
  parseTsv,
  episodesForSeries,
  principalsForTitle,
  namesIndex,
} from "../src/imdb/datasets.js";
import { parseSuggestionPayload } from "../src/imdb/suggestion.js";

const BASICS = [
  "tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres",
  "tt0111161\tmovie\tThe Shawshank Redemption\tThe Shawshank Redemption\t0\t1994\t\\N\t142\tDrama",
  "tt0468569\tmovie\tThe Dark Knight\tThe Dark Knight\t0\t2008\t\\N\t152\tAction,Crime,Drama",
].join("\n");

const EPISODES = [
  "tconst\tparentTconst\tseasonNumber\tepisodeNumber",
  "tt0663882\ttt0903747\t1\t1",
  "tt0663881\ttt0903747\t1\t2",
  "tt9999999\ttt0000001\t1\t1",
].join("\n");

const PRINCIPALS = [
  "tconst\tordering\tnconst\tcategory\tjob\tcharacters",
  "tt0111161\t1\tnm0000209\tactor\t\\N\t[\"Andy Dufresne\"]",
  "tt0111161\t2\tnm0000151\tactor\t\\N\t[\"Ellis Boyd 'Red' Redding\"]",
].join("\n");

const NAMES = [
  "nconst\tprimaryName\tbirthYear\tdeathYear\tprimaryProfession\tknownForTitles",
  "nm0000209\tTim Robbins\t1958\t\\N\tactor,producer,director\ttt0111161,tt0096256",
].join("\n");

describe("datasets parsing", () => {
  it("parses TSV rows", () => {
    const rows = parseTsv(BASICS);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.["tconst"]).toBe("tt0111161");
    expect(rows[0]?.["startYear"]).toBe("1994");
  });

  it("filters episodes for a series in order", () => {
    const eps = episodesForSeries(EPISODES, "tt0903747");
    expect(eps).toHaveLength(2);
    expect(eps[0]?.tconst).toBe("tt0663882");
  });

  it("filters principals for a title", () => {
    const ps = principalsForTitle(PRINCIPALS, "tt0111161");
    expect(ps).toHaveLength(2);
    expect(ps[0]?.nconst).toBe("nm0000209");
  });

  it("indexes names", () => {
    const idx = namesIndex(NAMES);
    expect(idx.get("nm0000209")).toBe("Tim Robbins");
  });
});

describe("suggestion parsing", () => {
  it("parses official suggestion payload", () => {
    const payload = {
      d: [
        { id: "tt0111161", l: "The Shawshank Redemption", q: "feature", y: 1994, s: "Tim Robbins, Morgan Freeman", i: { imageUrl: "https://m.media-amazon.com/images/M/abc.jpg" } },
        { id: "nm0000209", l: "Tim Robbins" },
      ],
      q: "shawshank",
    };
    const out = parseSuggestionPayload(payload);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("tt0111161");
    expect(out[0]?.poster).toContain("m.media-amazon.com");
  });

  it("returns [] for malformed payloads", () => {
    expect(parseSuggestionPayload(null)).toEqual([]);
    expect(parseSuggestionPayload({})).toEqual([]);
  });
});

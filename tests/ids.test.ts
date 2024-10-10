import { describe, it, expect } from "vitest";
import { extractTitleId, normalizeTitleInput, titleUrl, isTitleId } from "../src/imdb/ids.js";
import { NonImdbSourceError } from "../src/imdb/guard.js";

describe("ids", () => {
  it("extracts tt ids", () => {
    expect(extractTitleId("https://www.imdb.com/title/tt0111161/")).toBe("tt0111161");
    expect(extractTitleId("tt0137523")).toBe("tt0137523");
    expect(extractTitleId("www.imdb.com/title/tt0468569/?ref_=fn_al")).toBe("tt0468569");
    expect(extractTitleId("no id here")).toBeNull();
  });

  it("validates bare ids", () => {
    expect(isTitleId("tt0111161")).toBe(true);
    expect(isTitleId("TT0111161")).toBe(true);
    expect(isTitleId("nm0000209")).toBe(false);
  });

  it("builds canonical URLs", () => {
    expect(titleUrl("tt0111161")).toBe("https://www.imdb.com/title/tt0111161/");
    expect(() => titleUrl("nm0000209")).toThrow();
  });

  it("rejects non-IMDb hosts", () => {
    expect(() => normalizeTitleInput("https://www.themoviedb.org/movie/278")).toThrow();
    expect(() => normalizeTitleInput("https://evil.com/title/tt0111161/")).toThrow(NonImdbSourceError);
  });

  it("normalizes protocol-less imdb input", () => {
    const { imdbId, url } = normalizeTitleInput("www.imdb.com/title/tt0111161/");
    expect(imdbId).toBe("tt0111161");
    expect(url).toBe("https://www.imdb.com/title/tt0111161/");
  });
});

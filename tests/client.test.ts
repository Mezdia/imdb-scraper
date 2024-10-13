import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImdbClient } from "../src/imdb/client.js";
import { NonImdbSourceError } from "../src/imdb/guard.js";

describe("ImdbClient library", () => {
  const client = new ImdbClient({ baseDir: mkdtempSync(join(tmpdir(), "imdb-client-")) });

  it("builds validated canonical URLs", () => {
    expect(client.title("tt0111161")).toBe("https://www.imdb.com/title/tt0111161/");
    expect(client.episodes("tt0903747", 2)).toBe("https://www.imdb.com/title/tt0903747/episodes/?season=2");
    expect(client.taglines("tt0111161")).toContain("/taglines/");
    expect(client.photos("tt0111161")).toContain("/mediaindex/");
  });

  it("normalizes + validates inputs", () => {
    expect(client.normalize("tt0111161").imdbId).toBe("tt0111161");
    expect(client.isTitle("tt0111161")).toBe(true);
    expect(() => client.normalize("https://example.com/title/tt0111161/")).toThrow(NonImdbSourceError);
  });

  it("parses search payloads without network", () => {
    const out = client.parseSearchPayload({ d: [{ id: "tt0111161", l: "Shawshank", y: 1994 }] });
    expect(out[0]?.id).toBe("tt0111161");
  });

  it("returns null/[] for uncached datasets (no crash, no network)", () => {
    expect(client.basics("tt0111161")).toBeNull();
    expect(client.ratings("tt0111161")).toBeNull();
    expect(client.crew("tt0111161")).toBeNull();
    expect(client.akas("tt0111161")).toEqual([]);
    expect(client.seriesEpisodes("tt0903747")).toEqual([]);
  });

  it("exposes the dataset file list", () => {
    expect(client.datasetFiles()).toContain("title.basics.tsv.gz");
  });
});

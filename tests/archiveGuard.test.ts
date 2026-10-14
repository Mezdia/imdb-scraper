import { describe, it, expect } from "vitest";
import {
  assertArchiveCdxUrl,
  assertArchiveUrl,
  buildArchiveCdxUrl,
  buildArchiveUrl,
  extractArchiveTimestamp,
  extractEmbeddedImdbUrl,
  isArchiveCdxUrl,
  isArchiveUrl,
  NonArchivedImdbUrlError,
} from "../src/archive/archiveGuard.js";

describe("archive guard (BETA)", () => {
  it("allows valid Wayback snapshot URLs of IMDb", () => {
    for (const u of [
      "https://web.archive.org/web/20240101120000id_/https://www.imdb.com/title/tt0111161/",
      "https://web.archive.org/web/20240101120000/https://www.imdb.com/title/tt0111161/",
      "https://web.archive.org/web/2024id_/https://m.imdb.com/title/tt0111161/reference/",
      "https://web.archive.org/web/2id_/https://www.imdb.com/title/tt0111161/",
    ]) {
      expect(isArchiveUrl(u)).toBe(true);
      expect(assertArchiveUrl(u)).toBe(u);
    }
  });

  it("rejects non-IMDb embedded URLs, liveweb, and foreign hosts", () => {
    for (const u of [
      "https://web.archive.org/web/20240101120000id_/https://example.com/title/tt0111161/",
      "https://web.archive.org/web/20240101120000id_/https://api.themoviedb.org/3/movie/278",
      "https://web.archive.org/web/20240101120000id_/https://en.wikipedia.org/wiki/X",
      "https://archive.today/2024/https://www.imdb.com/title/tt0111161/",
      "https://arquivo.pt/wayback/cdx/https://www.imdb.com/title/tt0111161/",
      "https://web.archive.org/web/20240101120000id_/http://evil-imdb.com/title/tt0111161/",
      "https://www.imdb.com/title/tt0111161/",
      "https://web.archive.org/cdx/search/cdx?url=imdb.com/title/tt0111161/",
      // Wayback modifier variants (only digits + optional id_ are allowed).
      "https://web.archive.org/web/20240101120000if_/https://www.imdb.com/title/tt0111161/",
      "https://web.archive.org/web/20240101120000im_/https://www.imdb.com/title/tt0111161/",
      "https://web.archive.org/web/20240101120000js_/https://www.imdb.com/title/tt0111161/",
      "https://web.archive.org/web/liveweb/https://www.imdb.com/title/tt0111161/",
      "https://web.archive.org/web/2im_/https://www.imdb.com/title/tt0111161/",
      "not-a-url",
    ]) {
      expect(isArchiveUrl(u)).toBe(false);
      expect(() => assertArchiveUrl(u)).toThrow(NonArchivedImdbUrlError);
    }
  });

  it("builds snapshot URLs only for IMDb originals", () => {
    expect(buildArchiveUrl("https://www.imdb.com/title/tt0111161/", "20240101120000")).toBe(
      "https://web.archive.org/web/20240101120000id_/https://www.imdb.com/title/tt0111161/",
    );
    expect(buildArchiveUrl("https://www.imdb.com/title/tt0111161/", "latest")).toBe(
      "https://web.archive.org/web/2id_/https://www.imdb.com/title/tt0111161/",
    );
    expect(() => buildArchiveUrl("https://example.com/x", "20240101")).toThrow(
      NonArchivedImdbUrlError,
    );
    expect(() => buildArchiveUrl("https://www.imdb.com/title/tt0111161/", "bogus")).toThrow(
      NonArchivedImdbUrlError,
    );
  });

  it("extracts embedded URL + timestamp", () => {
    const u = "https://web.archive.org/web/20240101120000id_/https://www.imdb.com/title/tt0111161/";
    expect(extractEmbeddedImdbUrl(u)).toBe("https://www.imdb.com/title/tt0111161/");
    expect(extractArchiveTimestamp(u)).toBe("20240101120000");
    expect(extractEmbeddedImdbUrl("https://www.imdb.com/title/tt0111161/")).toBeNull();
  });

  it("never allows web.archive.org through the IMDb-only guard", async () => {
    const { isImdbOnlyUrl } = await import("../src/imdb/guard.js");
    expect(isImdbOnlyUrl("https://web.archive.org/web/2id_/https://www.imdb.com/")).toBe(false);
  });

  it("allows CDX lookups only for exact IMDb targets on the same host", () => {
    const good = buildArchiveCdxUrl("https://www.imdb.com/title/tt0111161/", 5);
    expect(isArchiveCdxUrl(good)).toBe(true);
    expect(assertArchiveCdxUrl(good)).toBe(good);
    expect(good.startsWith("https://web.archive.org/cdx/search/cdx?")).toBe(true);
    expect(good).toContain(encodeURIComponent("https://www.imdb.com/title/tt0111161/") .slice(0, 20));
    // Snapshot guard must stay strict: CDX URLs are never snapshots.
    expect(isArchiveUrl(good)).toBe(false);
  });

  it("rejects CDX lookups for non-IMDb targets and foreign hosts", () => {
    for (const u of [
      "https://web.archive.org/cdx/search/cdx?url=https://example.com/title/tt0111161/&output=json",
      "https://web.archive.org/cdx/search/cdx?url=https://api.themoviedb.org/3/movie/278&output=json",
      "https://web.archive.org/cdx/search/cdx",
      "https://archive.today/cdx/search/cdx?url=https://www.imdb.com/title/tt0111161/",
      "https://web.archive.org/cdx/search/cdx?url=not-a-url",
    ]) {
      expect(isArchiveCdxUrl(u)).toBe(false);
      expect(() => assertArchiveCdxUrl(u)).toThrow(NonArchivedImdbUrlError);
    }
    expect(() => buildArchiveCdxUrl("https://example.com/x")).toThrow(NonArchivedImdbUrlError);
  });
});

import { describe, it, expect } from "vitest";
import {
  parseGalleryNodes,
  parseTitleNode,
  titleNode,
} from "../src/crawler/graphql.js";
import { scoreHtmlRichness } from "../src/crawler/titleCrawler.js";
import { isWafChallengeHtml } from "../src/crawler/extractors.js";
import { alreadyScraped, findRecordDir, storeRecord } from "../src/store/jsonStore.js";
import { writePortable } from "../src/store/html.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { TitleRecord } from "../src/imdb/types.js";

// Regression tests for bugs proven against LIVE imdb.com (Oct 2026).
// Every fixture below mirrors a real payload shape observed in this container.

describe("live: mediaindex all_images gallery", () => {
  it("parses title.all_images (live /mediaindex/ shape)", () => {
    const nd = {
      props: {
        pageProps: {
          contentData: {
            data: {
              title: {
                all_images: {
                  edges: [
                    {
                      node: {
                        url: "https://m.media-amazon.com/images/M/MV5BMTM0NjUxMDk5MF5BMl5BanBnXkFtZTcwNDMxNDY3Mw@@._V1_.jpg",
                        caption: { plainText: "Morgan Freeman, Tim Robbins in Shawshank" },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    };
    const g = parseGalleryNodes(nd, 5);
    expect(g).toHaveLength(1);
    expect(g[0]?.url).toContain("m.media-amazon.com");
    expect(g[0]?.caption).toContain("Morgan Freeman");
  });

  it("parses titleMainImages as well", () => {
    const nd = {
      props: {
        pageProps: {
          data: {
            title: {
              titleMainImages: {
                edges: [{ node: { url: "https://m.media-amazon.com/images/M/hero.jpg" } }],
              },
            },
          },
        },
      },
    };
    expect(parseGalleryNodes(nd, 5)).toHaveLength(1);
  });
});

describe("live: reference-page groupingId-only credits + crewV2", () => {
  const REF_ND = {
    props: {
      pageProps: {
        mainColumnData: {
          id: "tt0111161",
          titleText: { text: "The Shawshank Redemption" },
          titleType: { id: "movie" },
          principalCreditsV2: [
            {
              grouping: { groupingId: "amzn1.imdb.concept.name_credit_category.ace5cb4c-8708-4238-9542-04641e7c8171" },
              credits: [{ name: { nameText: { text: "Frank Darabont" }, id: "nm0001104" } }],
            },
            {
              grouping: { groupingId: "amzn1.imdb.concept.name_credit_category.c84ecaff-add5-4f2e-81db-102a41881fe3" },
              credits: [{ name: { nameText: { text: "Stephen King" }, id: "nm0000175" } }],
            },
          ],
        },
      },
    },
  };

  it("resolves directors/writers from groupingId when text is absent", () => {
    const tn = titleNode(REF_ND) as Record<string, unknown>;
    expect(tn).not.toBeNull();
    const p = parseTitleNode(tn);
    expect(p.directors).toEqual([{ name: "Frank Darabont", id: "nm0001104" }]);
    expect(p.writers).toEqual([{ name: "Stephen King", id: "nm0000175" }]);
  });

  it("reads crewV2 Director groups with text (title page node0 shape)", () => {
    const nd = {
      props: {
        pageProps: {
          mainColumnData: {
            id: "tt0111161",
            titleText: { text: "T" },
            titleType: { id: "movie" },
            crewV2: [
              {
                grouping: { text: "Director", groupingId: "amzn1.imdb.concept.name_credit_category.ace5cb4c-8708-4238-9542-04641e7c8171" },
                credits: [{ name: { nameText: { text: "Frank Darabont" }, id: "nm0001104" } }],
              },
            ],
          },
        },
      },
    };
    const p = parseTitleNode(titleNode(nd) as Record<string, unknown>);
    expect(p.directors).toEqual([{ name: "Frank Darabont", id: "nm0001104" }]);
  });
});

describe("live: titleType without boolean flags", () => {
  it("derives series-ness from canHaveEpisodes", () => {
    const nd = {
      props: {
        pageProps: {
          mainColumnData: {
            id: "tt0903747",
            titleText: { text: "Breaking Bad" },
            titleType: { id: "tvSeries", canHaveEpisodes: true },
          },
        },
      },
    };
    const p = parseTitleNode(titleNode(nd) as Record<string, unknown>);
    expect(p.isSeries).toBe(true);
    expect(p.titleTypeId).toBe("tvseries");
  });
});

describe("live: lightweight-variant richness scoring", () => {
  const RICH = `<html><head><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"mainColumnData":{"id":"tt0111161","titleText":{"text":"T"}}}}}</script></head></html>`;
  const LIGHT = `<html><head><script type="application/ld+json">{"@type":"Movie","name":"T"}</script></head><body>${"x".repeat(2000)}</body></html>`;
  const WAF = `<html><body><div id="challenge-container"></div><script>window.gokuProps={}</script></body></html>`;
  const HUMAN_VERIFY = `<html><head><title>Human Verification</title></head><body><script src="https://c3382d439950.challenge.js"></script><script>window.gokuProps={}; AwsWafIntegration</script>${"y".repeat(9000)}</body></html>`;

  it("ranks rich > light > waf", () => {
    expect(scoreHtmlRichness(RICH)).toBe(2);
    expect(scoreHtmlRichness(LIGHT)).toBe(0);
    expect(scoreHtmlRichness(WAF)).toBe(-1);
    expect(scoreHtmlRichness("")).toBe(-1);
  });

  it("rejects the Human Verification captcha variant even at full length", () => {
    expect(scoreHtmlRichness(HUMAN_VERIFY)).toBe(-1);
  });

  it("does NOT flag solved pages that embed the WAF SDK (live Oct 2026)", () => {
    // Real solved title pages always contain the SDK script
    // (...awswaf.com/.../challenge.js + window.awsWafCookieDomainList)
    // alongside the rich payload. That alone is not a challenge.
    const SOLVED_WITH_SDK = `<html><head><script>window.awsWafCookieDomainList=['.imdb.com'];</script><script src="https://fb423e1ef94f.us-east-1.sdk.awswaf.com/fb423e1ef94f/c3382d439950/challenge.js" defer></script><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"mainColumnData":{"id":"tt0111161","titleText":{"text":"T"}}}}}</script></head><body>${"x".repeat(5000)}</body></html>`;
    expect(isWafChallengeHtml(SOLVED_WITH_SDK)).toBe(false);
    expect(scoreHtmlRichness(SOLVED_WITH_SDK)).toBe(2);
  });
});

describe("live: resume + portable fixes", () => {
  const rec = (over: Partial<TitleRecord> = {}): TitleRecord => ({
    imdbId: "tt0111161",
    url: "https://www.imdb.com/title/tt0111161/",
    title: "The Shawshank Redemption",
    kind: "movie",
    year: "1994",
    date: "1994",
    rating: "9.3",
    votes: 100,
    missing: [],
    scrapedAt: new Date().toISOString(),
    provenance: ["test"],
    ...over,
  });

  it("alreadyScraped finds series/movie dirs by id tag (not stub title)", () => {
    const root = mkdtempSync(join(tmpdir(), "iscrape-resume-"));
    storeRecord(root, { ...rec(), kind: "series" });
    // Pre-crawl stub has title=id, year=null, kind=movie — old code missed.
    expect(
      alreadyScraped(root, { imdbId: "tt0111161", title: "tt0111161", kind: "movie" }),
    ).toBe(true);
    expect(findRecordDir(root, "tt0111161")).toContain("[tt0111161]");
    expect(alreadyScraped(root, { imdbId: "tt9999999", title: "tt9999999", kind: "movie" })).toBe(false);
  });

  it("writePortable embeds the full record (no 2M truncation)", () => {
    const root = mkdtempSync(join(tmpdir(), "iscrape-portable-"));
    const big = rec({ reviews: Array.from({ length: 50 }, (_, i) => ({ title: `R${i}`, content: "x".repeat(200) })) });
    const stored = storeRecord(root, big);
    const out = writePortable(stored.dir, big);
    expect(existsSync(out)).toBe(true);
    const html = readFileSync(out, "utf8");
    expect(html).toContain("window.__RECORD__");
    expect(html).not.toContain("window.__RECORD__ = null;");
    // Full payload round-trips (a truncated slice would throw here).
    const m = html.match(/window\.__RECORD__ = (\{.*?\});/s);
    expect(m).not.toBeNull();
    expect(() => JSON.parse(m?.[1] as string)).not.toThrow();
  });
});

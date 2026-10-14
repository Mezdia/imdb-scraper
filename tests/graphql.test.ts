import { describe, it, expect } from "vitest";
import {
  countryName,
  formatMoney,
  parseEpisodeItems,
  parseGalleryNodes,
  parseGuideCategories,
  parseReviewNodes,
  parseSeriesStructure,
  parseTaglines,
  parseTitleNode,
  reviewTotal,
  titleNode,
} from "../src/crawler/graphql.js";

// Fixtures mirror the live imdb.com __NEXT_DATA__ shapes (Oct 2026).

const TITLE_ND = {
  props: {
    pageProps: {
      mainDetails: {
        id: "tt0111161",
        titleText: { text: "The Shawshank Redemption" },
        originalTitleText: { text: "The Shawshank Redemption" },
        titleType: { text: "Movie", id: "movie", isSeries: false, isEpisode: false },
        isAdult: false,
        releaseYear: { year: 1994, endYear: null },
        releaseDate: { day: 14, month: 10, year: 1994, country: { text: "United States" } },
        certificate: { rating: "R" },
        ratingsSummary: {
          aggregateRating: 9.3,
          voteCount: 3252337,
          topRanking: { rank: 1 },
        },
        metacritic: { metascore: { score: 82 } },
        runtime: { seconds: 8520 },
        plot: { plotText: { plainText: "Hope story." } },
        genres: { genres: [{ text: "Drama" }] },
        keywords: { edges: [{ node: { text: "prison" } }] },
        productionBudget: { budget: { amount: 25000000, currency: "USD" } },
        lifetimeGross: { total: { amount: 28767189, currency: "USD" } },
        worldwideGross: { total: { amount: 28817291, currency: "USD" } },
        openingWeekendGross: { gross: { total: { amount: 727327, currency: "USD" } } },
        countriesOfOrigin: { countries: [{ id: "US" }] },
        countriesDetails: { countries: [{ id: "US", text: "United States" }] },
        production: { edges: [{ node: { company: { companyText: { text: "Castle Rock Entertainment" } } } }] },
        spokenLanguages: { spokenLanguages: [{ text: "English" }] },
        filmingLocations: { edges: [{ node: { text: "Butler, Ohio, USA" } }] },
        akas: { edges: [{ node: { text: "Sueño de fuga" } }] },
        principalCreditsV2: [
          {
            grouping: { text: "Director" },
            credits: [{ name: { nameText: { text: "Frank Darabont" }, id: "nm0001104" } }],
          },
          {
            grouping: { text: "Writers" },
            credits: [
              { name: { nameText: { text: "Stephen King" }, id: "nm0000175" } },
              { name: { nameText: { text: "Frank Darabont" }, id: "nm0001104" } },
            ],
          },
        ],
        castV2: [
          { credits: [{ name: { id: "nm0000209", nameText: { text: "Tim Robbins" } } }] },
        ],
        primaryImage: { url: "https://m.media-amazon.com/images/M/abc.jpg", caption: { plainText: "Tim" } },
        images: { total: 563 },
        videos: { total: 7 },
        reviews: { total: 12063 },
        primaryVideos: {
          edges: [{ node: { id: "vi3877612057", name: { value: "Official Trailer" }, runtime: { value: 131 } } }],
        },
      },
    },
  },
};

describe("graphql title parser", () => {
  it("finds the title node", () => {
    const n = titleNode(TITLE_ND);
    expect(n?.["id"]).toBe("tt0111161");
    expect(titleNode({})).toBeNull();
  });

  it("parses all fact groups precisely", () => {
    const p = parseTitleNode(titleNode(TITLE_ND) as Record<string, unknown>);
    expect(p.title).toBe("The Shawshank Redemption");
    expect(p.titleTypeId).toBe("movie");
    expect(p.isSeries).toBe(false);
    expect(p.year).toBe(1994);
    expect(p.releaseDate).toBe("1994-10-14");
    expect(p.releaseCountry).toBe("United States");
    expect(p.certificate).toBe("R");
    expect(p.rating).toBe(9.3);
    expect(p.votes).toBe(3252337);
    expect(p.topRank).toBe(1);
    expect(p.metascore).toBe(82);
    expect(p.runtimeSeconds).toBe(8520);
    expect(p.plot).toBe("Hope story.");
    expect(p.genres).toEqual(["Drama"]);
    expect(p.keywords).toEqual(["prison"]);
    expect(p.budget).toBe("$25,000,000");
    expect(p.grossUSA).toBe("$28,767,189");
    expect(p.grossWorldwide).toBe("$28,817,291");
    expect(p.openingWeekend).toBe("$727,327");
    expect(p.countryIds).toEqual(["US"]);
    expect(p.companies).toEqual(["Castle Rock Entertainment"]);
    expect(p.languages).toEqual(["English"]);
    expect(p.filmingLocations).toEqual(["Butler, Ohio, USA"]);
    expect(p.akas).toEqual(["Sueño de fuga"]);
    expect(p.directors).toEqual([{ name: "Frank Darabont", id: "nm0001104" }]);
    expect(p.writers).toHaveLength(2);
    expect(p.cast).toEqual([{ name: "Tim Robbins", id: "nm0000209" }]);
    expect(p.poster).toContain("m.media-amazon.com");
    expect(p.photoCount).toBe(563);
    expect(p.videoCount).toBe(7);
    expect(p.reviewCount).toBe(12063);
    expect(p.trailers?.[0]?.url).toBe("https://www.imdb.com/video/vi3877612057/");
  });
});

describe("graphql helpers", () => {
  it("formats money", () => {
    expect(formatMoney(25000000, "USD")).toBe("$25,000,000");
    expect(formatMoney(null, "USD")).toBeUndefined();
    expect(countryName("US")).toBe("United States");
    expect(countryName("XX")).toBe("XX");
  });

  it("parses series structure", () => {
    const { seasons, years } = parseSeriesStructure({
      seasons: [{ number: 1 }, { number: 2 }],
      years: [{ year: 2008 }, { year: 2013 }],
    });
    expect(seasons).toEqual([1, 2]);
    expect(years).toEqual([2008, 2013]);
  });

  it("parses review nodes with html entities", () => {
    const nd = {
      props: {
        pageProps: {
          contentData: {
            data: {
              title: {
                reviews: {
                  total: 5,
                  edges: [
                    {
                      node: {
                        id: "rw1",
                        author: { username: { text: "fan" }, userId: "ur1" },
                        summary: { originalText: "Great" },
                        text: { originalText: { plaidHtml: "Loved<br/>it&#39;s best" } },
                        authorRating: 10,
                        submissionDate: "2021-02-17",
                        helpfulness: { upVotes: 659, downVotes: 1 },
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
    const revs = parseReviewNodes(nd);
    expect(revs).toHaveLength(1);
    expect(revs[0]?.content).toBe("Loved\nit's best");
    expect(revs[0]?.helpful).toBe(659);
    expect(reviewTotal(nd)).toBe(5);
  });

  it("parses guide categories with breakdown", () => {
    const nd = {
      props: {
        pageProps: {
          contentData: {
            categories: [
              {
                id: "NUDITY",
                title: "Sex & Nudity",
                items: [{ id: "pg1", isSpoiler: false, text: "Mild scene." }],
                severitySummary: { text: "Mild", votes: 710 },
                severityBreakdown: [{ text: "Mild", votes: 710 }],
                totalSeverityVotes: 1663,
              },
            ],
          },
        },
      },
    };
    const pg = parseGuideCategories(nd);
    expect(pg[0]?.rating).toBe("Mild");
    expect(pg[0]?.totalVotes).toBe(1663);
    expect(pg[0]?.details?.[0]?.spoiler).toBe(false);
  });

  it("parses episode items richly", () => {
    const nd = {
      props: {
        pageProps: {
          contentData: {
            section: {
              episodes: {
                items: [
                  {
                    id: "tt0959621",
                    type: "tvEpisode",
                    season: "1",
                    episode: "1",
                    titleText: "Pilot",
                    releaseDate: { month: 1, day: 20, year: 2008 },
                    plot: "Diag&#39;nosis",
                    aggregateRating: 9.1,
                    voteCount: 86579,
                    image: { url: "https://m.media-amazon.com/images/M/x.jpg" },
                  },
                ],
              },
            },
          },
        },
      },
    };
    const eps = parseEpisodeItems(nd);
    expect(eps[0]?.title).toBe("Pilot");
    expect(eps[0]?.airDate).toBe("2008-01-20");
    expect(eps[0]?.votes).toBe(86579);
    expect(eps[0]?.plot).toBe("Diag'nosis");
  });

  it("parses taglines + gallery nodes", () => {
    const tagNd = {
      props: { pageProps: { data: { title: { taglines: { edges: [{ node: { displayableProperty: { value: { plaidHtml: "Fear can hold you prisoner." } } } }] } } } } },
    };
    expect(parseTaglines(tagNd)).toEqual(["Fear can hold you prisoner."]);
    const galNd = {
      props: {
        pageProps: {
          data: {
            title: {
              images: {
                edges: [
                  { node: { url: "https://m.media-amazon.com/images/M/a.jpg", caption: { plainText: "Cap" } } },
                  { node: { url: "https://evil.com/x.jpg" } },
                ],
              },
            },
          },
        },
      },
    };
    const g = parseGalleryNodes(galNd);
    expect(g).toHaveLength(1);
    expect(g[0]?.caption).toBe("Cap");
  });
});

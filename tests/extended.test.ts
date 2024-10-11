import { describe, it, expect } from "vitest";
import {
  collectByKey,
  extractCreditsDetailed,
  extractDetailsFallback,
  extractEmbeddedFacts,
  extractGallery,
  extractKeywords,
  extractParentalGuideRich,
  extractReviewsRich,
  normalizeAkas,
} from "../src/crawler/extractors.js";
import { akasForTitle, basicsForTitle, crewForTitle, ratingsForTitle, splitNconsts } from "../src/imdb/datasets.js";
import { photosUrl, fullCreditsUrl } from "../src/imdb/ids.js";

const NEXT = {
  props: {
    pageProps: {
      mainDetails: {
        budget: "$25,000,000",
        worldwideGross: "$28,767,189",
        metascore: 80,
        top250Rank: 1,
        releaseDate: "1994-09-23",
        tagline: "Fear can hold you prisoner. Hope can set you free.",
        originCountries: [{ name: "United States" }],
        spokenLanguages: ["English"],
        filmingLocations: ["Mansfield, Ohio, USA"],
        productionCompanies: [{ name: "Castle Rock Entertainment" }],
        numberOfSeasons: 0,
      },
    },
  },
};

const DETAILS_HTML = `<html><body><ul>
<li data-testid="title-details-releasedate">23 September 1994 (USA)</li>
<li data-testid="title-details-origin"><a>United States</a></li>
<li data-testid="title-details-languages"><a>English</a></li>
<li data-testid="title-details-filminglocations"><a>Mansfield, Ohio, USA</a></li>
<li data-testid="title-details-companies"><a>Castle Rock Entertainment</a></li>
<li data-testid="title-techspec_color"><a>Color</a></li>
</ul></body></html>`;

const CREDITS_HTML = `<html><body><ul>
<li data-testid="title-pc-principal-credit"><span class="ipc-metadata-list-item__label">Directors</span><a href="/name/nm0001104/">Frank Darabont</a></li>
<li data-testid="title-pc-principal-credit"><span class="ipc-metadata-list-item__label">Writers</span><a href="/name/nm0001104/">Frank Darabont</a><a href="/name/nm0000175/">Stephen King</a></li>
<li data-testid="title-pc-principal-credit"><span class="ipc-metadata-list-item__label">Stars</span><a href="/name/nm0000209/">Tim Robbins</a></li>
</ul></body></html>`;

const GALLERY_HTML = `<html><body>
<img src="https://m.media-amazon.com/images/M/MV5Babc._V1_UY400_CR0,0,400,400_AL_.jpg">
<img src="https://tse2.mm.bing.net/th?q=x.jpg">
<img src="https://evil.com/m.media-amazon.com/images/M/fake.jpg">
<img srcset="https://m.media-amazon.com/images/M/MV5Bdef._V1_.jpg 400w, https://m.media-amazon.com/images/M/MV5Babc._V1_UY400_CR0,0,400,400_AL_.jpg 200w">
</body></html>`;

const REVIEWS_HTML = `<html><body>
<article data-testid="review-card">
<div data-testid="review-summary">A masterpiece 10/10</div>
<div data-testid="review-content">Best film ever made.</div>
<a href="/user/ur1234567/">movie_fan</a>
</article></body></html>`;

const PG_HTML = `<html><body><ul>
<li data-testid="rating-item"><span class="ipc-metadata-list-item__label">Violence</span><div class="ipc-html-content-inner-div">Moderate</div><div>1,234 votes</div></li>
</ul></body></html>`;

describe("embedded facts deep-scan", () => {
  it("finds money/metascore/rank/dates/origins without hard paths", () => {
    const f = extractEmbeddedFacts(NEXT);
    expect(f.budget).toContain("25,000,000");
    expect(f.grossWorldwide).toContain("28,767,189");
    expect(f.metascore).toBe(80);
    expect(f.top250Rank).toBe(1);
    expect(f.releaseDate).toBe("1994-09-23");
    expect(f.tagline).toContain("Hope can set you free");
    expect(f.countries).toEqual(["United States"]);
    expect(f.languages).toEqual(["English"]);
    expect(f.productionCompanies).toEqual(["Castle Rock Entertainment"]);
  });

  it("collectByKey matches case-insensitively-ish patterns", () => {
    expect(collectByKey({ MetaScore: 75 }, /metascore/i)).toEqual([75]);
  });
});

describe("details + credits DOM", () => {
  it("parses details section", () => {
    const d = extractDetailsFallback(DETAILS_HTML);
    expect(d.releaseDate).toContain("1994");
    expect(d.countries).toEqual(["United States"]);
    expect(d.languages).toEqual(["English"]);
    expect(d.colorInfo).toEqual(["Color"]);
  });

  it("assigns credits by label (not first-block-blind)", () => {
    const c = extractCreditsDetailed(CREDITS_HTML);
    expect(c.directors).toEqual(["Frank Darabont"]);
    expect(c.writers).toEqual(["Frank Darabont", "Stephen King"]);
    expect(c.stars).toEqual(["Tim Robbins"]);
  });
});

describe("gallery (IMDb-CDN only)", () => {
  it("keeps m.media-amazon.com, drops bing/evil, dedups", () => {
    const g = extractGallery(GALLERY_HTML, 10);
    expect(g.length).toBeGreaterThanOrEqual(1);
    expect(g.every((u) => u.includes("m.media-amazon.com"))).toBe(true);
    expect(g.join(" ")).not.toContain("bing.net");
    expect(g.join(" ")).not.toContain("evil.com");
    expect(new Set(g).size).toBe(g.length);
  });
});

describe("rich reviews + parental guide", () => {
  it("extracts author + rating", () => {
    const r = extractReviewsRich(REVIEWS_HTML);
    expect(r).toHaveLength(1);
    expect(r[0]?.author).toBe("movie_fan");
    expect(r[0]?.authorId).toBe("ur1234567");
    expect(r[0]?.rating).toBe(10);
  });

  it("extracts votes", () => {
    const pg = extractParentalGuideRich(PG_HTML);
    expect(pg[0]?.type).toBe("Violence");
    expect(pg[0]?.votes).toBe(1234);
  });
});

describe("keywords + akas + sorted dataset lookups", () => {
  it("extracts keywords", () => {
    const kw = extractKeywords(`<a href="/title/tt0111161/keywords/prison">prison</a>`);
    expect(kw).toContain("prison");
  });

  it("akas lookup early-exits on sorted data", () => {
    const tsv = [
      "titleId\tordering\ttitle\tregion\tlanguage\ttypes\tattributes\tisOriginalTitle",
      "tt0111161\t1\tLes Évadés\tFR\tfr\timdbDisplay\t\\N\t0",
      "tt0111161\t2\tThe Shawshank Redemption\tUS\t\\N\toriginal\t\\N\t1",
      "tt0468569\t1\tThe Dark Knight\t\\N\t\\N\toriginal\t\\N\t1",
    ].join("\n");
    const akas = normalizeAkas(akasForTitle(tsv, "tt0111161"));
    expect(akas).toHaveLength(2);
    expect(akasForTitle(tsv, "tt0468569")).toHaveLength(1);
    expect(akasForTitle(tsv, "tt9999999")).toHaveLength(0);
  });

  it("basics/crew/ratings single-row lookups", () => {
    const basics = "tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres\ntt0111161\tmovie\tThe Shawshank Redemption\tThe Shawshank Redemption\t0\t1994\t\\N\t142\tDrama";
    expect(basicsForTitle(basics, "tt0111161")?.startYear).toBe("1994");
    expect(basicsForTitle(basics, "tt0000000")).toBeNull();
    const crew = "tconst\tdirectors\twriters\ntt0111161\tnm0001104\tnm0001104,nm0000175";
    expect(splitNconsts(crewForTitle(crew, "tt0111161")?.writers ?? "")).toEqual(["nm0001104", "nm0000175"]);
    const ratings = "tconst\taverageRating\tnumVotes\ntt0111161\t9.3\t2500000";
    expect(ratingsForTitle(ratings, "tt0111161")?.averageRating).toBe("9.3");
  });

  it("gallery/credits URLs are IMDb-only", () => {
    expect(photosUrl("tt0111161")).toBe("https://www.imdb.com/title/tt0111161/mediaindex/");
    expect(fullCreditsUrl("tt0111161")).toBe("https://www.imdb.com/title/tt0111161/fullcredits/");
  });
});

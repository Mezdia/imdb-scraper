import { describe, it, expect } from "vitest";
import {
  extractJsonLdBlocks,
  extractNextData,
  isWafChallengeHtml,
  parseIso8601DurationToMinutes,
  formatMinutes,
  extractCastFallback,
  extractReviewsFallback,
  extractParentalGuideFallback,
  extractEpisodeIds,
} from "../src/crawler/extractors.js";

const LD_HTML = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Movie","name":"The Shawshank Redemption","datePublished":"1994-09-23","aggregateRating":{"ratingValue":"9.3","ratingCount":2500000},"description":"Imprisoned...","genre":["Drama"],"duration":"PT2H22M","actor":[{"name":"Tim Robbins","url":"https://www.imdb.com/name/nm0000209/"}],"director":[{"name":"Frank Darabont"}],"image":"https://m.media-amazon.com/images/M/abc.jpg"}</script>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"titleType":"movie"}}}</script>
</head><body></body></html>`;

const DOM_HTML = `<html><body>
<a data-testid="title-cast-item__actor" href="/name/nm0000209/">Tim Robbins</a>
<a data-testid="title-cast-item__actor" href="/name/nm0000151/">Morgan Freeman</a>
<ul data-testid="cast-item-characters-list">Andy Dufresne</ul>
<ul data-testid="cast-item-characters-list">Red</ul>
<div data-testid="review-summary">Great film</div>
<div data-testid="review-content">Loved every minute.</div>
<li data-testid="rating-item"><span class="ipc-metadata-list-item__label">Violence</span><div class="ipc-html-content-inner-div">Moderate</div></li>
<div data-testid="episode-card"><a href="/title/tt0663882/">E1</a></div>
</body></html>`;

const WAF_HTML = `<html><head></head><body><div id="challenge-container"></div><script src="https://fb423e1ef94f.token.awswaf.com/challenge.js"></script><script>window.gokuProps={};</script></body></html>`;

describe("extractors", () => {
  it("extracts JSON-LD movie blocks", () => {
    const blocks = extractJsonLdBlocks(LD_HTML);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.name).toBe("The Shawshank Redemption");
    expect(blocks[0]?.duration).toBe("PT2H22M");
  });

  it("extracts __NEXT_DATA__", () => {
    const nd = extractNextData(LD_HTML);
    expect(nd).not.toBeNull();
  });

  it("detects WAF challenge pages", () => {
    expect(isWafChallengeHtml(WAF_HTML)).toBe(true);
    expect(isWafChallengeHtml(LD_HTML)).toBe(false);
  });

  it("parses ISO durations", () => {
    expect(parseIso8601DurationToMinutes("PT2H22M")).toBe(142);
    expect(parseIso8601DurationToMinutes("PT45M")).toBe(45);
    expect(formatMinutes(142)).toBe("2h 22m");
    expect(formatMinutes(null)).toBeNull();
  });

  it("falls back to DOM for cast/reviews/parental/episodes", () => {
    const cast = extractCastFallback(DOM_HTML);
    expect(cast).toHaveLength(2);
    expect(cast[0]?.name).toBe("Tim Robbins");
    expect(cast[0]?.imdbId).toBe("nm0000209");

    const revs = extractReviewsFallback(DOM_HTML);
    expect(revs).toHaveLength(1);
    expect(revs[0]?.title).toBe("Great film");

    const pg = extractParentalGuideFallback(DOM_HTML);
    expect(pg).toHaveLength(1);
    expect(pg[0]?.type).toBe("Violence");

    const eps = extractEpisodeIds(DOM_HTML);
    expect(eps).toEqual(["tt0663882"]);
  });

  it("never uses hashed sc-* classes", async () => {
    const { SELECTORS } = await import("../src/imdb/selectors.js");
    const all = JSON.stringify(SELECTORS);
    expect(all).not.toMatch(/sc-[a-z0-9]{4,}/);
  });
});

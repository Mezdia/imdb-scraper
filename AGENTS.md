SPEAK ENGLISH

# IScrapeMDB — Agent Rules (binding)

## 1. Language
- Communicate with the user in the language they use. Code, comments, docs, and
  commit messages are in English.

## 2. IMDb-only source rule (STRICT, binding)
- The ONLY permitted data source is IMDb and its official IMDb-owned
  infrastructure. Nothing else. No exceptions.
- Allowed hosts (closed allow-list):
  - `imdb.com`, `www.imdb.com`, `m.imdb.com`
  - `v3.sg.media-imdb.com`, `sg.media-imdb.com` (official suggestion API)
  - `datasets.imdbws.com`, `developer.imdb.com` (official bulk datasets + docs)
  - `m.media-amazon.com` **only** for image bytes/URLs that IMDb itself returns
    (poster/still CDN). No other use.
- Explicitly FORBIDDEN as data sources: TMDB, TVDB, OMDB, Wikidata, Wikipedia,
  Bing/Google images, any search-engine cache, any third-party API or scraper
  proxy, any non-IMDb CDN.
- The old viewer fallback to `tse*.mm.bing.net` is removed and must never return.
  If no IMDb poster exists, render a local placeholder instead.
- Every new network call MUST go through `src/imdb/guard.ts`
  (`assertImdbOnlyUrl()`). Direct `fetch()`/`page.goto()` to an unvalidated URL
  is a violation. Add a unit test for every new host you touch.

## 3. Creative IMDb-only recovery (binding)
- If access to some IMDb page/endpoint fails (WAF challenge, 202 empty body,
  403/429, selector change, layout change, timeout), the agent MUST try a
  creative recovery path that stays 100% inside the IMDb allow-list above.
  Never switch to an external source.
- Recovery ladder (in order, stop at first success):
  1. Retry with backoff + real-browser headers (Accept-Language, Referer,
     Sec-Fetch-*, Upgrade-Insecure-Requests).
  2. Solve/await the AWS WAF JS challenge in a real browser engine
     (Playwright + JS enabled), then reload and continue.
  3. Try alternate official IMDb URL forms for the same entity:
     `/reference/`, `/reviews/`, `/parentalguide/`, `/episodes/`,
     `m.imdb.com` mirror of the same path.
  4. Fall back to official IMDb bulk datasets (`datasets.imdbws.com` TSVs)
     and/or the official suggestion API (`v3.sg.media-imdb.com`).
  5. Parse embedded official data first (`__NEXT_DATA__`, `application/ld+json`,
     `__APOLLO_STATE__`) before DOM selectors; use stable `data-testid`
     selectors only as a last resort.
  6. Record partial data with explicit `missing[]` provenance instead of failing
     the whole job or inventing data from elsewhere.
- Log every fallback at `warn` level with the IMDb URL that was tried.

## 4. Engineering standards
- TypeScript strict, ESM, Node 20+. `npm run build` and `npm test` must pass.
- A real crawler: bounded concurrency queue, per-host politeness delay, retries
  with jitter, resume/skip of already-scraped ids, structured JSON output.
- No hard-coded hashed CSS classes. Selectors live in `src/imdb/selectors.ts`
  (stable `data-testid` / semantic selectors only).
- New IMDb data-access code goes through the `ImdbClient` library
  (`src/imdb/client.ts`, barrel `src/imdb/index.ts`). No ad-hoc IMDb fetches.
- Dependencies are justified by verification: a library is added only after an
  experiment proves it improves IMDb extraction. No decorative dependencies.
  External captcha/WAF-solving services are forbidden (non-IMDb sources).
- Verify by execution: unit tests (vitest, offline fixtures) for every new
  extractor/parser; `npm run build` before finishing.

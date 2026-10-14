SPEAK ENGLISH

# IScrapeMDB — Agent Rules (binding)

## 1. Language
- Communicate with the user in the language they use. Code, comments, docs, and
  commit messages are in English.

## 2. IMDb-only source rule (STRICT, binding)
- The ONLY permitted data source is IMDb and its official IMDb-owned
  infrastructure. Nothing else. No exceptions — except the single BETA
  exception defined in §5 (archived IMDb snapshots, opt-in, last-resort only).
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
  (`assertImdbOnlyUrl()`) — or, for the §5 beta path only, through
  `src/archive/archiveGuard.ts` (`assertArchiveUrl()`). Direct
  `fetch()`/`page.goto()` to an unvalidated URL is a violation.
  Add a unit test for every new host you touch.

## 3. Creative IMDb-only recovery (binding)
- If access to some IMDb page/endpoint fails (WAF challenge, 202 empty body,
  403/429, selector change, layout change, timeout), the agent MUST try a
  creative recovery path that stays 100% inside the IMDb allow-list above.
  Never switch to an external source — except §5, and only after this
  ladder is fully exhausted.
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
  7. **BETA ONLY:** if steps 1–6 all failed AND `--archive-beta` was passed,
     escalate to the §5 archived-IMDb fallback. Otherwise stop at step 6.
- Log every fallback at `warn` level with the IMDb URL that was tried.

## 4. Engineering standards
- TypeScript strict, ESM, Node 20+. `npm run build` and `npm test` must pass.
- A real crawler: bounded concurrency queue, per-host politeness delay, retries
  with jitter, resume/skip of already-scraped ids, structured JSON output.
- No hard-coded hashed CSS classes. Selectors live in `src/imdb/selectors.ts`
  (stable `data-testid` / semantic selectors only). The §5 beta path MUST NOT
  add selectors there — its selectors (if any) live in `src/archive/`.
- New IMDb data-access code goes through the `ImdbClient` library
  (`src/imdb/client.ts`, barrel `src/imdb/index.ts`). No ad-hoc IMDb fetches.
- New archive data-access code goes through the `ArchiveClient` library
  (`src/archive/` only, see §5). No ad-hoc archive fetches, no edits to
  `src/imdb/*` for archive support.
- Dependencies are justified by verification: a library is added only after an
  experiment proves it improves IMDb extraction. No decorative dependencies.
  External captcha/WAF-solving services are forbidden (non-IMDb sources).
- Verify by execution: unit tests (vitest, offline fixtures) for every new
  extractor/parser; `npm run build` before finishing.

## 5. Archive fallback — BETA, opt-in, isolated, last-resort (binding)
- Purpose: when every §3 step (HTTP → browser → alternate IMDb URLs →
  datasets/suggestion → embedded-data parsing) has been tried for an IMDb
  entity and still yields no usable page-html, the crawler MAY retry the
  exact same IMDb URL via its archived snapshot on the Wayback Machine:
  `https://web.archive.org/web/<timestamp>id_/https://www.imdb.com/...`
  ("most recent available snapshot" = latest timestamp).
- This is BETA: disabled by default, explicitly opt-in, and structurally
  isolated from the main CLI path. It is still part of the same `iscrapemdb`
  binary (`dist/cli.js`) — no second binary, no separate package.
- 5.1 Trigger (last-resort only):
  - Archive is NEVER a primary source, NEVER used for search, datasets, or
    gallery bytes. Only for title/entity pages already marked
    `missing[]: page-html (WAF-blocked…)` after §3 steps 1–6.
  - Gating flag required: `--archive-beta` enables, default OFF. Without the
    flag the code path MUST NOT execute any archive network I/O.
  - Optional `--archive-timestamp <latest|YYYYMMDDHHMMSS>` (default `latest`).
    `latest` resolves to the most recent available snapshot via the archive
    CDX/availability lookup for that exact IMDb URL.
  - Per-title flow: attempt §3 → if page-html still null AND flag on → ONE
    bounded archive attempt per URL form → merge → record provenance.
- 5.2 Allow-list exception (closed, beta-only):
  - Sole permitted archive host: `web.archive.org`. No other archive mirror,
    proxy, or cache (`archive.today`, `arquivo.pt`, Google cache, etc.).
  - Sole permitted URL shape (enforced by `assertArchiveUrl()`):
    `^https://web\.archive\.org/web/\d{1,14}(id_)?/https?://((www|m)\.)?imdb\.com/.*`
    The embedded URL MUST itself pass `isImdbOnlyUrl()` logic. Anything else
    (non-IMDb embedded URL, `liveweb`, `if_`, bare domain) is rejected with
    `NonImdbSourceError`-equivalent `NonArchivedImdbUrlError`.
  - NEVER add `web.archive.org` to `src/imdb/constants.ts` `ALLOWED_HOSTS`.
    That set stays IMDb-owned only. Archive validation lives ONLY in
    `src/archive/archiveGuard.ts` with its own unit tests.
- 5.3 Isolation (files separate, still part of CLI):
  - All new code lives under `src/archive/`:
    `archiveGuard.ts` (URL validation + `archiveFetch` wrapper),
    `archiveClient.ts` (snapshot resolution + fetch + merge entry-point),
    `archiveTypes.ts` (options/provenance types),
    `index.ts` (barrel). Optional `archiveSelectors.ts` ONLY if
    archive-specific DOM fallbacks are proven necessary.
  - FORBIDDEN: editing `src/imdb/guard.ts`, `src/imdb/constants.ts`,
    `src/imdb/selectors.ts`, `src/crawler/*` to hard-wire archive logic.
    Pure parser reuse (`crawler/extractors.ts`, `crawler/graphql.ts` as pure
    functions on HTML strings) is allowed via import; network/queue/engine
    code is NOT shared — the archive client owns its own politeness delay
    (stricter, e.g. ≥3000 ms) and reuses `runWithConcurrency` only as a
    caller, never by patching it.
  - CLI wiring is THIN: `src/cli.ts` only parses `--archive-beta`,
    `--archive-timestamp`, `--no-archive-beta` and passes an
    `ArchiveOptions { enabled, timestamp }` object down. All branching logic
    lives in `src/archive/`. `--help` MUST label these flags `(BETA)`.
- 5.4 Parsing, provenance, and honesty:
  - Prefer the same order as live: `__NEXT_DATA__` → `application/ld+json` →
    stable `data-testid` DOM. No hashed CSS classes, no invented fields.
  - Every archive-derived record MUST push
    `provenance: "archive:<snapshot-timestamp>:<original-imdb-url>"` plus keep
    all prior `missing[]` entries that were recovered. Unrecovered fields stay
    in `missing[]`. Add `archivedAt: <snapshot-timestamp>` and
    `archiveUrl: <full-wayback-url>` to the record (nullable when unused).
  - Log at `warn`: `Archive BETA fallback for <imdbId>: <archiveUrl>
    (snapshot <timestamp>)` on use, and on failure
    `Archive BETA miss for <imdbId>: <reason>`.
  - Images: same rule as §2 — IMDb CDN URLs found inside the snapshot are
    kept, otherwise local placeholder. Never fetch image bytes from the
    archive host as a gallery CDN; re-host check via `m.media-amazon.com`
    only.
- 5.5 Tests and docs (required to call it done):
  - `tests/archiveGuard.test.ts`: allows valid snapshot URLs, rejects
    non-IMDb embedded URLs, liveweb variants, and foreign archive hosts.
  - `tests/archiveClient.test.ts`: offline fixtures (saved Wayback HTML for
    one movie + one series fragment) proving `__NEXT_DATA__`/JSON-LD parsing
    works and provenance/`archivedAt` are set; flag-OFF test proving zero
    archive fetch attempts.
  - `README.md` + `--help` document the beta flags, the last-resort trigger,
    and the `web.archive.org/web/<timestamp>/https://www.imdb.com/...`
    pattern. `npm run build` and `npm test` must pass.

# IScrapeMDB v2 — Real IMDb-Only Crawler (TypeScript)

A complete rewrite of the v1 Python/Selenium scraper as a strictly-typed,
resilient, real crawler. **The only permitted data source is IMDb**
(see `AGENTS.md`). No TMDB, no Wikipedia, no Bing images, no third-party APIs.

> v2 is a clean rewrite: the legacy v1 Python scraper has been removed.
> This repository is now TypeScript-only.

## Why a rewrite (v1 bugs fixed by starting over)

| v1 problem | v2 fix |
|---|---|
| Hashed CSS classes (`sc-b4f120f6-0…`) broke on every IMDb deploy | Embedded `application/ld+json` + `__NEXT_DATA__` first, stable `data-testid` only as fallback (`src/imdb/selectors.ts`) |
| `getTargetRev` returned 3 different types (list / tuple / exception) | Strict `TitleRecord` type everywhere |
| Series loop off-by-one + recursion risk | Episode graph from official `title.episode.tsv` + bounded `maxEpisodes` |
| Poster fallback to `tse*.mm.bing.net` (non-IMDb!) | Removed; IMDb CDN (`m.media-amazon.com`) or local SVG placeholder |
| Plain HTTP gets empty `202` (AWS WAF challenge) with no recovery | Recovery ladder: HTTP → WAF-aware Playwright → alternate IMDb URL forms → official datasets/suggestion API (all IMDb-only) |
| No concurrency, no resume, no rate limiting | Bounded queue, politeness delay, retries with jitter, `--resume` |
| No tests | 29 offline unit tests (`npm test`) |

## Verified live behavior (2026-10-14, this container)

- `www.imdb.com` plain-HTTP returns `202` + AWS WAF JS challenge → crawler
  escalates per the ladder instead of failing or using another source.
- Official suggestion API (`v3.sg.media-imdb.com`) returns search + posters.
- Official datasets (`datasets.imdbws.com/title.ratings.tsv.gz`) enrich
  rating/votes WAF-free. Provenance is recorded per field in `data.json`.

## Install

```bash
npm install
# only needed for full-page (reviews/guide/episodes) scraping:
npx playwright install chromium
```

## Use

```bash
# Single title (URL or bare id)
node ./dist/cli.js "https://www.imdb.com/title/tt0111161/"
node ./dist/cli.js tt0111161 --browser off --no-html

# Search by name (IMDb suggestion API), scrape top hit
node ./dist/cli.js -s "shawshank"

# Batch from file (one URL/id per line)
node ./dist/cli.js -f links.txt

# Named list
node ./dist/cli.js -f links.txt -l "Nolan_Night"

# Fast (skip reviews + parental guide) + single-file portable export
node ./dist/cli.js tt0111161 --fast --portable

# Photo gallery (IMDb CDN stills only, nothing external)
node ./dist/cli.js tt0111161 --gallery --max-photos 20

# Bulk enrichment from official IMDb datasets (one-time download)
node ./dist/cli.js tt0111161 --datasets

# Archive fallback (BETA, last-resort only — off by default)
node ./dist/cli.js tt0111161 --archive-beta --archive-timestamp latest
```

Full flags: `node ./dist/cli.js --help`.

## Archive fallback (BETA, isolated)

When every live method fails (HTTP → browser WAF solving → alternate IMDb
URL forms → datasets/suggestion → embedded-data parsing) and the record is
still `missing: page-html`, the crawler can retry the exact same IMDb URL
via its Wayback snapshot:

`https://web.archive.org/web/<timestamp>id_/https://www.imdb.com/...`

- Opt-in only: `--archive-beta` (default OFF — zero archive I/O without it),
  `--archive-timestamp latest|YYYYMMDDHHMMSS` (default `latest` = auto-resolved
  newest available snapshot via Wayback CDX lookup for that exact IMDb URL,
  with `2id_` redirect as fallback).
- Robust by verification (live web.archive.org probes, Oct 2026): `latest`
  walks recent CDX captures newest-first (up to 3 snapshot fetches) and keeps
  the richest — the newest capture is often an AWS WAF interstitial while an
  older one is rich. CDX 503s are retried with backoff; IMDb 404 pages,
  challenge pages and site-chrome JSON-LD are rejected so they can never
  poison the merged record; gallery dedupes by canonical image id.
- Isolated by design: all code lives in `src/archive/` (`archiveGuard.ts`,
  `archiveClient.ts`, `archiveTypes.ts`) with its own `assertArchiveUrl()`
  guard. `web.archive.org` is never added to the IMDb allow-list, and
  `src/imdb/*` / `src/crawler/*` are untouched. Still part of the same
  `iscrapemdb` binary — no second CLI.
- Provenance is explicit: `provenance[]` gets
  `archive:<snapshot-timestamp>:<original-imdb-url>`, plus `archivedAt` /
  `archiveUrl` fields. Images stay IMDb-CDN-only or placeholder.

## Output

```
Scraped/
  Movies/<Title> (<Year>) [<tt-id>]/
    data.json        # canonical record + missing[] + provenance[]
    data/main.js     # legacy MAIN_DATA compat
    data/review.js   # legacy REVIEW_DATA compat
    index.html       # offline viewer (no external requests)
    portable.html    # --portable single-file export
  Lists/<Name>/      # data.json array + merged maps + list viewer
```

## Extracted fields (categorized)

- **A. Identity:** title, originalTitle, titleType, kind, isAdult, akas (localized titles)
- **B. Dates/origin:** year, releaseDate, endYear, countries, languages, filmingLocations, productionCompanies
- **C. Ratings:** IMDb rating + votes, metascore, Top-250 rank
- **D. Story:** plot/description, tagline, genres, keywords
- **E. Production:** runtime, certification, color, sound mix, awards summary
- **F. Money:** budget, opening weekend, USA + worldwide gross
- **G. People:** directors, writers, creators, cast (name/role/nm id)
- **H. Gallery:** poster + stills (`--gallery`, IMDb CDN only), trailers (IMDb video links), photo/video counts
- **I. Guidance/reviews:** parental guide (severity + votes + breakdown + item texts), reviews (author, rating, date, helpful votes) + total count
- **J. Series:** episodes (id/title/air-date/rating/votes/poster/plot), counts, total seasons; `--deep-episodes` crawls each episode as its own record

Unobtainable fields are listed in `missing[]`, never invented.

## Develop

```bash
npm run build   # tsc
npm test        # vitest (offline, no network)
```

## IMDb client library (`src/imdb/`)

The dedicated, reusable data-access layer — import it in your own code:

```ts
import { ImdbClient } from "./dist/imdb/index.js";

const imdb = new ImdbClient();
await imdb.search("shawshank");          // official suggestion API
imdb.title("tt0111161");                 // validated canonical URL
await imdb.ensureDataset("title.ratings.tsv.gz");
imdb.ratings("tt0111161");               // { averageRating, numVotes }
imdb.seriesEpisodes("tt0903747");        // season/episode rows
```

Every method enforces the IMDb-only allow-list. Only three runtime
dependencies exist (`cheerio`, `commander`, `playwright`) — each verified
to earn its place (a stealth-plugin experiment was tested and rejected
because it did not improve WAF solving).

## License

Polyform Non-Commercial License 1.0.0 — see `LICENSE`.
Personal, educational, research use only. Respect IMDb's terms of service.

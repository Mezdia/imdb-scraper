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
```

Full flags: `node ./dist/cli.js --help`.

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

## License

Polyform Non-Commercial License 1.0.0 — see `LICENSE`.
Personal, educational, research use only. Respect IMDb's terms of service.

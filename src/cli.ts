#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { normalizeTitleInput } from "./imdb/ids.js";
import { searchTitles } from "./imdb/suggestion.js";
import { ensureDataset, datasetUrl } from "./imdb/datasets.js";
import { BrowserEngine } from "./crawler/engine.js";
import { crawlTitle } from "./crawler/titleCrawler.js";
import { runWithConcurrency } from "./crawler/queue.js";
import { storeRecord, alreadyScraped } from "./store/jsonStore.js";
import { writeViewer, writePortable, writeListViewer } from "./store/html.js";
import { DEFAULT_CRAWL_OPTIONS, type CrawlOptions, type TitleRecord } from "./imdb/types.js";
import { logger, setVerbose } from "./logger.js";

const program = new Command();
program
  .name("iscrapemdb")
  .description("IScrapeMDB v2 — real IMDb-only crawler (TypeScript)")
  .version("2.0.0");

program
  .argument("[targets...]", "IMDb title URLs or tt ids")
  .option("-f, --file <path>", "text file with one IMDb URL/id per line")
  .option("-s, --search <query>", "search IMDb by name (suggestion API) and scrape top hit")
  .option("-l, --list <name>", "save results into a named list (Scraped/Lists/<name>)")
  .option("-t, --type <kind>", "force media type (movie|series)")
  .option("--fast", "skip reviews + parental guide")
  .option("-r, --deep-reviews", "load more reviews")
  .option("--no-reviews", "skip reviews")
  .option("--no-pg", "skip parental guide")
  .option("--no-episodes", "skip episode enumeration")
  .option("--max-episodes <n>", "cap episodes per series", "500")
  .option("--browser <mode>", "browser engine: auto|on|off", "auto")
  .option("--head", "run browser visible (headed)")
  .option("--no-html", "skip index.html viewer")
  .option("--portable", "also write portable.html")
  .option("-o, --out <dir>", "output root", "Scraped")
  .option("-c, --concurrency <n>", "parallel titles", "3")
  .option("--politeness <ms>", "delay between requests per lane", "1200")
  .option("--retries <n>", "retries per title", "3")
  .option("--resume", "skip titles already scraped (default true)", true)
  .option("--datasets", "pre-download official IMDb datasets for bulk enrichment")
  .option("--verbose", "debug logging")
  .action(async (targets: string[], opts) => {
    setVerbose(Boolean(opts.verbose));
    const crawl: CrawlOptions = {
      ...DEFAULT_CRAWL_OPTIONS,
      includeReviews: opts.fast ? false : opts.reviews !== false,
      includeParentsGuide: opts.fast ? false : opts.pg !== false,
      deepReviews: Boolean(opts.deepReviews),
      includeEpisodes: opts.episodes !== false,
      maxEpisodes: Number(opts.maxEpisodes ?? 500),
      concurrency: Math.max(1, Number(opts.concurrency ?? 3)),
      politenessMs: Number(opts.politeness ?? 1200),
      retries: Number(opts.retries ?? 3),
      headless: !opts.head,
      engine: opts.browser === "on" ? "browser" : opts.browser === "off" ? "datasets" : "auto",
    };

    // --- collect inputs ----------------------------------------------------
    let inputs: string[] = [...(targets ?? [])];
    if (opts.file) {
      if (!existsSync(opts.file)) {
        logger.error(`Input file not found: ${opts.file}`);
        process.exit(1);
      }
      const lines = readFileSync(opts.file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
      inputs.push(...lines);
    }
    if (opts.search) {
      logger.info(`Searching IMDb for "${opts.search}"…`);
      const hits = await searchTitles(opts.search, 5);
      if (!hits.length) {
        logger.error("No IMDb results for search query.");
        process.exit(1);
      }
      logger.info(`Top hit: ${hits[0]?.label} (${hits[0]?.id})`);
      inputs.push(hits[0]?.id as string);
    }
    if (!inputs.length) {
      program.help();
      return;
    }

    // --- resolve to title ids (IMDb-only validation) -----------------------
    const ids: string[] = [];
    for (const raw of inputs) {
      try {
        if (/^tt\d{7,10}$/i.test(raw.trim())) {
          ids.push(raw.trim().toLowerCase());
          continue;
        }
        const { imdbId } = normalizeTitleInput(raw);
        ids.push(imdbId);
      } catch (e) {
        logger.error(`Skipping invalid input "${raw}": ${(e as Error).message}`);
      }
    }
    const unique = [...new Set(ids)];
    if (!unique.length) {
      logger.error("No valid IMDb title ids to scrape.");
      process.exit(1);
    }

    if (opts.datasets) {
      for (const f of ["title.basics.tsv.gz", "title.ratings.tsv.gz", "title.episode.tsv.gz"] as const) {
        try {
          logger.info(`Ensuring dataset ${f} — ${datasetUrl(f)}`);
          await ensureDataset(f);
        } catch (e) {
          logger.warn(`Dataset ${f} unavailable: ${(e as Error).message}`);
        }
      }
    }

    const needBrowser = crawl.engine !== "datasets";
    const engine = needBrowser ? new BrowserEngine({ headless: crawl.headless, timeoutMs: 45_000 }) : null;
    if (engine) {
      try {
        await engine.launch();
        logger.success("Browser engine online (WAF-aware)");
      } catch (e) {
        logger.warn(`Browser unavailable, continuing datasets+HTTP only: ${(e as Error).message}`);
      }
    }

    const listName = opts.list as string | undefined;
    const outRoot = opts.out as string;
    const results: TitleRecord[] = [];

    logger.info(`Scraping ${unique.length} title(s) — concurrency ${crawl.concurrency}`);
    const { ok, failed } = await runWithConcurrency(
      unique,
      async (id) => {
        const pre = { imdbId: id, title: id, kind: "movie", year: null } as const;
        if (opts.resume && alreadyScraped(outRoot, { ...pre, kind: opts.type ?? "movie" }, listName)) {
          logger.info(`Resume: skipping already-scraped ${id}`);
          return;
        }
        const t0 = Date.now();
        logger.info(`[${id}] crawling…`);
        const rec = await crawlTitle(id, crawl, engine);
        if (opts.type === "movie" || opts.type === "series") rec.kind = opts.type;
        const stored = storeRecord(outRoot, rec, listName);
        if (opts.html !== false) {
          if (listName) {
            // List viewer renders the whole list; refresh after every record.
            let all: TitleRecord[] = [];
            try {
              const cur = JSON.parse(readFileSync(stored.jsonPath, "utf8")) as unknown;
              if (Array.isArray(cur)) all = cur as TitleRecord[];
            } catch {
              all = [rec];
            }
            writeListViewer(stored.indexHtml, listName, all);
          } else {
            writeViewer(stored.indexHtml, rec);
          }
        }
        if (opts.portable) {
          const p = writePortable(stored.dir, rec);
          logger.success(`Portable: ${p}`);
        }
        results.push(rec);
        const miss = rec.missing?.length ? ` | missing: ${rec.missing.join(", ")}` : "";
        logger.success(`[${id}] "${rec.title}" (${rec.year ?? "?"}) rating=${rec.rating ?? "?"} in ${((Date.now() - t0) / 1000).toFixed(1)}s${miss}`);
      },
      { concurrency: crawl.concurrency, politenessMs: crawl.politenessMs, retries: crawl.retries },
    );

    await engine?.close().catch(() => undefined);
    logger.success(`Done: ${ok} ok, ${failed} failed. Output: ${outRoot}/`);
    if (failed > 0) {
      logger.warn(
        `IMDb-only note: ${failed} title(s) incomplete — all recovery stayed inside IMDb (datasets/suggestion/browser). No external source was used. Re-run with --datasets or check data.json "missing" fields.`,
      );
    }
  });

program
  .command("search <query>")
  .description("Search IMDb by name (official suggestion API, IMDb-only)")
  .action(async (query: string) => {
    const hits = await searchTitles(query, 10);
    for (const h of hits) {
      console.log(`${h.id}\t${h.year ?? ""}\t${h.kind}\t${h.label}${h.stars ? ` — ${h.stars}` : ""}`);
    }
    if (!hits.length) console.log("No results.");
  });

program.parseAsync(process.argv);

import { assertImdbOnlyUrl, imdbFetch } from "../imdb/guard.js";
import { imdbHtmlHeaders } from "../imdb/constants.js";
import { isWafChallengeHtml } from "./extractors.js";
import { logger } from "../logger.js";
import { sleep } from "./queue.js";

// ---------------------------------------------------------------------------
// Browser engine (Playwright, lazy-loaded so unit tests never need a browser).
// Solves the AWS WAF JS challenge by running real JS, then reloads.
// Every navigation is IMDb-only guarded.
// ---------------------------------------------------------------------------

export interface EngineOptions {
  headless: boolean;
  timeoutMs: number;
  /** Reused WAF-cookie jar (IMDb-issued tokens only). */
  storagePath?: string;
}

export interface PageSnapshot {
  url: string;
  html: string;
  status: number | null;
  wafChallenge: boolean;
}

type PlaywrightModule = typeof import("playwright");

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      'The "playwright" package is required for browser crawling. Run: npm install && npx playwright install chromium',
    );
  }
}

export class BrowserEngine {
  private opts: EngineOptions;
  private browser: import("playwright").Browser | null = null;
  private playwright: PlaywrightModule | null = null;

  constructor(opts: EngineOptions) {
    this.opts = opts;
  }

  async launch(): Promise<void> {
    this.playwright = await loadPlaywright();
    const { chromium } = this.playwright;
    this.browser = await chromium.launch({
      headless: this.opts.headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--mute-audio",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  /**
   * Navigate to an IMDb URL and return the rendered HTML.
   * Handles the WAF challenge: wait for it to solve (polling), reload,
   * retry. Solved IMDb cookies are persisted to storagePath for reuse.
   */
  async goto(url: string, retries = 2): Promise<PageSnapshot> {
    assertImdbOnlyUrl(url);
    if (!this.browser) await this.launch();
    const browser = this.browser;
    if (!browser) throw new Error("Browser failed to launch");

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      storageState: this.opts.storagePath && (await import("node:fs")).existsSync(this.opts.storagePath)
        ? this.opts.storagePath
        : undefined,
    });
    // Keep JS enabled (WAF challenge needs it). Block only heavy media.
    await context.route("**/*.{mp4,webm,avi,mov}", (r) => r.abort()).catch(() => undefined);

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(this.opts.timeoutMs);
    let lastErr: unknown = null;

    const isSolved = async (): Promise<boolean> => {
      try {
        return await page.evaluate(() => {
          if (document.querySelector("#challenge-container")) return false;
          // Prefer the rich embedded payload; IMDb sometimes serves a
          // lightweight variant (ld+json only, no __NEXT_DATA__) that loses
          // GraphQL facts — keep waiting briefly for the full payload.
          if (document.querySelector("#__NEXT_DATA__")) return true;
          if (document.querySelector('script[type="application/ld+json"]')) return true;
          return document.body && document.body.innerText.length > 2000;
        });
      } catch {
        return false;
      }
    };

    const hasRichPayload = async (): Promise<boolean> => {
      try {
        return await page.evaluate(() => !!document.querySelector("#__NEXT_DATA__"));
      } catch {
        return false;
      }
    };

    const waitForSolve = async (budgetMs: number): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < budgetMs) {
        if (await isSolved()) return true;
        await sleep(1500);
      }
      return isSolved();
    };

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await page.goto(url, { waitUntil: "domcontentloaded" });
        const status = res?.status() ?? null;
        let solved = await waitForSolve(20_000);
        if (!solved) {
          logger.warn(`WAF challenge at ${url} (attempt ${attempt + 1}); reloading…`);
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
          solved = await waitForSolve(20_000);
        }
        // Solved but lightweight (no __NEXT_DATA__)? One reload often yields
        // the rich variant — try once before accepting the degraded page.
        if (solved && !(await hasRichPayload())) {
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
          const rich = await waitForSolve(15_000);
          if (rich && (await hasRichPayload())) {
            solved = true;
          }
        }
        const html = await page.content();
        const waf = !solved && isWafChallengeHtml(html);
        if (solved) {
          // Persist IMDb-issued cookies (WAF token) for the next navigations.
          if (this.opts.storagePath) {
            await context.storageState({ path: this.opts.storagePath }).catch(() => undefined);
          }
          const out = { url: page.url(), html, status, wafChallenge: false };
          await context.close().catch(() => undefined);
          return out;
        }
        logger.warn(`Browser still challenged for ${url}`);
        if (attempt === retries) {
          await context.close().catch(() => undefined);
          return { url: page.url(), html, status, wafChallenge: waf };
        }
      } catch (e) {
        lastErr = e;
        logger.warn(`Navigation failed (${url}) attempt ${attempt + 1}: ${(e as Error).message}`);
        await sleep(1500 * (attempt + 1));
      }
    }
    await context.close().catch(() => undefined);
    throw lastErr instanceof Error ? lastErr : new Error(`Failed to load ${url}`);
  }

  /**
   * Navigate, solve WAF, then scroll to trigger lazy/infinite loading
   * (e.g. review pagination). Stops when the item count stabilizes.
   */
  async gotoWithScroll(url: string, itemSelector: string, rounds = 6): Promise<PageSnapshot> {
    assertImdbOnlyUrl(url);
    if (!this.browser) await this.launch();
    const browser = this.browser;
    if (!browser) throw new Error("Browser failed to launch");

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      storageState:
        this.opts.storagePath && (await import("node:fs")).existsSync(this.opts.storagePath)
          ? this.opts.storagePath
          : undefined,
    });
    await context.route("**/*.{mp4,webm,avi,mov}", (r) => r.abort()).catch(() => undefined);
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(this.opts.timeoutMs);
    try {
      const res = await page.goto(url, { waitUntil: "domcontentloaded" });
      const status = res?.status() ?? null;
      for (let i = 0; i < 14; i++) {
        const solved = await page
          .evaluate(
            () => !document.querySelector("#challenge-container") && document.body.innerText.length > 2000,
          )
          .catch(() => false);
        if (solved) break;
        await sleep(1500);
      }
      let lastCount = -1;
      let stable = 0;
      for (let r = 0; r < rounds; r++) {
        const count = await page
          .evaluate((sel) => {
            window.scrollBy(0, document.body.scrollHeight);
            return document.querySelectorAll(sel).length;
          }, itemSelector)
          .catch(() => lastCount);
        if (count === lastCount) {
          stable++;
          if (stable >= 2) break;
        } else {
          stable = 0;
          lastCount = count;
        }
        await sleep(2500);
      }
      const html = await page.content();
      const out = { url: page.url(), html, status, wafChallenge: isWafChallengeHtml(html) };
      await context.close().catch(() => undefined);
      return out;
    } catch (e) {
      await context.close().catch(() => undefined);
      throw e;
    }
  }
}

/**
 * Plain-HTTP fetch of IMDb HTML with real-browser headers.
 * Returns null when blocked (WAF 202/empty) so the caller can escalate to the
 * browser engine — per the creative-recovery ladder, staying IMDb-only.
 */
export async function fetchImdbHtml(url: string, timeoutMs = 30_000): Promise<string | null> {
  assertImdbOnlyUrl(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await imdbFetch(url, { headers: imdbHtmlHeaders(), signal: ctrl.signal });
    const text = await res.text();
    if (!text || text.length < 500) {
      logger.warn(`IMDb returned empty/blocked body (${res.status}) for ${url} — escalate to browser engine`);
      return null;
    }
    if (isWafChallengeHtml(text)) {
      logger.warn(`WAF challenge detected via HTTP for ${url} — escalate to browser engine`);
      return null;
    }
    return text;
  } catch (e) {
    logger.warn(`HTTP fetch failed for ${url}: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

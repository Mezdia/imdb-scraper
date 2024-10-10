import { assertImdbOnlyUrl } from "../imdb/guard.js";
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
   * Handles the WAF challenge: wait for it to solve, reload, retry.
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
    });
    // Keep JS enabled (WAF challenge needs it). Block only heavy media.
    await context.route("**/*.{mp4,webm,avi,mov}", (r) => r.abort()).catch(() => undefined);

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(this.opts.timeoutMs);
    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await page.goto(url, { waitUntil: "domcontentloaded" });
        const status = res?.status() ?? null;
        // Give the WAF challenge script time to mint a token + reload.
        await page
          .waitForFunction(
            () => !document.querySelector("#challenge-container") || document.title.length > 0,
            { timeout: 12_000 },
          )
          .catch(() => undefined);
        await sleep(1500);
        let html = await page.content();
        if (isWafChallengeHtml(html)) {
          logger.warn(`WAF challenge at ${url} (attempt ${attempt + 1}); waiting for auto-solve…`);
          await sleep(6000);
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
          await sleep(2000);
          html = await page.content();
        }
        const waf = isWafChallengeHtml(html);
        await context.close().catch(() => undefined);
        return { url: page.url(), html, status, wafChallenge: waf };
      } catch (e) {
        lastErr = e;
        logger.warn(`Navigation failed (${url}) attempt ${attempt + 1}: ${(e as Error).message}`);
        await sleep(1500 * (attempt + 1));
      }
    }
    await context.close().catch(() => undefined);
    throw lastErr instanceof Error ? lastErr : new Error(`Failed to load ${url}`);
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
    const res = await fetch(url, { headers: imdbHtmlHeaders(), signal: ctrl.signal });
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

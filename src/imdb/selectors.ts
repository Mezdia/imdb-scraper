/**
 * Stable selectors only. Hashed CSS-module classes (sc-xxxx) are FORBIDDEN
 * here — they rotate on every IMDb deploy and were the #1 cause of breakage
 * in the v1 Python scraper. Prefer embedded JSON, then data-testid.
 */
export const SELECTORS = {
  // JSON-LD + Next.js payload (primary, official data embedded by IMDb)
  jsonLd: 'script[type="application/ld+json"]',
  nextData: "#__NEXT_DATA__",
  apolloState: "#__APOLLO_STATE__",

  // Stable, semantic DOM fallbacks
  title: [
    '[data-testid="hero__pageTitle"]',
    '[data-testid="hero-title-block__title"]',
    "h1",
  ],
  rating: [
    '[data-testid="hero-rating-bar__aggregate-rating__score"]',
    '[data-testid="reviewSummary-rating"]',
  ],
  plot: [
    '[data-testid="plot"]',
    '[data-testid="plot-xl"]',
    '[data-testid="storyline-plot"]',
  ],
  genres: ['[data-testid="genres"] a', '[data-testid="storyline-genres"] a'],
  castActor: 'a[data-testid="title-cast-item__actor"]',
  castRole: 'ul[data-testid="cast-item-characters-list"]',
  directorRow:
    'li[data-testid="title-pc-principal-credit"]',
  runtime: 'li[data-testid="title-techspec_runtime"]',
  reviewTitle: '[data-testid="review-summary"]',
  reviewBody: '[data-testid="review-content"]',
  parentalItem: 'li[data-testid="rating-item"]',
  episodeCard: '[data-testid="episode-card"] a[href*="/title/tt"]',
  wafChallenge: "#challenge-container, #challenge-form",
} as const;

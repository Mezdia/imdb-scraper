import { writeFileSync } from "node:fs";
import type { TitleRecord } from "../imdb/types.js";

// ---------------------------------------------------------------------------
// Offline viewer. Reads ./data.json. IMDb-only: poster comes from IMDb's own
// CDN (m.media-amazon.com) when present, otherwise a local SVG placeholder.
// The legacy Bing fallback is intentionally gone (AGENTS.md).
// ---------------------------------------------------------------------------

const PLACEHOLDER_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="100%" height="100%" fill="#111827"/><text x="50%" y="50%" fill="#d4af37" font-size="42" text-anchor="middle" font-family="serif">IScrapeMDB</text></svg>`,
  );

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderViewerHtml(rec: TitleRecord): string {
  const poster = rec.poster || PLACEHOLDER_SVG;
  const cast = (rec.cast ?? [])
    .slice(0, 24)
    .map((c) => `<div class="cast-card"><div class="cast-name">${esc(c.name)}</div><div class="cast-role">${esc(c.role ?? "")}</div></div>`)
    .join("");
  const pg = (rec.parentsGuide ?? [])
    .map((p) => `<span class="badge">${esc(p.type)}: ${esc(p.rating)}</span>`)
    .join("");
  const reviews = (rec.reviews ?? [])
    .slice(0, 60)
    .map((r) => `<div class="review-card"><span class="review-title">${esc(r.title || "Review")}</span><p>${esc(r.content || "")}</p></div>`)
    .join("");
  const eps = (rec.episodes ?? [])
    .map((e) => `<li><code>${esc(e.imdbId)}</code>${e.season != null ? ` — S${e.season}E${e.episode ?? "?"}` : ""} ${esc(e.title ?? "")}</li>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(rec.title)} - IScrapeMDB</title>
<style>
:root{--bg:#0f1115;--panel:#1f2937;--gold:#d4af37;--text:#e2e8f0;--muted:#94a3b8;--border:#374151}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',Roboto,Arial,sans-serif;max-width:960px;margin:0 auto;padding:2rem 1rem}
.hero{display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:2rem}
.hero img{width:220px;max-width:60vw;border-radius:8px;border:1px solid var(--border)}
h1{font-family:Georgia,serif;font-size:2.2rem;margin-bottom:.5rem}
.meta{color:var(--muted);margin:.4rem 0}
.rate{color:var(--gold);font-weight:bold;font-size:1.2rem}
.desc{background:rgba(31,41,55,.4);border-left:4px solid var(--gold);padding:1rem;border-radius:4px;margin:1.2rem 0;line-height:1.6}
.badges{display:flex;flex-wrap:wrap;gap:.4rem;margin:1rem 0}
.badge{font-size:.75rem;font-weight:bold;padding:.25rem .5rem;border-radius:4px;border:1px solid currentColor;text-transform:uppercase}
.cast-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:.6rem;margin-top:.6rem}
.cast-card{background:rgba(31,41,55,.4);border:1px solid var(--border);padding:.6rem;border-radius:6px}
.cast-name{font-weight:600}.cast-role{color:var(--muted);font-size:.85rem;font-style:italic}
.reviews{columns:1;column-gap:1rem;margin-top:.6rem}
@media(min-width:700px){.reviews{columns:2}}
.review-card{background:rgba(31,41,55,.4);border:1px solid var(--border);padding:1rem;border-radius:8px;break-inside:avoid;margin-bottom:1rem}
.review-title{color:var(--gold);font-weight:bold;display:block;margin-bottom:.4rem}
h2{font-family:Georgia,serif;margin:2rem 0 .6rem;border-left:4px solid var(--gold);padding-left:.8rem}
ul.eps{columns:2;list-style:none}ul.eps li{padding:.25rem 0;color:var(--muted);font-size:.9rem}
.missing{background:#3b2f0b;border:1px solid var(--gold);padding:.7rem;border-radius:6px;margin-top:1rem;font-size:.9rem}
.prov{color:#6b7280;font-size:.75rem;margin-top:1.5rem;word-break:break-all}
a{color:var(--gold)}
</style>
</head>
<body>
<div class="hero">
<img src="${esc(poster)}" alt="poster" loading="lazy" onerror="this.src='${PLACEHOLDER_SVG}'">
<div style="flex:1;min-width:260px">
<h1>${esc(rec.title)}</h1>
<div class="meta">${esc(rec.year ?? "")} · ${esc(rec.kind)} · <a href="${esc(rec.url)}">${esc(rec.imdbId)}</a></div>
<div class="rate">★ ${esc(rec.rating ?? "N/A")}${rec.votes ? ` <span style="color:var(--muted);font-size:.85rem">(${rec.votes.toLocaleString()} votes)</span>` : ""}</div>
<div class="meta">${esc(rec.runtime ?? "")} ${(rec.genres ?? []).map(esc).join(" · ")}</div>
<div class="meta">Directed by: ${esc((rec.directors ?? []).join(", ") || "—")}</div>
</div>
</div>
<div class="desc">${esc(rec.description ?? rec.plot ?? "No description available.")}</div>
${pg ? `<h2>Parents Guide</h2><div class="badges">${pg}</div>` : ""}
${cast ? `<h2>Cast</h2><div class="cast-grid">${cast}</div>` : ""}
${eps ? `<h2>Episodes (${rec.episodeCount ?? rec.episodes?.length ?? 0})</h2><ul class="eps">${eps}</ul>` : ""}
${reviews ? `<h2>Reviews</h2><div class="reviews">${reviews}</div>` : ""}
${rec.missing?.length ? `<div class="missing">Partial record — unavailable from IMDb at scrape time: ${rec.missing.map(esc).join("; ")}</div>` : ""}
<div class="prov">Scraped ${esc(rec.scrapedAt)} · provenance: ${esc(rec.provenance.join(" | "))} · IMDb-only (see AGENTS.md)</div>
<script>/* data embedded for portable export */\nwindow.__RECORD__ = null;</script>
</body>
</html>`;
}

export function writeViewer(path: string, rec: TitleRecord): void {
  writeFileSync(path, renderViewerHtml(rec), "utf8");
}

/** Inline data.json into a single portable.html (offline sharing). */
export function writePortable(dir: string, rec: TitleRecord): string {
  const html = renderViewerHtml(rec);
  const embedded = html.replace(
    "window.__RECORD__ = null;",
    `window.__RECORD__ = ${JSON.stringify(rec).slice(0, 2_000_000)};`,
  );
  const out = `${dir.replace(/\/$/, "")}/portable.html`;
  writeFileSync(out, embedded, "utf8");
  return out;
}

export function renderListHtml(listName: string, records: TitleRecord[]): string {
  const escRows = records
    .map(
      (r) => `<div class="card">
<img src="${esc(r.poster ?? PLACEHOLDER_SVG)}" alt="" loading="lazy" onerror="this.src='${PLACEHOLDER_SVG}'">
<div><div class="t">${esc(r.title)}</div>
<div class="m">${esc(r.year ?? "")} · ${esc(r.kind)} · <span class="rate">★ ${esc(r.rating ?? "N/A")}</span> · <a href="${esc(r.url)}">${esc(r.imdbId)}</a></div>
<div class="d">${esc((r.description ?? r.plot ?? "").slice(0, 220))}</div></div></div>`,
    )
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(listName)} - IScrapeMDB</title>
<style>
:root{--bg:#0f1115;--panel:#1f2937;--gold:#d4af37;--text:#e2e8f0;--muted:#94a3b8;--border:#374151}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',Roboto,Arial,sans-serif;max-width:960px;margin:0 auto;padding:2rem 1rem}
h1{font-family:Georgia,serif;margin-bottom:.3rem}.sub{color:var(--muted);margin-bottom:1.5rem}
.card{display:flex;gap:1rem;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:1rem;margin-bottom:1rem}
.card img{width:90px;border-radius:6px;object-fit:cover}
.t{font-weight:bold;font-size:1.1rem}.m{color:var(--muted);font-size:.85rem;margin:.2rem 0}.d{font-size:.9rem;color:#d1d5db}
.rate{color:var(--gold);font-weight:bold}a{color:var(--gold)}
</style></head>
<body><h1>${esc(listName)}</h1><div class="sub">${records.length} title(s) · IMDb-only scrape · IScrapeMDB v2</div>
${escRows || "<p>No records yet.</p>"}</body></html>`;
}

export function writeListViewer(path: string, listName: string, records: TitleRecord[]): void {
  writeFileSync(path, renderListHtml(listName, records), "utf8");
}

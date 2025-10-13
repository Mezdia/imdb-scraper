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
    .map((p) => `<span class="badge">${esc(p.type)}: ${esc(p.rating)}${p.votes ? ` (${p.votes.toLocaleString()} votes)` : ""}</span>${p.description ? `<div class="pgdesc">${esc(p.description)}</div>` : ""}`)
    .join("");
  const reviews = (rec.reviews ?? [])
    .slice(0, 60)
    .map((r) => `<div class="review-card"><span class="review-title">${esc(r.title || "Review")}</span><p>${esc(r.content || "")}</p><div class="rmeta">${[r.author ? `by ${esc(r.author)}` : "", r.rating != null ? `${r.rating}/10` : "", r.date ? esc(r.date) : ""].filter(Boolean).join(" · ")}</div></div>`)
    .join("");
  const eps = (rec.episodes ?? [])
    .map((e) => `<div class="ep-card">
${e.poster ? `<img src="${esc(e.poster)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
<div class="ep-body">
<div class="ep-head"><code>${esc(e.imdbId)}</code>${e.season != null ? ` <b>S${e.season}E${e.episode ?? "?"}</b>` : ""} <span class="ep-title">${esc(e.title ?? "")}</span></div>
${e.airDate || e.rating ? `<div class="ep-meta">${esc(e.airDate ?? "")}${e.airDate && e.rating ? " · " : ""}${e.rating ? `★ ${esc(e.rating)}${e.votes ? ` (${e.votes.toLocaleString()})` : ""}` : ""}</div>` : ""}
${e.plot ? `<div class="ep-plot">${esc(e.plot)}</div>` : ""}
</div></div>`)
    .join("");
  const gallery = (rec.gallery ?? [])
    .slice(0, 40)
    .map((g) => `<figure><a href="${esc(g.url)}" target="_blank" rel="noopener"><img src="${esc(g.url)}" loading="lazy" ${g.caption ? `alt="${esc(g.caption)}" title="${esc(g.caption)}"` : `alt=""`} onerror="this.closest('figure').remove()"></a>${g.caption ? `<figcaption>${esc(g.caption)}</figcaption>` : ""}</figure>`)
    .join("");
  const facts: [string, string][] = [];
  if (rec.originalTitle && rec.originalTitle !== rec.title) facts.push(["Original title", rec.originalTitle]);  if (rec.releaseDate) facts.push(["Release date", rec.releaseDate]);
  if (rec.endYear) facts.push(["End year", rec.endYear]);
  if (rec.contentRating) facts.push(["Certification", rec.contentRating]);
  if (rec.metascore != null) facts.push(["Metascore", String(rec.metascore)]);
  if (rec.top250Rank != null) facts.push(["IMDb Top 250", `#${rec.top250Rank}`]);
  if (rec.countries?.length) facts.push(["Countries", rec.countries.join(", ")]);
  if (rec.languages?.length) facts.push(["Languages", rec.languages.join(", ")]);
  if (rec.productionCompanies?.length) facts.push(["Companies", rec.productionCompanies.slice(0, 6).join(", ")]);
  if (rec.filmingLocations?.length) facts.push(["Filming", rec.filmingLocations.slice(0, 4).join(" · ")]);
  if (rec.colorInfo?.length) facts.push(["Color", rec.colorInfo.join(" · ")]);
  if (rec.soundMix?.length) facts.push(["Sound", rec.soundMix.join(" · ")]);
  const bo = rec.boxOffice;
  if (bo && (bo.budget || bo.openingWeekend || bo.grossUSA || bo.grossWorldwide)) {
    facts.push(["Box office", [bo.budget && `Budget ${bo.budget}`, bo.openingWeekend && `Opening ${bo.openingWeekend}`, bo.grossUSA && `USA ${bo.grossUSA}`, bo.grossWorldwide && `World ${bo.grossWorldwide}`].filter(Boolean).join(" · ")]);
  }
  if (rec.awardsSummary) facts.push(["Awards", rec.awardsSummary]);
  if (rec.keywords?.length) facts.push(["Keywords", rec.keywords.slice(0, 15).join(", ")]);
  if (rec.akas?.length) facts.push(["Also known as", rec.akas.slice(0, 8).map((a) => `${a.title}${a.region ? ` (${a.region})` : ""}`).join(" · ")]);
  const factsHtml = facts.map(([k, v]) => `<div class="fact"><span>${esc(k)}</span>${esc(v)}</div>`).join("");
  const people = [
    rec.directors?.length ? `<div class="meta">Directed by: ${esc(rec.directors.join(", "))}</div>` : "",
    rec.writers?.length ? `<div class="meta">Written by: ${esc(rec.writers.join(", "))}</div>` : "",
    rec.creators?.length ? `<div class="meta">Created by: ${esc(rec.creators.join(", "))}</div>` : "",
  ].join("");

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
.tagline{font-family:Georgia,serif;font-style:italic;color:var(--gold);margin:0 0 1rem;font-size:1.1rem}
.facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:.5rem;margin-top:.6rem}
.fact{background:rgba(31,41,55,.4);border:1px solid var(--border);border-radius:6px;padding:.6rem;font-size:.88rem}
.fact span{display:block;color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.2rem}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:.5rem;margin-top:.6rem}
.gallery img{width:100%;border-radius:6px;border:1px solid var(--border)}
.rmeta{color:var(--muted);font-size:.78rem;margin-top:.4rem}
.pgdesc{font-size:.82rem;color:#d1d5db;margin:.2rem 0 .6rem;flex-basis:100%}
ul.eps{columns:2;list-style:none}ul.eps li{padding:.25rem 0;color:var(--muted);font-size:.9rem}
.eps{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:.7rem;margin-top:.6rem}
.ep-card{display:flex;gap:.7rem;background:rgba(31,41,55,.4);border:1px solid var(--border);border-radius:8px;padding:.7rem}
.ep-card img{width:110px;align-self:flex-start;border-radius:6px;border:1px solid var(--border)}
.ep-body{min-width:0;flex:1}
.ep-head{font-size:.9rem;margin-bottom:.2rem}
.ep-title{font-weight:bold}
.ep-meta{color:var(--gold);font-size:.8rem;margin-bottom:.3rem}
.ep-plot{font-size:.83rem;color:#d1d5db;line-height:1.5}
.gallery figure{margin:0}
.gallery figcaption{font-size:.72rem;color:var(--muted);padding:.25rem 0;line-height:1.4}
ul.trailers{list-style:none;margin-top:.6rem}ul.trailers li{padding:.3rem 0}
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
${people}
</div>
</div>
${rec.tagline ? `<div class="tagline">“${esc(rec.tagline)}”</div>` : ""}
<div class="desc">${esc(rec.description ?? rec.plot ?? "No description available.")}</div>
${factsHtml ? `<h2>Facts</h2><div class="facts">${factsHtml}</div>` : ""}
${(rec.trailers ?? []).length ? `<h2>Trailers</h2><ul class="trailers">${(rec.trailers ?? []).map((t) => `<li><a href="${esc(t.url ?? "")}">${esc(t.name ?? t.id)}</a></li>`).join("")}</ul>` : ""}
${gallery ? `<h2>Gallery (${(rec.gallery ?? []).length})</h2><div class="gallery">${gallery}</div>` : ""}
${pg ? `<h2>Parents Guide</h2><div class="badges">${pg}</div>` : ""}
${cast ? `<h2>Cast</h2><div class="cast-grid">${cast}</div>` : ""}
${eps ? `<h2>Episodes (${rec.episodeCount ?? rec.episodes?.length ?? 0})</h2><div class="eps">${eps}</div>` : ""}
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
  // Embed the FULL record (never truncate — a slice can cut mid-JSON and
  // produce a broken page for large series). Escape `<` so `</script>`
  // inside review text cannot break out of the inline script block.
  const payload = JSON.stringify(rec).replace(/</g, "\\u003c");
  const embedded = html.replace(
    "window.__RECORD__ = null;",
    `window.__RECORD__ = ${payload};`,
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

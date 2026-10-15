/** Static publishing adapter. No network access and no credentials. */
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { MODELS, iso, parseUTC, summarizeCapture, serveState, textFeed } from './core.mjs';
export const MAX_AGE_MINUTES = 90;
const htmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export function makeFeed(capture, now = Date.now(), { testOnly = false } = {}) {
  if (!testOnly && (capture?.capture_schema !== 'philly-ensemble-collector-v1' ||
      capture?.execution_location !== 'github_actions_once'))
    throw new Error('Only a new acquisition from this collector may enter the public feed');
  const summary = summarizeCapture(capture, now);
  // Neutral display labels do not change the target or source-data provenance.
  summary.target = { ...summary.target, label: 'Configured forecast target' };
  const readiness = serveState(summary, now, MAX_AGE_MINUTES);
  const model_deadlines = readiness.models.map(check => {
    const model = summary.models.find(m => m.model === check.model);
    const received = model?.received_at_utc;
    return { model: check.model, usable_at_generation: check.usable,
      received_at_utc: received ?? null,
      expires_at_utc: received ? iso(parseUTC(received) + MAX_AGE_MINUTES * 60000) : null };
  });
  const deadline = readiness.ready ? iso(Math.min(...model_deadlines.map(m => parseUTC(m.expires_at_utc)))) : null;
  return { schema: 'philly-ensemble-pages-v1', generated_at_utc: iso(now),
    test_only: testOnly, status_at_generation: readiness.ready ? 'complete' :
      readiness.models.some(m => m.usable) ? 'partial' : 'unavailable',
    ready_at_generation: readiness.ready, expires_at_utc: deadline,
    max_acquisition_age_minutes: MAX_AGE_MINUTES, model_deadlines,
    readiness_at_generation: readiness, summary,
    consumer_rule: 'This is a static snapshot. Recheck current UTC time against expires_at_utc. HTTP 200 and ready_at_generation are not current freshness guarantees. Never use test_only data.',
    per_value_model_initialization_verified: false,
    same_run_comparison_permitted: false,
    scope: 'Public weather-model supplement only; no local observations, official alerts, air quality, calendar data or street-level claims.' };
}
export function eligibleNow(feed, now = Date.now()) {
  if (feed?.test_only || !feed?.ready_at_generation || !feed?.expires_at_utc) return false;
  try { return now >= parseUTC(feed.generated_at_utc) - 300000 && now <= parseUTC(feed.expires_at_utc); }
  catch { return false; }
}
export function renderText(feed) {
  return [feed.test_only ? 'TEST FIXTURE — NOT LIVE WEATHER' : 'GitHub Actions collection snapshot',
    `Snapshot generated: ${feed.generated_at_utc}`,
    `Status AT GENERATION: ${feed.status_at_generation}`,
    `Do not use this comparison after: ${feed.expires_at_utc ?? 'NOT ELIGIBLE'}`,
    'A static page cannot certify freshness at the time you read it. Compare that deadline with the current time.', '',
    textFeed(feed.summary, feed.readiness_at_generation)
      .replace(/^[^\n]*ensemble supplement[^\n]*/,
        'Client weather ensemble supplement — not an official local forecast')
      .replace(/; grid [^;\n]+; distance /g, '; sampled-grid distance ')
      .replace('Use /latest.json for hourly windows and uncertainty; /capture.json for raw numerical evidence.',
        'Use latest.json (relative to this page) for hourly windows and uncertainty; capture.json for raw evidence.')
  ].join('\n') + '\n';
}
export function renderHTML(feed) {
  const deadline = feed.expires_at_utc ?? '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Client Weather Feed</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:58rem;margin:2rem auto;padding:0 1rem}h1{font-size:1.6rem}h2{font-size:1.1rem}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}nav a{display:inline-block;margin-right:1rem}#current-status{border:1px solid;padding:.7rem}a{overflow-wrap:anywhere}</style></head>
<body><h1>Client Weather Feed</h1><p>Not an official local forecast or a current observation.</p>
<p id="current-status" data-expires="${htmlEscape(deadline)}" data-ready="${feed.ready_at_generation && !feed.test_only}" data-generated="${feed.generated_at_utc}">Status at build: ${htmlEscape(feed.status_at_generation)}. Check the expiry below before use.</p>
<nav><a href="latest.txt">Text feed</a><a href="latest.json">Validated JSON</a><a href="capture.json">Raw weather responses</a><a href="status.json">Collection status</a></nav>
<h2>Acquisition, forecast and uncertainty</h2><pre>${htmlEscape(renderText(feed))}</pre>
<p>Attribution: <a href="https://open-meteo.com/">Open-Meteo</a>, ECMWF and Environment and Climate Change Canada.
Weather data: <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Modifications: validation, per-model member statistics, unit conversions and specified interval aggregation.</p>
<script>const box=document.getElementById('current-status');function updateStatus(){const now=Date.now(),deadline=Date.parse(box.dataset.expires),generated=Date.parse(box.dataset.generated);box.textContent=box.dataset.ready==='true'&&Number.isFinite(deadline)&&now>=generated-300000&&now<=deadline?'Within the acquisition-age window. Model initialization is still not independently verified.':'STALE OR INCOMPLETE — do not use as a fresh complete ensemble comparison.';}updateStatus();setInterval(updateStatus,30000);</script>
</body></html>`;
}
export async function writeSite(directory, capture, feed) {
  const out = resolve(directory);
  if (out === '/' || out === resolve('.') || out === resolve('src') || out === resolve('test'))
    throw new Error('Refusing an unsafe site output path');
  await fs.mkdir(out, { recursive: true });
  const status = { schema: feed.schema, test_only: feed.test_only, generated_at_utc: feed.generated_at_utc,
    status_at_generation: feed.status_at_generation, ready_at_generation: feed.ready_at_generation,
    expires_at_utc: feed.expires_at_utc, model_deadlines: feed.model_deadlines,
    consumer_rule: feed.consumer_rule, per_value_model_initialization_verified: false };
  const raw = { schema: 'philly-ensemble-pages-capture-v1', test_only: feed.test_only,
    generated_at_utc: feed.generated_at_utc, expires_at_utc: feed.expires_at_utc,
    consumer_rule: feed.consumer_rule, capture };
  await Promise.all([
    fs.writeFile(join(out,'index.html'), renderHTML(feed)),
    fs.writeFile(join(out,'latest.txt'), renderText(feed)),
    fs.writeFile(join(out,'latest.json'), JSON.stringify(feed)),
    fs.writeFile(join(out,'status.json'), JSON.stringify(status)),
    fs.writeFile(join(out,'capture.json'), JSON.stringify(raw)),
    fs.writeFile(join(out,'.nojekyll'), ''),
    fs.writeFile(join(out,'robots.txt'), 'User-agent: *\nAllow: /\n')
  ]);
  return out;
}

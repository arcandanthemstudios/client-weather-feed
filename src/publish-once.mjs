/** One bounded live acquisition, then static export. GitHub schedules it; no daemon. */
import { promises as fs } from 'node:fs';
import { collect } from './collect.mjs';
import { MODELS, TARGET, iso } from './core.mjs';
import { makeFeed, writeSite, renderText } from './static-feed.mjs';
const out = process.argv[2] ?? '_site';
let capture;
try { capture = await collect(); }
catch (error) {
  const now = iso(Date.now());
  capture = { capture_schema: 'philly-ensemble-collector-v1', saved_at_utc: now,
    records: Object.keys(MODELS).map(model => ({ requested_model: model,
      requested_coordinates: [TARGET.latitude, TARGET.longitude], status: 'access_failed',
      error: String(error?.message ?? error).slice(0,200), http_status: null })) };
}
capture.execution_location = 'github_actions_once';
const feed = makeFeed(capture);
await writeSite(out, capture, feed);
// Keep full provenance OUTSIDE the directory published by Pages.
// Workflow artifacts are access-controlled by GitHub but are not private in a public repo.
await fs.mkdir('_evidence', { recursive: true });
await fs.writeFile('_evidence/capture.json', JSON.stringify(capture));
await fs.writeFile('_evidence/validated.json', JSON.stringify(feed));
const status = { generated_at_utc: feed.generated_at_utc, ready_at_generation: feed.ready_at_generation,
  status_at_generation: feed.status_at_generation, expires_at_utc: feed.expires_at_utc,
  models: feed.readiness_at_generation.models };
console.log(JSON.stringify(status, null, 2));
if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `ready=${feed.ready_at_generation}\ngenerated_at_utc=${feed.generated_at_utc}\n`);
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
  '## Weather collection result\n\n```text\n'+renderText(feed)+'```\n');
// A failed acquisition must still publish an explicit unavailable/partial status.
// The deployment job marks the workflow failed AFTER publishing that status.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicView } from '../src/public-view.mjs';
import { makeFeed, writeSite, renderHTML } from '../src/static-feed.mjs';
import { syntheticCapture, NOW } from './helpers.mjs';

test('Public projection removes target, grid and URL fields without mutating source evidence', () => {
  const feed = makeFeed(syntheticCapture(), NOW, { testOnly: true });
  const before = JSON.stringify(feed), view = publicView(feed);
  assert.equal(JSON.stringify(feed), before);
  assert.equal(view.schema, 'client-ensemble-pages-v1');
  assert.equal(view.summary.schema, 'client-ensemble-service-v1');
  assert.equal(view.summary.target.spatial_metadata_published, false);
  assert.equal(view.summary.target.latitude, undefined);
  for (let i = 0; i < view.summary.models.length; i++) {
    const a = feed.summary.models[i], b = view.summary.models[i];
    assert.equal(b.source_url, undefined);
    assert.equal(b.requested_target, undefined);
    assert.equal(b.sampled_coordinates, undefined);
    assert.deepEqual(b.days, a.days);
    assert.deepEqual(b.hourly, a.hourly);
    assert.equal(b.grid_distance_km, a.grid_distance_km);
    assert.deepEqual(b.metadata, a.metadata);
  }
  assert.equal(view.same_run_comparison_permitted, false);
});

test('Public files omit raw capture and explicit coordinates; legacy URL becomes a notice', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'public-feed-test-'));
  try {
    const capture = syntheticCapture();
    const before = JSON.stringify(capture);
    const feed = makeFeed(capture, NOW, { testOnly: true });
    await writeSite(dir, capture, feed);
    assert.equal(JSON.stringify(capture), before);
    const latest = JSON.parse(await fs.readFile(join(dir, 'latest.json'), 'utf8'));
    assert.equal(latest.publication.raw_responses_published, false);
    const status = JSON.parse(await fs.readFile(join(dir, 'status.json'), 'utf8'));
    assert.equal(status.schema, 'client-ensemble-pages-v1');
    const notice = JSON.parse(await fs.readFile(join(dir, 'capture.json'), 'utf8'));
    assert.equal(notice.raw_responses_published, false);
    assert.equal(notice.capture, undefined);
    for (const file of ['latest.json', 'status.json', 'capture.json', 'index.html', 'latest.txt']) {
      const text = await fs.readFile(join(dir, file), 'utf8');
      assert.ok(!/"(?:latitude|longitude|source_url|requested_coordinates|sampled_coordinates)"\s*:/.test(text), file);
      assert.ok(!/\b19107\b|Philadelphia|philly-/i.test(text), file);
      assert.ok(!text.includes('latitude='), file);
    }
    assert.ok(!renderHTML(feed).includes('href="capture.json"'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Raw evidence is retained outside the published Pages directory', async () => {
  const script = await fs.readFile('src/publish-once.mjs', 'utf8');
  assert.ok(script.includes("'_evidence/capture.json'"));
  const workflow = await fs.readFile('.github/workflows/weather.yml', 'utf8');
  assert.ok(workflow.includes('path: _evidence/'));
  assert.ok(workflow.includes('path: _site'));
  assert.ok(workflow.includes("status.schema !== 'client-ensemble-pages-v1'"));
  assert.ok(!workflow.includes('contents: write'));
});

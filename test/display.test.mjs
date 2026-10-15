import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { TARGET } from '../src/core.mjs';
import { makeFeed, renderText, renderHTML } from '../src/static-feed.mjs';
import { syntheticCapture, NOW } from './helpers.mjs';

test('Human-facing output uses neutral labels without changing the forecast target', () => {
  const capture = syntheticCapture();
  const before = JSON.stringify(capture);
  const feed = makeFeed(capture, NOW, { testOnly: true });
  assert.equal(feed.summary.target.label, 'Configured forecast target');
  assert.equal(feed.summary.target.latitude, TARGET.latitude);
  assert.equal(feed.summary.target.longitude, TARGET.longitude);
  assert.equal(JSON.stringify(capture), before);
  const html = renderHTML(feed), text = renderText(feed);
  assert.ok(html.includes('<title>Client Weather Feed</title>'));
  assert.ok(html.includes('<h1>Client Weather Feed</h1>'));
  assert.ok(text.includes('Client weather ensemble supplement'));
  const postalLabel = TARGET.label.split(' ')[0];
  assert.ok(!text.includes(postalLabel));
  assert.ok(!html.includes(postalLabel));
  for (const model of feed.summary.models) {
    assert.ok(!text.includes(`grid ${model.sampled_coordinates.latitude}, ${model.sampled_coordinates.longitude}`));
    assert.ok(text.includes('sampled-grid distance'));
  }
  assert.ok(text.includes('run provenance unverified'));
  assert.ok(text.includes('Celsius: high'));
  assert.ok(text.includes('Fahrenheit: high'));
});

test('Workflow display names stay generic in both workflow copies', async () => {
  const a = await fs.readFile('.github/workflows/weather.yml', 'utf8');
  const b = await fs.readFile('WORKFLOW.yml', 'utf8');
  assert.equal(a, b);
  assert.equal(a.split('\n')[0], 'name: Refresh client weather feed');
  assert.ok(a.includes("cron: '35 5,11,17 * * *'"));
  assert.ok(a.includes("timezone: 'America/New_York'"));
});

/** Check the native collector schedule, not the separate report automations. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const workflow = read('.github/workflows/weather.yml');

test('collector has only the approved early daily schedule in Eastern time', () => {
  const schedule = workflow.match(/^  schedule:\n([\s\S]*?)(?=^  \w|^\S)/m)?.[1];
  assert.ok(schedule, 'Missing native schedule block');
  assert.deepEqual([...schedule.matchAll(/^    - cron: '([^']+)'$/gm)].map(x => x[1]), ['3 0 * * *', '35 5 * * *', '26 13 * * *']);
  assert.equal([...schedule.matchAll(/^      timezone: 'America\/New_York'$/gm)].length, 3, 'Each schedule must keep Eastern local time');
});

test('reference workflow stays identical to the active workflow', () => {
  assert.equal(read('WORKFLOW.yml'), workflow);
});

test('collector retains evidence receipts and validation instead of relaxing readiness', () => {
  assert.match(workflow, /npm test/);
  assert.match(workflow, /python3 -m unittest discover/);
  assert.match(workflow, /run: node src\/collection-receipt\.mjs/);
  assert.match(workflow, /name: collector-evidence/);
  assert.match(workflow, /cancel-in-progress: false/);
});

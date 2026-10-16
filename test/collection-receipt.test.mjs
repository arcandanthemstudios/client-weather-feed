import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCollectionReceipt } from '../src/collection-receipt.mjs';
const time = '2026-10-16T09:16:00Z';
const env = { GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40), GITHUB_EVENT_NAME: 'workflow_dispatch', COLLECTOR_SLOT_UTC: '2026-10-16T10:00:00Z' };
const files = () => ({ 'capture.json': JSON.stringify({ capture_schema: 'philly-ensemble-collector-v1', saved_at_utc: time, records: [] }),
  'validated.json': JSON.stringify({ schema: 'philly-ensemble-pages-v1', test_only: false, generated_at_utc: time, summary: { source_capture_saved_at_utc: time, models: [] } }) });
test('producer receipt never claims a scheduled report consumed its artifact', () => {
  const r = makeCollectionReceipt(files(), env, time, { testOnly: true });
  assert.equal(r.test_only, true); assert.equal(r.report_consumption_verified, false);
  assert.equal(r.scheduled_report_verified, false); assert.equal(r.artifact_id, null);
  assert.match(r.files[0].sha256, /^[a-f0-9]{64}$/);
});
test('missing supplement is explicit without erasing the base hashes', () => {
  const r = makeCollectionReceipt(files(), env, time, { testOnly: true });
  assert.equal(r.supplement_status, 'missing'); assert.equal(r.files.length, 2);
});
test('mismatched capture/build is rejected', () => {
  const f = files(); f['validated.json'] = f['validated.json'].replaceAll(time, '2026-10-16T09:20:00Z');
  assert.throws(() => makeCollectionReceipt(f, env, time, { testOnly: true }), /matching/);
});
test('missing workflow identity is not filled with invented identifiers', () => {
  assert.throws(() => makeCollectionReceipt(files(), {}, time, { testOnly: true }), /Actual workflow/);
});

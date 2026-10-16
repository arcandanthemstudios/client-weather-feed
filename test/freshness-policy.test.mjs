import test from 'node:test';
import assert from 'node:assert/strict';
import { acquisitionAge, assessSourceUse, makeConsumptionReceipt, ACQUISITION_NOTICE } from '../src/freshness-policy.mjs';
const now = Date.parse('2026-10-16T10:08:00Z');
const request = { start_utc: '2026-10-16T15:00:00Z', end_utc: '2026-10-16T19:00:00Z' };
const source = () => ({ id: 'model', test_only: false, validation: 'passed', identity_verified: true,
  kind: 'model_forecast', received_at_utc: '2026-10-15T23:45:00Z',
  valid_start_utc: '2026-10-15T00:00:00Z', valid_end_utc: '2026-10-19T23:00:00Z',
  requested_window_complete: true, own_source_time_checked: true });
const review = { accepted: true, checked_at_utc: '2026-10-16T10:07:00Z',
  reason: 'Complete requested period; checked newer official guidance, retain dated timing range.', evidence_refs: ['fixture:official-review'] };
test('90 minutes measures collection age, not future forecast validity', () => {
  assert.equal(acquisitionAge(source().received_at_utc, now).state, 'dated');
  assert.equal(assessSourceUse(source(), request, now).use_state, 'review_required');
  assert.match(ACQUISITION_NOTICE, /not a forecast-validity deadline/);
});
test('dated validated forecast can be used after a recorded claim-specific review', () => {
  const result = assessSourceUse({ ...source(), dated_review: review }, request, now);
  assert.equal(result.use_state, 'dated_fallback'); assert.equal(result.allowed_for_requested_claim, true);
  assert.equal(result.same_run_comparison_permitted, false);
});
test('fresh acquisition still requires source-time checks', () => {
  const s = { ...source(), received_at_utc: '2026-10-16T09:35:00Z', own_source_time_checked: false };
  assert.equal(assessSourceUse(s, request, now).use_state, 'review_required');
});
test('test evidence, wrong identity, null values, or incomplete interval cannot pass', () => {
  for (const changes of [{ test_only: true }, { identity_verified: false }, { validation: 'failed' },
    { requested_window_complete: false }, { valid_end_utc: '2026-10-16T16:00:00Z' }])
    assert.equal(assessSourceUse({ ...source(), dated_review: review, ...changes }, request, now).allowed_for_requested_claim, false);
});
test('superseded data remains historical despite a positive fallback review', () => {
  assert.equal(assessSourceUse({ ...source(), materially_superseded: true, dated_review: review }, request, now).use_state, 'historical_only');
});
test('old observations never turn into current conditions or zero pollution', () => {
  assert.equal(assessSourceUse({ ...source(), kind: 'current_observation',
    observed_at_utc: '2026-10-15T23:00:00Z', max_observation_age_minutes: 180 }, request, now).use_state, 'historical_only');
});
test('cached empty alert success does not authorize an all-clear', () => {
  assert.equal(assessSourceUse({ ...source(), kind: 'current_alerts', live_recheck_succeeded: false }, request, now).allowed_for_requested_claim, false);
});
test('missing optional source does not erase a separately valid base source', () => {
  const good = assessSourceUse({ ...source(), dated_review: review }, request, now);
  const bad = assessSourceUse({ ...source(), id: 'optional-gusts', validation: 'failed' }, request, now);
  assert.equal(good.allowed_for_requested_claim, true); assert.equal(bad.allowed_for_requested_claim, false);
});
test('receipt refuses used without validation and actual claim references', () => {
  const args = { run: { id: 1, head_sha: 'fixture' }, artifact: { id: 2, sha256: 'fixture' },
    checked_at_utc: '2026-10-16T10:08:00Z', delivery: { execution_kind: 'manual', executed_at_utc: '2026-10-16T10:08:00Z' },
    items: [{ id: 'model', collected: true, validated: true, used: true, reason: 'test' }] };
  assert.throws(() => makeConsumptionReceipt(args), /actual claims/);
  args.items[0].claim_refs = ['test:claim'];
  assert.equal(makeConsumptionReceipt(args).scheduled_consumption_recorded, false);
});
test('scheduled configuration alone is not a scheduled delivery receipt', () => {
  assert.throws(() => makeConsumptionReceipt({ run: { id: 1, head_sha: 'test' }, artifact: { id: 2, sha256: 'test' },
    checked_at_utc: '2026-10-16T10:08:00Z', delivery: { execution_kind: 'scheduled' }, items: [] }), /Actual execution/);
});
test('future outlook supports its actual future interval, not a present warning', () => {
  const result = assessSourceUse({ ...source(), kind: 'outlook', valid_start_utc: request.start_utc,
    received_at_utc: '2026-10-16T09:35:00Z' }, request, now);
  assert.equal(result.allowed_for_requested_claim, true);
});

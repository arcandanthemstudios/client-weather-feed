import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticRecord, clone } from './helpers.mjs';
import { validateRecord, summarizeRecord, summarizeCapture, serveState, TARGET } from '../src/core.mjs';
import { precipitationOverrides, inspectNative, roundTenth } from '../src/precipitation-quality.mjs';
import { collectModel } from '../src/collect.mjs';
import { publicView } from '../src/public-view.mjs';
import { NOW, fixture } from './precision-fixture.mjs';
const RUN = Date.parse('2026-11-17T00:00:00Z');
const iso = t => new Date(t).toISOString();
const quality = r => validateRecord(r).variables.precipitation;

test('Measured packing errors, not a fixed rain cutoff, authorize the matched correction', () => {
  const { r, indices } = fixture(), before = JSON.stringify(r), p = quality(r);
  assert.equal(p.usable, true); assert.equal(p.quality.adjusted_intervals, 1);
  assert.equal(p.quality.max_precision_bound_mm, 0.244140625);
  for (const i of indices) assert.equal(p.arrays[44][i], 0);
  assert.equal(JSON.stringify(r), before); assert.equal(p.quality.corrections[0].exact_zero_proven, false);
  assert.equal(p.quality.corrections[0].per_value_initialization_verified, false);
});
test('Hidden native negative rounded to hourly zero is corrected and explicitly audited', () => {
  const { r, indices } = fixture(-0.1), p = quality(r);
  assert.equal(p.quality.adjusted_intervals, 1); assert.equal(p.quality.adjusted_negative_hourly_cells, 0);
  assert.ok(indices.every(i => p.arrays[44][i] === 0));
});
test('Hidden native negative without precision evidence is unavailable, not clean zero', () => {
  const { r, indices } = fixture(-0.1); r.precipitation_quality.proofs.intervals = [];
  const p = quality(r); assert.equal(p.usable, false); assert.equal(p.invalid_value_count, 3);
  assert.ok(indices.every(i => p.arrays[44][i] === null));
});
for (const [name, mutate] of [
  ['larger than source precision', x => { x.interval.current.accumulation_mm -= 0.5; }],
  ['no evidence', x => { x.r.precipitation_quality.proofs.intervals = []; }],
  ['duplicate proofs', x => { x.r.precipitation_quality.proofs.intervals.push(clone(x.interval)); }],
  ['unknown policy', x => { x.r.precipitation_quality.policy = 'future-unrecognized'; }],
  ['wrong source origin', x => { x.interval.current.source_url = 'https://untrusted.invalid/model.grib2'; }],
  ['wrong run', x => { x.interval.current.initialization_utc = iso(RUN - 21600000); }],
  ['wrong member', x => { x.interval.current.member_id = 43; }],
  ['wrong grid point', x => { x.interval.current.longitude += 0.25; }],
  ['wrong parameter', x => { x.interval.current.paramId = 167; }],
  ['wrong units', x => { x.interval.current.units = 'mm'; }],
  ['wrong step', x => { x.interval.current.endStep = 39; }],
  ['accumulation reset', x => { x.interval.current.startStep = 33; }],
  ['missing original digest', x => { delete x.interval.current.sha256; }],
  ['inflated bound', x => { x.interval.current.packing_error_mm = 0.9; }],
  ['unsupported source precision', x => { x.interval.current.binaryScaleFactor = -8; x.interval.current.packing_error_mm = 1000 * 2 ** -8 / 2; }],
  ['not reproduced in native output', x => { x.interval.current.accumulation_mm += 0.1; }],
  ['not reproduced in hourly output', x => { x.r.raw_response.hourly.precipitation_member44[x.indices[1]] = 0.3; }],
  ['changed metadata', x => { x.r.metadata_after.raw_response.last_run_modification_time++; }],
  ['update still propagating', x => { x.r.metadata_before.raw_response.last_run_availability_time = NOW / 1000 - 1; x.r.metadata_after = clone(x.r.metadata_before); }],
  ['evidence for different response', x => { x.r.precipitation_quality.source_response_sha256 = 'b'.repeat(64); }],
  ['different native response', x => { x.r.precipitation_quality.native_response_sha256 = 'b'.repeat(64); }],
]) test(`Reject correction: ${name}`, () => {
  const x = fixture(); mutate(x); const p = quality(x.r);
  assert.equal(p.quality.adjusted_intervals, 0); assert.equal(p.usable, false);
});
for (const [name, mutate] of [
  ['missing member', r => { delete r.precipitation_quality.native.raw_response.hourly.precipitation_member50; }],
  ['wrong native unit', r => { r.precipitation_quality.native.raw_response.hourly_units.precipitation_member44 = 'inch'; }],
  ['wrong native grid', r => { r.precipitation_quality.native.raw_response.latitude += 1; }],
  ['wrong native model', r => { r.precipitation_quality.native.raw_response.model = 'cmc_gem_geps'; }],
  ['duplicate native timestamp', r => { r.precipitation_quality.native.raw_response.hourly.time[1] = r.precipitation_quality.native.raw_response.hourly.time[0]; }],
  ['failed native response', r => { r.precipitation_quality.native.http_status = 503; }],
]) test(`Native structural failure cannot authorize correction: ${name}`, () => {
  const { r } = fixture(); mutate(r); assert.equal(inspectNative(r).status, 'unavailable'); assert.equal(quality(r).usable, false);
});
test('Wrong base units and missing member remain structural failures even with precision evidence', () => {
  for (const mutate of [r => { r.raw_response.hourly_units.precipitation_member44 = 'inch'; },
    r => { delete r.raw_response.hourly.precipitation_member50; }]) {
    const { r } = fixture(); mutate(r); const p = quality(r); assert.equal(p.usable, false); assert.deepEqual(p.arrays, []);
  }
});
test('Other members and temperature/wind are unchanged; positive values are never swept to zero', () => {
  const { r, indices } = fixture(); r.raw_response.hourly.precipitation_member43[indices[0]] = 0.1;
  const p = quality(r); assert.equal(p.arrays[43][indices[0]], 0.1); assert.equal(p.arrays.length, 51);
  const v = validateRecord(r); assert.equal(v.variables.temperature_2m.arrays[44][indices[0]], 20);
});
test('Partial raw hour is not imputed and cannot produce a three-hour correction', () => {
  const { r, indices } = fixture(); r.raw_response.hourly.precipitation_member44[indices[0]] = null;
  const p = quality(r); assert.equal(p.quality.adjusted_intervals, 0); assert.equal(p.missing_values, 1);
});
test('Summary labels adjusted hourly and daily windows and retains all members', () => {
  const { r, indices } = fixture(); const s = summarizeRecord(r, NOW);
  assert.equal(s.variables.precipitation.status, 'validated_with_documented_adjustments');
  assert.equal(s.returned_value_checks_passed, true);
  assert.ok(s.hourly.some(h => h.precipitation_previous_hour_mm.quality_adjusted));
  assert.ok(s.days.some(d => d.precipitation_24h.quality_adjusted));
  assert.ok(s.hourly.every(h => h.precipitation_previous_hour_mm.expected_n === 51));
});
test('A corrected-only snapshot can be ready without promoting unknown run provenance', () => {
  const { r } = fixture(); const c = syntheticRecord('cmc_gem_geps', NOW);
  const s = summarizeCapture({ saved_at_utc: iso(NOW), records: [r, c] }, NOW);
  assert.equal(serveState(s, NOW).ready, true); assert.equal(s.same_run_comparison_permitted, false);
});
test('Unrelated unexplained negative still blocks full readiness', () => {
  const { r } = fixture(); r.raw_response.hourly.precipitation_member40[65] = -1;
  const s = summarizeRecord(r, NOW); assert.equal(s.returned_value_checks_passed, false);
  assert.equal(s.variables.precipitation.precision_adjustment.adjusted_intervals, 1);
});
test('New raw precision evidence is omitted from public projection', () => {
  const { r } = fixture(); const publicJson = JSON.stringify(publicView(r));
  assert.ok(!publicJson.includes('packing_error_mm')); assert.ok(!publicJson.includes('source_url'));
  assert.ok(!publicJson.includes('latitude')); assert.ok(!publicJson.includes('precipitation_quality'));
});
test('Default acquisition fetches native data and skips numerical retry for proven adjustments', async () => {
  const { r } = fixture(); const calls = [], sleeps = [];
  const result = await collectModel('ecmwf_ifs025_ensemble', { clock: () => NOW, sleep: async ms => sleeps.push(ms),
    precisionProofsImpl: async () => clone(r.precipitation_quality.proofs),
    fetchImpl: async url => { calls.push(url); const u = new URL(url);
      const raw = u.pathname.endsWith('meta.json') ? r.metadata_after.raw_response :
        u.searchParams.get('temporal_resolution') === 'hourly_3' ? r.precipitation_quality.native.raw_response : r.raw_response;
      return new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } }); } });
  assert.equal(result.numerical_retry.performed, false); assert.deepEqual(sleeps, []);
  assert.equal(result.numeric_validation.validated_variables.precipitation.precision_adjustments.length, 1);
  assert.equal(calls.filter(u => new URL(u).pathname === '/v1/ensemble').length, 2);
  assert.equal(result.raw_response.hourly.precipitation_member44.some(x => x < 0), true);
});
test('Decoder failure retains raw data and rejection instead of silently clamping', async () => {
  const { r } = fixture();
  const result = await collectModel('ecmwf_ifs025_ensemble', { clock: () => NOW, sleep: async () => {},
    precisionProofsImpl: async () => { throw new Error('decoder unavailable'); },
    fetchImpl: async url => { const u = new URL(url), raw = u.pathname.endsWith('meta.json') ? r.metadata_after.raw_response :
      u.searchParams.get('temporal_resolution') === 'hourly_3' ? r.precipitation_quality.native.raw_response : r.raw_response;
      return new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } }); } });
  assert.equal(result.numerical_retry.performed, true);
  assert.equal(result.numeric_validation.validated_variables.precipitation.usable, false);
});

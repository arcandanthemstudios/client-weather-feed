import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecord, summarizeRecord, summarizeCapture, serveState, stats, cToF, msToMph,
  boundary, localParts, scheduleSlot, precipitationPeriod, assessMetadata, iso } from '../src/core.mjs';
import { original, clone, NOW, syntheticRecord, syntheticCapture, meta } from './helpers.mjs';

test('Real user capture: 51 and 21 numerical temperature series; 432 finite values', () => {
  const validated = original.records.map(r => validateRecord(r, ['temperature_2m']));
  assert.deepEqual(validated.map(x => x.expected_members), [51, 21]);
  assert.equal(validated.reduce((s, x) => s + x.variables.temperature_2m.arrays.flat().length, 0), 432);
  assert.ok(validated.every(x => x.variables.temperature_2m.missing_values === 0));
});
test('Real capture: medians match actual arrays, not the built-in validation label', () => {
  const sum = summarizeCapture(original, NOW, ['temperature_2m']);
  assert.deepEqual(sum.models[0].hourly.map(x => x.temperature_c.median), [23.2, 22.3, 20.7, 18.7, 17.0, 16.2]);
  assert.deepEqual(sum.models[1].hourly.map(x => x.temperature_c.median), [23.8, 23.2, 21.6, 19.6, 17.9, 16.6]);
});
test('Real six-hour capture must NOT pass the full three-day/rain/wind readiness gate', () => {
  const sum = summarizeCapture(original, NOW, ['temperature_2m']);
  assert.equal(serveState(sum, NOW).ready, false);
  assert.ok(sum.models.every(x => !x.complete_future_required_variables));
});
test('Real capture grid distances preserve actual differing cells', () => {
  const a = validateRecord(original.records[0], ['temperature_2m']);
  const b = validateRecord(original.records[1], ['temperature_2m']);
  assert.ok(Math.abs(a.grid_distance_km - 9.4723159678) < 1e-5);
  assert.ok(Math.abs(b.grid_distance_km - 14.7238581619) < 1e-5);
});
test('Wrong-city payload rejected', () => {
  const r = clone(original.records[0]); r.raw_response.latitude = 52.52; r.raw_response.longitude = 13.41;
  assert.throws(() => validateRecord(r), /wrong-place/);
});
test('Different requested target rejected', () => {
  const r = clone(original.records[0]); r.requested_coordinates = [39.87, -75.24];
  assert.throws(() => validateRecord(r), /different requested target/);
});
test('Unapproved deterministic model rejected', () => {
  const r = syntheticRecord(); r.requested_model = 'best_match';
  assert.throws(() => validateRecord(r), /non-ensemble/);
});
test('Missing member cannot pass', () => {
  const r = syntheticRecord(); delete r.raw_response.hourly.temperature_2m_member20;
  assert.equal(validateRecord(r).variables.temperature_2m.usable, false);
});
test('Duplicate logical member identity cannot pass', () => {
  const r = syntheticRecord(); r.raw_response.hourly.temperature_2m_member00 = [...r.raw_response.hourly.temperature_2m];
  assert.equal(validateRecord(r).variables.temperature_2m.usable, false);
});
test('Unit mismatch does not silently convert unknown units', () => {
  const r = syntheticRecord(); r.raw_response.hourly_units.temperature_2m = 'K';
  assert.equal(validateRecord(r).variables.temperature_2m.usable, false);
});
test('String masquerading as a weather number is invalid', () => {
  const r = syntheticRecord(); r.raw_response.hourly.temperature_2m[10] = '20';
  assert.equal(validateRecord(r).variables.temperature_2m.usable, false);
});
test('Missing value stays null, not zero or success', () => {
  const r = syntheticRecord(); r.raw_response.hourly.temperature_2m[60] = null;
  const v = validateRecord(r).variables.temperature_2m;
  assert.equal(v.missing_values, 1); assert.equal(v.arrays[0][60], null);
  assert.equal(summarizeRecord(r, NOW).complete_future_required_variables, false);
});
test('Time gap rejected', () => {
  const r = syntheticRecord(); r.raw_response.hourly.time[2] = r.raw_response.hourly.time[3];
  assert.throws(() => validateRecord(r), /time axis/);
});
test('Non-UTC response rejected', () => {
  const r = syntheticRecord(); r.raw_response.timezone = 'America/New_York'; r.raw_response.utc_offset_seconds = -14400;
  assert.throws(() => validateRecord(r), /Expected UTC/);
});
test('Negative interval precipitation invalid, not clipped', () => {
  const r = syntheticRecord(); r.raw_response.hourly.precipitation[70] = -1;
  assert.equal(validateRecord(r).variables.precipitation.usable, false);
});
test('Array length mismatch invalid', () => {
  const r = syntheticRecord(); r.raw_response.hourly.wind_speed_10m.pop();
  assert.equal(validateRecord(r).variables.wind_speed_10m.usable, false);
});
test('No fabricated initializations from processing time', () => {
  const r = syntheticRecord(); r.raw_response.generationtime_ms = 1780000000;
  const m = summarizeRecord(r, NOW).metadata;
  assert.equal(m.provider_reported_initialization_utc, null);
  assert.equal(m.forecast_values_initialization_verified, false);
});
test('Stable provider metadata adds context, NOT per-value run verification', () => {
  const m = meta(); const result = assessMetadata(m, clone(m), iso(NOW));
  assert.equal(result.status, 'provider_metadata_stable_not_value_level_provenance');
  assert.equal(result.same_run_comparison_permitted, false);
  assert.equal(result.forecast_values_initialization_verified, false);
});
test('Changed provider metadata flagged', () => {
  const b = meta(), a = meta(); a.raw_response.last_run_initialisation_time += 3600;
  assert.equal(assessMetadata(b, a, iso(NOW)).status, 'metadata_changed_during_fetch');
});
test('Metadata propagation window flagged', () => {
  const m = meta(); m.raw_response.last_run_availability_time = NOW / 1000 - 60;
  assert.equal(assessMetadata(m, clone(m), iso(NOW)).status, 'provider_update_still_propagating');
});
test('Old provider initialization flagged', () => {
  const m = meta(); m.raw_response.last_run_initialisation_time = NOW / 1000 - 4 * 86400;
  assert.equal(assessMetadata(m, clone(m), iso(NOW)).status, 'provider_metadata_stale');
});
test('Future provider timestamp rejected', () => {
  const m = meta(); m.raw_response.last_run_initialisation_time = NOW / 1000 + 3600;
  assert.equal(assessMetadata(m, clone(m), iso(NOW)).status, 'invalid_or_future_metadata');
});
test('Conversions and quantile definition', () => {
  assert.equal(cToF(20), 68); assert.ok(Math.abs(msToMph(10) - 22.36936) < 0.001);
  assert.deepEqual([stats([1, 2, 3, 4, 5], 5).p10, stats([1, 2, 3, 4, 5], 5).median], [1.4, 3]);
  assert.equal(stats([null, 2, 3], 3).n, 2);
});
test('Precipitation (start,end] uses preceding-hour intervals correctly', () => {
  const r = syntheticRecord(); const raw = r.raw_response;
  for (const k of Object.keys(raw.hourly).filter(x => x.startsWith('precipitation'))) raw.hourly[k] = raw.hourly.time.map((_, i) => i);
  const v = validateRecord(r), start = v.timestamps[0], end = start + 6 * 3600000;
  const p = precipitationPeriod(v, start, end);
  assert.equal(p.median, 21); // 1+2+3+4+5+6, not 0+1+2+3+4+5.
  assert.equal(p.n, 21); assert.equal(p.calibrated_probability, false);
});
test('Precipitation missing interval blocks affected member total', () => {
  const r = syntheticRecord(), v0 = validateRecord(r);
  r.raw_response.hourly.precipitation[3] = null;
  const p = precipitationPeriod(validateRecord(r), v0.timestamps[0], v0.timestamps[6]);
  assert.equal(p.n, 20); assert.equal(p.complete, false);
});
test('Following-night low does not reuse preceding early-morning low', () => {
  const r = syntheticRecord(); const raw = r.raw_response;
  for (const k of Object.keys(raw.hourly).filter(x => x.startsWith('temperature_2m'))) {
    raw.hourly[k][raw.hourly.time.indexOf('2026-10-08T08:00')] = -10;
    raw.hourly[k][raw.hourly.time.indexOf('2026-10-09T09:00')] = 5;
  }
  const d = summarizeRecord(r, NOW).days[0];
  assert.equal(d.celsius.following_night_low.median, 5);
  assert.equal(d.fahrenheit.following_night_low.median, 41);
});
test('Daylight-saving autumn night has 13 hours; spring night has 11', () => {
  assert.equal((boundary('2026-11-01', 6) - boundary('2026-10-31', 18)) / 3600000, 13);
  assert.equal((boundary('2026-03-08', 6) - boundary('2026-03-07', 18)) / 3600000, 11);
});
test('Acquisition schedules keep Eastern local time across DST', () => {
  assert.match(scheduleSlot(Date.parse('2026-10-31T09:35:00Z')), /05:35/);
  assert.equal(scheduleSlot(Date.parse('2026-11-01T09:35:00Z')), null);
  assert.match(scheduleSlot(Date.parse('2026-11-01T10:35:00Z')), /05:35/);
  assert.match(scheduleSlot(Date.parse('2026-11-01T16:35:00Z')), /11:35/);
  assert.match(scheduleSlot(Date.parse('2026-11-01T22:35:00Z')), /17:35/);
});
test('Serving an old cached successful response is not ready', () => {
  const sum = summarizeCapture(syntheticCapture(), NOW);
  assert.equal(serveState(sum, NOW).ready, true);
  assert.equal(serveState(sum, NOW + 91 * 60000).ready, false);
});
test('One absent model means no complete comparison', () => {
  const cap = syntheticCapture(); cap.records.pop();
  assert.equal(serveState(summarizeCapture(cap, NOW), NOW).ready, false);
});
test('Duplicate model records are rejected', () => {
  const cap = syntheticCapture(); cap.records.push(clone(cap.records[0]));
  assert.throws(() => summarizeCapture(cap, NOW), /Duplicate model/);
});
test('Stale metadata blocks readiness despite fresh retrieval', () => {
  const cap = syntheticCapture();
  for (const r of cap.records) { const m = meta(); m.raw_response.last_run_initialisation_time = NOW / 1000 - 4 * 86400;
    r.metadata_before = m; r.metadata_after = clone(m); }
  assert.equal(serveState(summarizeCapture(cap, NOW), NOW).ready, false);
});
test('Explicit returned model mismatch is rejected when provider echoes an identity', () => {
  const r = syntheticRecord(); r.raw_response.model = 'ecmwf_aifs025_ensemble';
  assert.throws(() => validateRecord(r), /model identity conflicts/);
});

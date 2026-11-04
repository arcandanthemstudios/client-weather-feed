import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecord, summarizeRecord, summarizeCapture, serveState, precipitationPeriod, iso, TARGET, MODELS } from '../src/core.mjs';
import { publicView } from '../src/public-view.mjs';

// Synthetic fixtures only. No private captures, locations or report receipts are copied here.
const NOW = Date.parse('2026-11-04T12:00:00Z'), HOUR = 3600000;
function fixture(model = 'ecmwf_ifs025_ensemble') {
  const time = Array.from({ length: 120 }, (_, i) => iso(Date.parse('2026-11-03T00:00:00Z') + i * HOUR));
  const hourly = { time }, hourly_units = { time: 'iso8601' };
  for (const [variable, unit, value] of [['temperature_2m', '°C', 10], ['precipitation', 'mm', 0.2], ['wind_speed_10m', 'm/s', 3]]) {
    for (let id = 0; id < MODELS[model].count; id++) {
      const key = id === 0 ? variable : `${variable}_member${String(id).padStart(2, '0')}`;
      hourly[key] = time.map(() => value); hourly_units[key] = unit;
    }
  }
  return { requested_model: model, requested_coordinates: [TARGET.latitude, TARGET.longitude],
    http_status: 200, requested_at_utc: iso(NOW - 1000), received_at_utc: iso(NOW),
    raw_response: { latitude: TARGET.latitude, longitude: TARGET.longitude, timezone: 'GMT',
      utc_offset_seconds: 0, hourly_units, hourly } };
}
function window(record, a = 40, b = 46) {
  const v = validateRecord(record);
  return precipitationPeriod(v, v.timestamps[a], v.timestamps[b]);
}
function defective() {
  const r = fixture(); r.raw_response.hourly.precipitation_member16[43] = -0.1; return r;
}

test('Negative precipitation is isolated with exact member, time, index and original value', () => {
  const r = defective(), raw = structuredClone(r.raw_response), v = validateRecord(r).variables.precipitation;
  assert.equal(v.usable, false); assert.equal(v.window_usable, true);
  assert.equal(v.invalid_value_count, 1); assert.equal(v.missing_values, 0);
  assert.equal(v.arrays.length, 51); assert.equal(v.arrays[16][43], null);
  assert.equal(v.arrays[16][44], 0.2); assert.equal(v.arrays[15][43], 0.2);
  assert.deepEqual(v.invalid_values, [{ member_id: 16, index: 43, valid_utc: raw.hourly.time[43], value: -0.1, reason: 'negative' }]);
  assert.deepEqual(r.raw_response, raw);
});
test('Affected window retains expected denominator but publishes no reduced-member estimates', () => {
  const p = window(defective());
  assert.equal(p.n, 50); assert.equal(p.expected_n, 51); assert.equal(p.complete, false);
  for (const key of ['median', 'p10', 'p90', 'raw_member_fraction', 'members_at_or_above_threshold']) assert.equal(p[key], null);
  assert.deepEqual(p.incomplete_member_ids, [16]);
});
test('Unaffected windows still include all 51 members, including previously affected member', () => {
  const p = window(defective(), 44, 50);
  assert.equal(p.n, 51); assert.equal(p.expected_n, 51); assert.equal(p.complete, true);
  assert.ok(Math.abs(p.median - 1.2) < 1e-12); assert.equal(p.raw_member_fraction, 1);
});
test('Preceding-hour boundaries exclude start and include end', () => {
  const r = fixture(); r.raw_response.hourly.precipitation_member16[40] = -0.1;
  assert.equal(window(r).complete, true);
  r.raw_response.hourly.precipitation_member16[46] = -0.1;
  assert.equal(window(r).complete, false);
});
test('Affected hourly precipitation is unavailable, adjacent hours and temperature/wind survive', () => {
  const r = defective(), sum = summarizeRecord(r, NOW);
  const hour = sum.hourly.find(h => h.valid_utc === r.raw_response.hourly.time[43]);
  assert.equal(hour.precipitation_previous_hour_mm.median, null);
  assert.equal(hour.precipitation_previous_hour_mm.n, 50);
  assert.equal(hour.temperature_c.complete, true); assert.equal(hour.wind_speed_ms.complete, true);
  const next = sum.hourly.find(h => h.valid_utc === r.raw_response.hourly.time[44]);
  assert.equal(next.precipitation_previous_hour_mm.complete, true);
  assert.equal(sum.variables.precipitation.status, 'partial_values');
  assert.equal(sum.variables.precipitation.invalid_value_count, 1);
  assert.deepEqual(sum.variables.precipitation.affected_member_ids, [16]);
});
test('Future bad values still block global readiness; independent Canadian data remain complete', () => {
  const capture = { saved_at_utc: iso(NOW), records: [defective(), fixture('cmc_gem_geps')] };
  const s = summarizeCapture(capture, NOW), gate = serveState(s, NOW);
  assert.equal(gate.ready, false); assert.equal(gate.models[0].usable, false); assert.equal(gate.models[1].usable, true);
});
test('Past defects do not erase valid future periods, but snapshot gate remains conservatively partial', () => {
  const r = fixture(); r.raw_response.hourly.precipitation_member16[3] = -0.1;
  const s = summarizeRecord(r, NOW);
  assert.equal(s.complete_future_required_variables, true);
  assert.equal(s.returned_value_checks_passed, false);
  assert.ok(s.hourly.every(h => h.precipitation_previous_hour_mm.complete));
  assert.equal(serveState({ models: [s, summarizeRecord(fixture('cmc_gem_geps'), NOW)] }, NOW).ready, false);
});
test('Three bad cells in one member do not delete that member from valid windows', () => {
  const r = fixture(); [43, 44, 45].forEach(i => r.raw_response.hourly.precipitation_member16[i] = -0.1);
  const v = validateRecord(r).variables.precipitation;
  assert.equal(v.invalid_value_count, 3); assert.equal(v.arrays.length, 51);
  assert.equal(window(r, 46, 52).n, 51); assert.equal(window(r).n, 50);
});
test('Six bad cells across two members report both members and no subset fraction', () => {
  const r = fixture(); for (const member of [37, 48]) for (const i of [43, 44, 45]) r.raw_response.hourly[`precipitation_member${member}`][i] = -0.1;
  const p = window(r); assert.equal(p.n, 49); assert.deepEqual(p.incomplete_member_ids, [37, 48]);
  assert.equal(p.raw_member_fraction, null); assert.equal(window(r, 46, 52).n, 51);
});
test('Null remains missing, distinct from rejected negative value', () => {
  const r = defective(); r.raw_response.hourly.precipitation[44] = null;
  const v = validateRecord(r).variables.precipitation;
  assert.equal(v.missing_values, 1); assert.equal(v.invalid_value_count, 1);
  assert.equal(window(r).n, 49); assert.equal(window(r).raw_member_fraction, null);
});
test('Non-numeric cell cannot be coerced into a number or zero', () => {
  const r = fixture(); r.raw_response.hourly.temperature_2m_member16[43] = '10';
  const v = validateRecord(r).variables.temperature_2m;
  assert.equal(v.usable, false); assert.equal(v.arrays[16][43], null);
  assert.equal(v.invalid_values[0].reason, 'non_numeric');
  assert.equal(r.raw_response.hourly.temperature_2m_member16[43], '10');
});
test('Negative temperatures remain valid; negative winds are isolated', () => {
  const r = fixture(); r.raw_response.hourly.temperature_2m[43] = -10;
  r.raw_response.hourly.wind_speed_10m[43] = -1;
  const v = validateRecord(r);
  assert.equal(v.variables.temperature_2m.usable, true);
  assert.equal(v.variables.wind_speed_10m.invalid_value_count, 1);
});
for (const [name, change] of [
  ['missing member', r => delete r.raw_response.hourly.precipitation_member16],
  ['duplicate member', r => { r.raw_response.hourly.precipitation_member00 = [...r.raw_response.hourly.precipitation]; }],
  ['wrong unit', r => { r.raw_response.hourly_units.precipitation_member16 = 'inch'; }],
  ['wrong array length', r => r.raw_response.hourly.precipitation_member16.pop()]
]) test(`${name} still rejects whole field, not just selected cells`, () => {
  const r = fixture(); change(r); const v = validateRecord(r).variables.precipitation;
  assert.equal(v.window_usable, false); assert.deepEqual(v.arrays, []); assert.equal(window(r).complete, false);
});
test('Wrong place, wrong model and time gaps still fail closed', () => {
  const r = fixture(); r.raw_response.latitude = 50;
  assert.throws(() => validateRecord(r), /wrong-place/);
  const x = fixture(); x.raw_response.model = 'best_match';
  assert.throws(() => validateRecord(x), /identity/);
  const y = fixture(); y.raw_response.hourly.time[43] = y.raw_response.hourly.time[44];
  assert.throws(() => validateRecord(y), /gap/);
});
test('Freshness and unknown run provenance are not upgraded by granular validation', () => {
  const capture = { saved_at_utc: iso(NOW), records: [fixture(), fixture('cmc_gem_geps')] };
  const s = summarizeCapture(capture, NOW);
  assert.equal(serveState(s, NOW).ready, true);
  assert.equal(serveState(s, NOW + 91 * 60000).ready, false);
  assert.equal(s.same_run_comparison_permitted, false);
  assert.equal(s.models[0].metadata.forecast_values_initialization_verified, false);
});
test('Raw retry evidence and detailed rejected values are excluded from public projections', () => {
  const data = publicView({ numerical_attempts: [{ raw_response: { private: 'marker' } }],
    invalid_values: [{ value: 'marker' }], raw_response: { private: 'marker' }, invalid_value_count: 1 });
  assert.deepEqual(data, { invalid_value_count: 1 });
});

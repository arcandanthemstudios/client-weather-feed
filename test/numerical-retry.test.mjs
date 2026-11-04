import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectModel, collect, NUMERICAL_RETRY_WAIT_MS, MAX_NUMERICAL_RETRIES } from '../src/collect.mjs';
import { MODELS, TARGET, iso } from '../src/core.mjs';
const NOW = Date.parse('2026-11-04T12:00:00Z');
function raw(model = 'ecmwf_ifs025_ensemble', bad = false) {
  const time = Array.from({ length: 120 }, (_, i) => iso(Date.parse('2026-11-03T00:00:00Z') + i * 3600000));
  const hourly = { time }, hourly_units = { time: 'iso8601' };
  for (const [v, unit, value] of [['temperature_2m', '°C', 10], ['precipitation', 'mm', 0.2], ['wind_speed_10m', 'm/s', 3]]) {
    for (let id = 0; id < MODELS[model].count; id++) {
      const k = id === 0 ? v : `${v}_member${String(id).padStart(2, '0')}`;
      hourly[k] = time.map(() => value); hourly_units[k] = unit;
    }
  }
  if (bad) hourly.precipitation_member16[43] = -0.1;
  return { latitude: TARGET.latitude, longitude: TARGET.longitude, timezone: 'GMT', utc_offset_seconds: 0, hourly_units, hourly };
}
function setup(payloads, headers = {}) {
  let now = NOW, count = 0;
  const calls = [], sleeps = [];
  const meta = () => ({ last_run_initialisation_time: NOW / 1000 - 43200, last_run_availability_time: NOW / 1000 - 36000,
    last_run_modification_time: NOW / 1000 - 36600, temporal_resolution_seconds: 10800, update_interval_seconds: 43200 });
  return { calls, sleeps, count: () => count, options: { clock: () => now, sleep: async ms => { sleeps.push(ms); now += ms; },
    fetchImpl: async url => {
      calls.push(url);
      if (new URL(url).pathname.endsWith('meta.json')) return new Response(JSON.stringify(meta()), { headers: { 'content-type': 'application/json' } });
      const p = payloads[Math.min(count++, payloads.length - 1)];
      if (p instanceof Response) return new Response(null, { status: p.status, headers: p.headers });
      return new Response(JSON.stringify(p), { headers: { 'content-type': 'application/json', ...headers } });
    } } };
}
test('Clean source needs no numerical retry', async () => {
  const h = setup([raw()]); const r = await collectModel('ecmwf_ifs025_ensemble', h.options);
  assert.equal(h.count(), 1); assert.equal(r.numerical_retry.performed, false); assert.deepEqual(h.sleeps, []);
});
test('One bounded retry recovers a bad payload and preserves raw attempts and hashes', async () => {
  const bad = raw('ecmwf_ifs025_ensemble', true), good = raw();
  const h = setup([bad, good]); const r = await collectModel('ecmwf_ifs025_ensemble', h.options);
  assert.equal(MAX_NUMERICAL_RETRIES, 1); assert.equal(h.count(), 2); assert.deepEqual(h.sleeps, [NUMERICAL_RETRY_WAIT_MS]);
  assert.equal(r.numerical_retry.selected_attempt, 2); assert.equal(r.numerical_attempts.length, 2);
  assert.equal(r.numerical_attempts[0].record.raw_response.hourly.precipitation_member16[43], -0.1);
  assert.equal(r.raw_response.hourly.precipitation_member16[43], 0.2);
  assert.equal(r.response_sha256, createHash('sha256').update(JSON.stringify(good)).digest('hex'));
  assert.equal(r.numerical_attempts[0].record.response_sha256, createHash('sha256').update(JSON.stringify(bad)).digest('hex'));
  assert.equal(r.received_at_utc, iso(NOW + NUMERICAL_RETRY_WAIT_MS));
  assert.equal(r.numerical_retry.response_splicing_permitted, false);
  assert.equal(r.numeric_validation.same_run_comparison_permitted, false);
  assert.equal(r.numeric_validation.model_initialization, null);
  const forecastCalls = h.calls.filter(x => new URL(x).pathname === '/v1/ensemble');
  assert.equal(forecastCalls[0], forecastCalls[1]);
  assert.equal(h.calls.filter(x => x.endsWith('/static/meta.json')).length, 4);
});
test('Persistent invalid data stop after one retry and retain original acquisition time', async () => {
  const h = setup([raw('ecmwf_ifs025_ensemble', true)]); const r = await collectModel('ecmwf_ifs025_ensemble', h.options);
  assert.equal(h.count(), 2); assert.equal(r.numerical_retry.selected_attempt, 1); assert.equal(r.received_at_utc, iso(NOW));
  assert.equal(r.numerical_retry.latest_attempt_received_at_utc, iso(NOW + 5000));
  assert.equal(r.raw_response.hourly.precipitation_member16[43], -0.1);
});
test('Failed retry cannot erase first response or loop on transport errors', async () => {
  const h = setup([raw('ecmwf_ifs025_ensemble', true), new Response('', { status: 503 })]);
  const r = await collectModel('ecmwf_ifs025_ensemble', h.options);
  assert.equal(h.count(), 2); assert.equal(r.numerical_retry.selected_attempt, 1);
  assert.equal(r.numerical_retry.latest_attempt_status, 'access_failed');
  assert.equal(r.numerical_attempts[1].record.http_status, 503);
  assert.deepEqual(h.sleeps, [5000]);
});
test('No field or member splicing when retry has a different defect', async () => {
  const first = raw('ecmwf_ifs025_ensemble', true), second = raw(); second.hourly.temperature_2m[45] = null;
  const h = setup([first, second]); const r = await collectModel('ecmwf_ifs025_ensemble', h.options);
  assert.equal(r.numerical_retry.selected_attempt, 1); assert.deepEqual(r.raw_response, first);
});
test('Shorter clean retry does not discard original unaffected forecast coverage', async () => {
  const first = raw('ecmwf_ifs025_ensemble', true), short = raw();
  for (const key of Object.keys(short.hourly)) short.hourly[key] = short.hourly[key].slice(0, 6);
  const h = setup([first, short]); const r = await collectModel('ecmwf_ifs025_ensemble', h.options);
  assert.equal(r.numerical_retry.selected_attempt, 1); assert.equal(r.raw_response.hourly.time.length, 120);
});
test('A null numerical value also gets one bounded retry', async () => {
  const first = raw(); first.hourly.precipitation_member16[43] = null;
  const h = setup([first, raw()]); const r = await collectModel('ecmwf_ifs025_ensemble', h.options);
  assert.equal(h.count(), 2); assert.equal(r.numerical_retry.selected_attempt, 2);
});
test('Provider Retry-After longer than budget prevents numerical retry', async () => {
  const h = setup([raw('ecmwf_ifs025_ensemble', true)], { 'retry-after': '60' });
  const r = await collectModel('ecmwf_ifs025_ensemble', h.options);
  assert.equal(h.count(), 1); assert.deepEqual(h.sleeps, []);
  assert.equal(r.numerical_retry.reason, 'provider_retry_after_exceeds_budget');
  assert.equal(r.numerical_retry.do_not_retry_before_utc, iso(NOW + 60000));
});
test('Short provider Retry-After is honored', async () => {
  const h = setup([raw('ecmwf_ifs025_ensemble', true), raw()], { 'retry-after': '8' });
  const r = await collectModel('ecmwf_ifs025_ensemble', h.options);
  assert.deepEqual(h.sleeps, [8000]); assert.equal(r.numerical_retry.selected_attempt, 2);
});
test('Rate limiting during retry is visible and does not cause extra attempts', async () => {
  const h = setup([raw('ecmwf_ifs025_ensemble', true), new Response('', { status: 429, headers: { 'retry-after': '120' } })]);
  const r = await collectModel('ecmwf_ifs025_ensemble', h.options);
  assert.equal(h.count(), 2); assert.equal(r.numerical_attempts[1].record.http_status, 429);
  assert.equal(r.numerical_retry.selected_attempt, 1);
  assert.ok(r.numerical_attempts[1].record.do_not_retry_before_utc);
});
test('Identity or wrong-place failure remains rejected without numerical retry', async () => {
  const wrong = raw(); wrong.latitude = 60;
  const h = setup([wrong]); const r = await collectModel('ecmwf_ifs025_ensemble', h.options);
  assert.equal(h.count(), 1); assert.equal(r.status, 'invalid_numerical_response');
});
test('Only failing model is retried; healthy Canadian source is fetched once', async () => {
  const h = setup([raw('ecmwf_ifs025_ensemble', true), raw(), raw('cmc_gem_geps')]);
  const cap = await collect(h.options);
  assert.equal(h.count(), 3);
  const models = h.calls.filter(x => new URL(x).pathname === '/v1/ensemble').map(x => new URL(x).searchParams.get('models'));
  assert.deepEqual(models, ['ecmwf_ifs025_ensemble', 'ecmwf_ifs025_ensemble', 'cmc_gem_geps']);
  assert.equal(cap.records[1].numerical_retry.performed, false);
});

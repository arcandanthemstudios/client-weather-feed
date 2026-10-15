import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastURL, metadataURL, requestJSON, collectModel } from '../src/collect.mjs';
import { NOW, original, clone } from './helpers.mjs';
const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers } });
test('Expanded request explicitly selects model and required temperature/rain/wind units', () => {
  const url = new URL(forecastURL('cmc_gem_geps'));
  assert.equal(url.searchParams.get('models'), 'cmc_gem_geps');
  assert.equal(url.searchParams.get('hourly'), 'temperature_2m,precipitation,wind_speed_10m');
  assert.equal(url.searchParams.get('past_days'), '1'); assert.equal(url.searchParams.get('forecast_days'), '4');
  assert.equal(url.searchParams.get('wind_speed_unit'), 'ms');
  assert.equal(url.searchParams.get('timezone'), 'UTC');
});
test('Acquisition cannot become an arbitrary network proxy', async () => {
  await assert.rejects(requestJSON('https://example.com'), /fixed approved/);
});
test('Valid JSON response has byte hash and retrieval timestamp', async () => {
  const got = await requestJSON(forecastURL('cmc_gem_geps'), { fetchImpl: async () => reply({ test: 1 }), clock: () => NOW });
  assert.equal(got.raw_response.test, 1); assert.match(got.response_sha256, /^[a-f0-9]{64}$/);
  assert.equal(got.http_status, 200);
});
test('HTTP200 HTML shell is not data', async () => {
  const got = await requestJSON(metadataURL('cmc_gem_geps'), {
    fetchImpl: async () => new Response('<html>Hello</html>', { headers: { 'Content-Type': 'text/html' } }) });
  assert.equal(got.status, 'access_failed'); assert.equal(got.raw_response, undefined);
});
test('HTTP400 does not repeatedly retry malformed requests', async () => {
  let calls = 0;
  const got = await requestJSON(metadataURL('cmc_gem_geps'), { fetchImpl: async () => { calls++; return reply({ error: true }, 400); } });
  assert.equal(calls, 1); assert.equal(got.http_status, 400);
});
test('HTTP429 Retry-After is honored when inside the retry budget', async () => {
  let calls = 0; const waits = [];
  const got = await requestJSON(metadataURL('cmc_gem_geps'), {
    fetchImpl: async () => ++calls === 1 ? reply({}, 429, { 'Retry-After': '2' }) : reply({ data: 1 }),
    sleep: async n => waits.push(n), clock: () => NOW });
  assert.deepEqual(waits, [2000]); assert.equal(got.status, 'json_received');
});
test('Long Retry-After stops retrying instead of shortening provider limit', async () => {
  let calls = 0;
  const got = await requestJSON(metadataURL('cmc_gem_geps'), {
    fetchImpl: async () => { calls++; return reply({}, 429, { 'Retry-After': '120' }); }, clock: () => NOW });
  assert.equal(calls, 1); assert.ok(got.do_not_retry_before_utc);
});
test('Download-size cap rejects oversized response', async () => {
  const got = await requestJSON(metadataURL('cmc_gem_geps'), {
    fetchImpl: async () => reply({ large: 'x'.repeat(1000) }), maxBytes: 100 });
  assert.equal(got.status, 'access_failed'); assert.match(got.error, /download limit/);
});
test('Actual uploaded response can pass through acquisition adapter via a mock transport', async () => {
  const raw = clone(original.records[1].raw_response);
  let forecastCalls = 0;
  const record = await collectModel('cmc_gem_geps', { variables: ['temperature_2m'], probe: true, clock: () => NOW,
    fetchImpl: async url => {
      if (url.includes('/v1/ensemble')) { forecastCalls++; return reply(raw); }
      return reply({}, 404);
    } });
  assert.equal(forecastCalls, 1); assert.equal(record.numeric_validation.member_series, 21);
  assert.equal(record.status, 'numerical_values_received_initialization_unverified');
  assert.equal(record.metadata_before.status, 'access_failed');
});

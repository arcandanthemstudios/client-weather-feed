import { readFileSync } from 'node:fs';
import { MODELS, TARGET, iso } from '../src/core.mjs';
export const original = JSON.parse(readFileSync(new URL('./fixtures/browser-capture.json', import.meta.url), 'utf8'));
export const clone = x => structuredClone(x);
export const NOW = Date.parse('2026-10-08T20:04:14.406Z');
/** Synthetic test fixture. Never copied into a production feed or described as observed data. */
export function syntheticRecord(model = 'cmc_gem_geps', now = NOW) {
  const n = MODELS[model].count;
  const start = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z') - 86400000;
  const time = Array.from({ length: 144 }, (_, i) => iso(start + i * 3600000).slice(0, 16));
  const hourly = { time }, hourly_units = { time: 'iso8601' };
  for (const [variable, unit, value] of [['temperature_2m', '°C', 20], ['precipitation', 'mm', 0.2], ['wind_speed_10m', 'm/s', 3]]) {
    for (let id = 0; id < n; id++) {
      const k = id === 0 ? variable : `${variable}_member${String(id).padStart(2, '0')}`;
      hourly[k] = time.map(() => value); hourly_units[k] = unit;
    }
  }
  return { requested_model: model, requested_coordinates: [TARGET.latitude, TARGET.longitude],
    requested_at_utc: iso(now - 1000), received_at_utc: iso(now), http_status: 200,
    url: 'synthetic://unit-test-only', raw_response: { latitude: 40, longitude: model.startsWith('ecmwf') ? -75.25 : -75,
      timezone: 'GMT', utc_offset_seconds: 0, hourly_units, hourly } };
}
export function syntheticCapture(now = NOW) {
  return { capture_schema: 'SYNTHETIC_TEST_ONLY', saved_at_utc: iso(now),
    records: Object.keys(MODELS).map(m => syntheticRecord(m, now)) };
}
export function meta(now = NOW) {
  return { http_status: 200, raw_response: {
    last_run_initialisation_time: Math.floor(now / 1000) - 12 * 3600,
    last_run_availability_time: Math.floor(now / 1000) - 10 * 3600,
    last_run_modification_time: Math.floor(now / 1000) - 10 * 3600 - 600,
    temporal_resolution_seconds: 10800, update_interval_seconds: 43200 } };
}
export class MemoryStore {
  constructor() { this.data = { capture: null, last_attempt: null, last_schedule_slot: null }; this.saved = 0; this.archived = []; }
  async load() { return clone(this.data); }
  async save(state) { this.data = clone(state); this.saved++; }
  async archive(capture) { this.archived.push(clone(capture)); }
}

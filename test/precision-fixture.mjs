import { createHash } from 'node:crypto';
import { syntheticRecord, clone } from './helpers.mjs';
import { roundTenth } from '../src/precipitation-quality.mjs';
export const NOW = Date.parse('2026-11-17T12:00:00Z'), RUN = Date.parse('2026-11-17T00:00:00Z');
const iso = t => new Date(t).toISOString();
const sha = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function fixture(nativeMm = -0.2) {
  const r = syntheticRecord('ecmwf_ifs025_ensemble', NOW);
  const n = clone(r.raw_response);
  n.hourly = { time: r.raw_response.hourly.time.filter((_, i) => i % 3 === 0) };
  n.hourly_units = { time: 'iso8601' };
  for (let id = 0; id < 51; id++) {
    const k = id ? `precipitation_member${String(id).padStart(2,'0')}` : 'precipitation';
    r.raw_response.hourly[k].fill(0);
    n.hourly[k] = n.hourly.time.map(() => 0); n.hourly_units[k] = 'mm';
  }
  const valid = iso(RUN + 36 * 3600000), member = 44;
  const ni = n.hourly.time.findIndex(t => Date.parse(t + 'Z') === Date.parse(valid));
  n.hourly.precipitation_member44[ni] = nativeMm;
  const indices = [-2, -1, 0].map(h => r.raw_response.hourly.time.findIndex(t => Date.parse(t + 'Z') === Date.parse(valid) + h * 3600000));
  for (const i of indices) r.raw_response.hourly.precipitation_member44[i] = roundTenth(nativeMm / 3);
  const metadata = { last_run_initialisation_time: RUN / 1000, last_run_availability_time: RUN / 1000 + 4 * 3600,
    last_run_modification_time: RUN / 1000 + 4 * 3600, temporal_resolution_seconds: 10800, update_interval_seconds: 21600 };
  r.metadata_before = { raw_response: metadata }; r.metadata_after = clone(r.metadata_before);
  r.response_sha256 = sha(r.raw_response);
  const sample = step => ({ paramId: 228, shortName: 'tp', units: 'm', startStep: 0, endStep: step,
    member_id: member, initialization_utc: iso(RUN), valid_utc: iso(RUN + step * 3600000),
    latitude: r.raw_response.latitude, longitude: r.raw_response.longitude, gridType: 'regular_ll', grid_spacing_degrees: 0.25,
    packingType: 'grid_ccsds', bitsPerValue: 12, binaryScaleFactor: -12, decimalScaleFactor: 0,
    packing_error_mm: 0.1220703125, accumulation_mm: 7.8125, sha256: 'a'.repeat(64),
    source_url: `https://storage.googleapis.com/ecmwf-open-data/20261117/00z/ifs/0p25/enfo/20261117000000-${step}h-enfo-ef.grib2` });
  const previous = sample(33), current = sample(36); current.accumulation_mm -= 0.244140625;
  if (nativeMm === -0.1) { previous.binaryScaleFactor = current.binaryScaleFactor = -13;
    previous.packing_error_mm = current.packing_error_mm = 0.06103515625; current.accumulation_mm = previous.accumulation_mm - 0.1220703125; }
  r.precipitation_quality = { policy: 'ecmwf-packing-v1', source_response_sha256: r.response_sha256,
    native_response_sha256: sha(n), native: { http_status: 200, received_at_utc: iso(NOW), raw_response: n, response_sha256: sha(n) },
    proofs: { status: 'checked', intervals: [{ member_id: member, valid_utc: valid, previous, current }] } };
  return { r, indices, interval: r.precipitation_quality.proofs.intervals[0] };
}

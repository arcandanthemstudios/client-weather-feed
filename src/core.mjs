/** Pure analysis and validation. No network, file writes, calendar or task access. */
export const SCHEMA = 'philly-ensemble-service-v1';
export const TARGET = Object.freeze({ latitude: 39.95, longitude: -75.16,
  label: '19107 representative target', postal_polygon_verified: false });
export const ZONE = 'America/New_York';
export const MODELS = Object.freeze({
  ecmwf_ifs025_ensemble: { name: 'ECMWF IFS ENS via Open-Meteo', count: 51 },
  cmc_gem_geps: { name: 'Canadian GEPS via Open-Meteo', count: 21 }
});
export const REQUIRED = Object.freeze(['temperature_2m', 'precipitation', 'wind_speed_10m']);
export const UNITS = Object.freeze({ temperature_2m: '°C', precipitation: 'mm',
  wind_speed_10m: 'm/s', wind_gusts_10m: 'm/s' });
const HOUR = 3600000;
const finite = v => typeof v === 'number' && Number.isFinite(v);
export const cToF = c => c * 1.8 + 32;
export const msToMph = v => v * 2.2369362920544;
export const iso = t => new Date(t).toISOString();
export function parseUTC(s) {
  if (typeof s === 'number' && finite(s)) return s * 1000;
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|\+00:00)?$/.test(s))
    throw new Error(`Invalid UTC timestamp: ${String(s).slice(0, 80)}`);
  const n = Date.parse(/Z$|\+00:00$/.test(s) ? s : s + 'Z');
  if (!Number.isFinite(n)) throw new Error('Invalid UTC time');
  return n;
}
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export function localParts(t) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
export function addDate(date, days) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
export function boundary(date, hour) {
  const [y, m, d] = date.split('-').map(Number);
  const want = Date.UTC(y, m - 1, d, hour);
  let utc = want;
  for (let i = 0; i < 5; i++) {
    const p = localParts(utc), [yy, mm, dd] = p.date.split('-').map(Number);
    const difference = want - Date.UTC(yy, mm - 1, dd, p.hour, p.minute);
    if (difference === 0) return utc;
    utc += difference;
  }
  throw new Error('Could not resolve local boundary (use unambiguous hours)');
}
export function scheduleSlot(now) {
  const p = localParts(now);
  // One ten-minute opportunity per slot. Restart collection is handled separately.
  if ([5, 11, 17].includes(p.hour) && p.minute >= 35 && p.minute < 45)
    return `${p.date}T${String(p.hour).padStart(2, '0')}:35[${ZONE}]`;
  return null;
}
export function kmBetween(a, b) {
  const r = x => x * Math.PI / 180;
  const h = Math.sin(r(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(r(b.longitude - a.longitude) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function stats(values, expected) {
  const a = values.filter(finite).sort((x, y) => x - y);
  const q = p => {
    if (!a.length) return null;
    const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return a[lo] + (a[hi] - a[lo]) * (i - lo);
  };
  return { n: a.length, expected_n: expected, complete: a.length === expected,
    p10: q(0.1), median: q(0.5), p90: q(0.9),
    interpretation: 'raw ensemble spread, not calibrated confidence bounds' };
}
function memberMap(hourly, variable) {
  const out = new Map();
  for (const key of Object.keys(hourly)) {
    if (key !== variable && !key.startsWith(variable + '_member')) continue;
    const suffix = key === variable ? '0' : key.slice(variable.length + 7);
    if (!/^\d+$/.test(suffix)) throw new Error(`Unrecognized member key: ${key}`);
    const id = Number(suffix);
    if (out.has(id)) throw new Error(`Duplicate member identity ${id} for ${variable}`);
    out.set(id, hourly[key]);
  }
  return out;
}
export function validateRecord(record, variables = REQUIRED) {
  const spec = MODELS[record.requested_model];
  if (!spec) throw new Error('Unknown or non-ensemble model; no automatic substitution allowed');
  if (record.http_status !== 200) throw new Error(`Not a successful numerical response: ${record.http_status}`);
  const raw = record.raw_response;
  if (!raw || Array.isArray(raw) || raw.error || !raw.hourly || !raw.hourly_units)
    throw new Error('Response is not a single-location ensemble JSON object');
  const echoed = raw.model ?? raw.models;
  if (echoed !== undefined && echoed !== null &&
      !(echoed === record.requested_model || (Array.isArray(echoed) && echoed.length === 1 && echoed[0] === record.requested_model)))
    throw new Error('Returned model identity conflicts with explicit request');
  if (raw.utc_offset_seconds !== 0 || !['UTC', 'GMT', 'Etc/UTC'].includes(raw.timezone))
    throw new Error('Expected UTC data, not local or unknown timestamps');
  if (!finite(raw.latitude) || !finite(raw.longitude)) throw new Error('Missing sampled coordinates');
  if (Math.abs(raw.latitude) > 90 || Math.abs(raw.longitude) > 180) throw new Error('Bad sampled coordinates');
  if (Array.isArray(record.requested_coordinates) &&
      (Math.abs(record.requested_coordinates[0] - TARGET.latitude) > 1e-6 ||
       Math.abs(record.requested_coordinates[1] - TARGET.longitude) > 1e-6))
    throw new Error('Capture uses a different requested target');
  const sampled = { latitude: raw.latitude, longitude: raw.longitude };
  const distance = kmBetween(TARGET, sampled);
  if (distance > 40) throw new Error(`Sampled location is ${distance.toFixed(1)} km away; wrong-place response rejected`);
  const time = raw.hourly.time;
  if (!Array.isArray(time) || !time.length) throw new Error('No valid times');
  const timestamps = time.map(parseUTC);
  if (raw.hourly_units.time !== 'iso8601' && raw.hourly_units.time !== 'unixtime')
    throw new Error('Unrecognized time units');
  for (let i = 1; i < timestamps.length; i++)
    if (timestamps[i] - timestamps[i - 1] !== HOUR) throw new Error('Hourly time axis has a duplicate, gap or non-hourly step');
  const result = {}, issues = [];
  for (const variable of variables) {
    if (!UNITS[variable]) throw new Error('Unsupported variable semantics');
    let map;
    try { map = memberMap(raw.hourly, variable); }
    catch (error) { issues.push(error.message); result[variable] = { usable: false, problems: [error.message] }; continue; }
    const problems = [];
    if (map.size !== spec.count || Array.from({ length: spec.count }, (_, i) => i).some(i => !map.has(i)))
      problems.push(`Expected exactly API series IDs 0..${spec.count - 1}; received ${map.size}`);
    const arrays = [];
    let missing = 0;
    for (let id = 0; id < spec.count; id++) {
      const a = map.get(id), key = id === 0 ? variable : `${variable}_member${String(id).padStart(2, '0')}`;
      if (!a) continue;
      const unitKey = Object.keys(raw.hourly).find(k => k === key ||
        (id > 0 && k.startsWith(variable + '_member') && Number(k.slice(variable.length + 7)) === id));
      if (raw.hourly_units[unitKey] !== UNITS[variable]) problems.push(`Unexpected ${variable} units for member ${id}`);
      if (!Array.isArray(a) || a.length !== timestamps.length) { problems.push(`Bad ${variable} array length for member ${id}`); continue; }
      if (a.some(v => v !== null && !finite(v))) problems.push(`Non-numeric ${variable} value for member ${id}`);
      if (variable !== 'temperature_2m' && a.some(v => finite(v) && v < 0)) problems.push(`Negative ${variable}; interval semantics or data invalid`);
      missing += a.filter(v => v === null).length;
      arrays.push(a);
    }
    result[variable] = { usable: problems.length === 0, arrays: problems.length ? [] : arrays,
      missing_values: missing, expected_members: spec.count, problems: [...new Set(problems)] };
    issues.push(...problems);
  }
  return { requested_model: record.requested_model, expected_members: spec.count,
    requested_coordinates: TARGET, sampled_coordinates: sampled, grid_distance_km: distance,
    timestamps, variables: result, problems: [...new Set(issues)],
    upstream_member_roles: 'API series includes base series; upstream control identity not independently verified',
    returned_model_identity: raw.model ?? raw.models ?? null,
    model_identity_basis: 'explicit requested model, not independently echoed upstream GRIB metadata' };
}
export function assessMetadata(before, after, receivedAt) {
  const b = before?.raw_response, a = after?.raw_response;
  const good = x => x && ['last_run_initialisation_time', 'last_run_availability_time',
    'last_run_modification_time', 'temporal_resolution_seconds', 'update_interval_seconds'].every(k => finite(x[k]));
  const base = { forecast_values_initialization_verified: false, same_run_comparison_permitted: false,
    provider_reported_initialization_utc: null, status: 'metadata_unavailable',
    caveat: 'Latest-model metadata cannot prove the initialization of each value in a rolling API series.' };
  if (!good(b) || !good(a)) return base;
  const now = parseUTC(receivedAt);
  if (a.last_run_initialisation_time * 1000 > now + 300000 ||
      a.last_run_availability_time * 1000 > now + 300000 ||
      a.update_interval_seconds <= 0 || a.temporal_resolution_seconds <= 0)
    return { ...base, status: 'invalid_or_future_metadata' };
  const fields = ['last_run_initialisation_time', 'last_run_availability_time', 'last_run_modification_time'];
  const stable = fields.every(k => a[k] === b[k]);
  const settled = now - a.last_run_availability_time * 1000 >= 600000;
  const runAge = (now - a.last_run_initialisation_time * 1000) / 1000;
  // Operational guard only: two nominal cycles plus 12 h for production latency.
  const stale = runAge > 2 * a.update_interval_seconds + 12 * 3600;
  return { ...base, status: !stable ? 'metadata_changed_during_fetch' : stale ? 'provider_metadata_stale' :
    !settled ? 'provider_update_still_propagating' : 'provider_metadata_stable_not_value_level_provenance',
    provider_reported_initialization_utc: iso(a.last_run_initialisation_time * 1000),
    provider_availability_utc: iso(a.last_run_availability_time * 1000),
    provider_modification_utc: iso(a.last_run_modification_time * 1000),
    native_temporal_resolution_seconds: a.temporal_resolution_seconds,
    nominal_update_interval_seconds: a.update_interval_seconds, run_age_hours: runAge / 3600,
    before_and_after_match: stable, availability_at_least_ten_minutes_old: settled,
    operational_stale_guard_hours: (2 * a.update_interval_seconds + 12 * 3600) / 3600 };
}
function valuesAt(v, index) { return v?.usable ? v.arrays.map(a => a[index]) : []; }
function expectedHours(start, end, ending) {
  const out = [];
  for (let t = start + (ending ? HOUR : 0); t < end + (ending ? HOUR : 0); t += HOUR) out.push(t);
  return out;
}
function period(v, validated, start, end, reduction, ending = false) {
  if (!v?.usable) return { ...stats([], validated.expected_members), start_utc: iso(start), end_utc: iso(end), unavailable: true };
  const indices = expectedHours(start, end, ending).map(t => validated.timestamps.indexOf(t));
  if (!indices.length || indices.some(i => i < 0)) return {
    ...stats([], validated.expected_members), start_utc: iso(start), end_utc: iso(end), incomplete_time_coverage: true };
  const memberValues = v.arrays.map(a => {
    const x = indices.map(i => a[i]);
    return x.every(finite) ? reduction(x) : null;
  });
  return { ...stats(memberValues, validated.expected_members), start_utc: iso(start), end_utc: iso(end),
    sample_count_per_member: indices.length, member_values: memberValues };
}
export function precipitationPeriod(validated, start, end, thresholdMm = 1) {
  const p = period(validated.variables.precipitation, validated, start, end,
    a => a.reduce((sum, x) => sum + x, 0), true);
  const vals = (p.member_values ?? []).filter(finite), exceed = vals.filter(x => x >= thresholdMm).length;
  delete p.member_values;
  return { ...p, units: 'mm liquid-water equivalent',
    timestamp_semantics: 'preceding-hour sums; interval is (start, end] on returned timestamps',
    threshold_mm: thresholdMm, members_at_or_above_threshold: vals.length ? exceed : null,
    raw_member_fraction: vals.length ? exceed / vals.length : null,
    calibrated_probability: false, chance_of_precipitation_nws: null };
}
function discardValues(p) { delete p.member_values; return p; }
export function summarizeRecord(record, now = Date.now(), variables = REQUIRED) {
  const v = validateRecord(record, variables);
  const received = record.received_at_utc ?? record.finished_at_utc;
  if (!received) throw new Error('Missing acquisition timestamp');
  const receivedMs = parseUTC(received);
  if (receivedMs > now + 300000) throw new Error('Acquisition timestamp is in the future');
  const metadata = assessMetadata(record.metadata_before, record.metadata_after, received);
  const today = localParts(now).date;
  const days = Array.from({ length: 3 }, (_, n) => {
    const date = addDate(today, n), next = addDate(date, 1);
    const high = discardValues(period(v.variables.temperature_2m, v, boundary(date, 6), boundary(date, 18), a => Math.max(...a)));
    const low = discardValues(period(v.variables.temperature_2m, v, boundary(date, 18), boundary(next, 6), a => Math.min(...a)));
    const conv = p => ({ ...p, p10: p.p10 === null ? null : cToF(p.p10),
      median: p.median === null ? null : cToF(p.median), p90: p.p90 === null ? null : cToF(p.p90) });
    return { date, timezone: ZONE, temperature_semantics: 'sampled daytime 06–18 maximum; following night 18–06 minimum, not official daily extrema',
      celsius: { sampled_daytime_high: high, following_night_low: low },
      fahrenheit: { sampled_daytime_high: conv(high), following_night_low: conv(low) },
      precipitation_24h: precipitationPeriod(v, boundary(date, 0), boundary(next, 0)),
      precipitation_6h: [0, 6, 12, 18].map(h => precipitationPeriod(v, boundary(date, h), h === 18 ? boundary(next, 0) : boundary(date, h + 6))),
      maximum_sampled_sustained_wind_ms: discardValues(period(v.variables.wind_speed_10m, v,
        boundary(date, 0), boundary(next, 0), a => Math.max(...a))) };
  });
  const hourly = v.timestamps.map((t, i) => ({ valid_utc: iso(t), local: localParts(t),
    temperature_c: stats(valuesAt(v.variables.temperature_2m, i), v.expected_members),
    wind_speed_ms: stats(valuesAt(v.variables.wind_speed_10m, i), v.expected_members),
    precipitation_previous_hour_mm: stats(valuesAt(v.variables.precipitation, i), v.expected_members)
  })).filter(x => parseUTC(x.valid_utc) >= Math.floor(now / HOUR) * HOUR && parseUTC(x.valid_utc) <= now + 84 * HOUR);
  const requiredEnd = boundary(addDate(today, 3), 6);
  const futureTimes = expectedHours(Math.ceil(now / HOUR) * HOUR, requiredEnd, false);
  const completeFuture = futureTimes.length > 0 && REQUIRED.every(variable => {
    const vv = v.variables[variable];
    return vv?.usable && futureTimes.every(t => {
      const i = v.timestamps.indexOf(t);
      return i >= 0 && vv.arrays.every(a => finite(a[i]));
    });
  });
  return { model: record.requested_model, name: MODELS[record.requested_model].name,
    delivery_provider: 'Open-Meteo', received_at_utc: received,
    requested_at_utc: record.requested_at_utc ?? null, source_url: record.url ?? null,
    source_sha256: record.response_sha256 ?? null,
    requested_target: TARGET, sampled_coordinates: v.sampled_coordinates, grid_distance_km: v.grid_distance_km,
    member_series: v.expected_members, upstream_member_roles: v.upstream_member_roles,
    model_identity_basis: v.model_identity_basis, returned_model_identity: v.returned_model_identity,
    coverage_start_utc: iso(v.timestamps[0]), coverage_end_utc: iso(v.timestamps.at(-1)),
    acquisition_age_minutes: (now - receivedMs) / 60000,
    expected_future_end_utc: iso(requiredEnd), complete_future_required_variables: completeFuture,
    variables: Object.fromEntries(Object.entries(v.variables).map(([k, x]) => [k, {
      status: !x.usable ? 'invalid_or_unavailable' : x.missing_values ? 'partial_values' : 'numerical_values_validated',
      missing_values: x.missing_values ?? null, problems: x.problems, units: UNITS[k] }])),
    metadata, problems: v.problems, days, hourly,
    interpretation: ['Model output, not observations or a replacement for NWS local forecasts/alerts.',
      'Different model grid points and unknown per-value initialization limit between-model attribution.',
      'Hourly API interpolation does not create native hourly skill.',
      'Temperature extrema are calculated per series first, then summarized across series.',
      'Precipitation is water equivalent including rain and snow; member fractions are not calibrated NWS PoP.'] };
}
export function summarizeCapture(capture, now = Date.now(), variables = REQUIRED) {
  if (!capture || !Array.isArray(capture.records)) throw new Error('Missing capture records');
  const seen = new Set();
  const models = capture.records.map(r => {
    if (seen.has(r.requested_model)) throw new Error('Duplicate model record in capture');
    seen.add(r.requested_model);
    try { return summarizeRecord(r, now, variables); }
    catch (error) { return { model: r.requested_model, received_at_utc: r.received_at_utc ?? null,
      error: error.message, complete_future_required_variables: false }; }
  });
  return { schema: SCHEMA, generated_at_utc: iso(now), source_capture_saved_at_utc: capture.saved_at_utc,
    target: TARGET, timezone: ZONE, models,
    same_run_comparison_permitted: false,
    note: 'Run metadata is a separate observation of provider status; per-value initialization remains unverified.' };
}
export function serveState(summary, now = Date.now(), maxAgeMinutes = 90) {
  const checks = Object.keys(MODELS).map(id => {
    const m = summary?.models?.find(x => x.model === id);
    const age = m?.received_at_utc ? (now - parseUTC(m.received_at_utc)) / 60000 : null;
    const blockedMeta = ['provider_metadata_stale', 'invalid_or_future_metadata',
      'metadata_changed_during_fetch', 'provider_update_still_propagating'].includes(m?.metadata?.status);
    const fresh = age !== null && age >= -5 && age <= maxAgeMinutes;
    return { model: id, fresh_acquisition: fresh, acquisition_age_minutes: age,
      complete_future_required_variables: Boolean(m?.complete_future_required_variables),
      provider_metadata_guard_passed: !blockedMeta,
      provider_metadata_status: m?.metadata?.status ?? 'unavailable',
      usable: Boolean(m && !m.error && fresh && !blockedMeta && m.complete_future_required_variables) };
  });
  return { checked_at_utc: iso(now), max_acquisition_age_minutes: maxAgeMinutes,
    ready: checks.every(c => c.usable), models: checks,
    per_value_initialization_verified: false, same_run_comparison_permitted: false };
}
export function textFeed(summary, readiness) {
  const f = v => v === null || v === undefined ? 'unavailable' : Number(v).toFixed(1);
  const lines = ['19107 ensemble supplement — not the official local forecast',
    `Checked: ${readiness.checked_at_utc}`,
    `Usability gate: ${readiness.ready ? 'PASS (acquisition/coverage only; run provenance unverified)' : 'NOT READY — do not treat this as a fresh complete comparison'}`,
    'All values are model forecasts via Open-Meteo. No current observations, alerts or calendar data.',
    'Different sampled grid points; no claim of verified same-run comparison.', ''];
  for (const m of summary?.models ?? []) {
    lines.push(m.name ?? m.model);
    if (m.error) { lines.push(`Unavailable: ${m.error}`, ''); continue; }
    lines.push(`Retrieved: ${m.received_at_utc}; grid ${m.sampled_coordinates.latitude}, ${m.sampled_coordinates.longitude}; distance ${f(m.grid_distance_km)} km`,
      `Provider metadata: ${m.metadata.status}; reported latest initialization: ${m.metadata.provider_reported_initialization_utc ?? 'unknown'}`,
      'Extrema below are sampled 06–18 high and following 18–06 low, median across member-series; not official daily extrema.');
    for (const d of m.days) {
      const c = d.celsius, fa = d.fahrenheit;
      lines.push(`${d.date} — Celsius: high ${f(c.sampled_daytime_high.median)}°C, nighttime low ${f(c.following_night_low.median)}°C | Fahrenheit: high ${f(fa.sampled_daytime_high.median)}°F, nighttime low ${f(fa.following_night_low.median)}°F`);
      const p = d.precipitation_24h;
      lines.push(`Precipitation water-equivalent median ${f(p.median)} mm; >=${p.threshold_mm} mm: ${p.members_at_or_above_threshold ?? 'unavailable'}/${p.n} valid member-series (expected ${p.expected_n}); raw fraction, not NWS rain probability.`);
    }
    lines.push('');
  }
  lines.push('Attribution: Open-Meteo; requested upstream models ECMWF IFS ENS and ECCC GEPS. Data: CC BY 4.0.',
    'Use /latest.json for hourly windows and uncertainty; /capture.json for raw numerical evidence.');
  return lines.join('\n');
}

/** Acquisition occurs in this internet-capable Node service, never in the report writer. */
import { createHash } from 'node:crypto';
import { MODELS, TARGET, REQUIRED, iso, validateRecord } from './core.mjs';
export const FORECAST_ORIGIN = 'https://ensemble-api.open-meteo.com';
export const META_ORIGIN = 'https://api.open-meteo.com';
export function forecastURL(model, { variables = REQUIRED, probe = false } = {}) {
  if (!MODELS[model]) throw new Error('Unknown named ensemble');
  const url = new URL('/v1/ensemble', FORECAST_ORIGIN);
  const query = { latitude: String(TARGET.latitude), longitude: String(TARGET.longitude),
    models: model, hourly: variables.join(','), timezone: 'UTC', temperature_unit: 'celsius',
    wind_speed_unit: 'ms', precipitation_unit: 'mm', cell_selection: 'nearest', elevation: 'nan' };
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  if (probe) url.searchParams.set('forecast_hours', '6');
  else { url.searchParams.set('past_days', '1'); url.searchParams.set('forecast_days', '4'); }
  return url.toString();
}
export const metadataURL = model => {
  if (!MODELS[model]) throw new Error('Unknown metadata model');
  return `${META_ORIGIN}/data/${model}/static/meta.json`;
};
export function retryDelay(headers, now, fallbackMs) {
  const raw = headers.get('retry-after');
  if (!raw) return fallbackMs;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - now) : fallbackMs;
}
export async function requestJSON(url, options = {}) {
  const { fetchImpl = globalThis.fetch, clock = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    timeoutMs = 20000, maxBytes = 8 * 1024 * 1024, attempts = 2, maxRetryWaitMs = 10000 } = options;
  const u = new URL(url);
  if (!['https:'].includes(u.protocol) || ![new URL(FORECAST_ORIGIN).hostname, new URL(META_ORIGIN).hostname].includes(u.hostname))
    throw new Error('Collector only calls the two fixed approved Open-Meteo hosts');
  const audits = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = clock(), audit = { attempt, requested_at_utc: iso(started), url };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Acquisition timeout')), timeoutMs);
    let retryMs = null;
    try {
      const res = await fetchImpl(url, { signal: controller.signal, redirect: 'error',
        headers: { Accept: 'application/json', 'User-Agent': 'Philly-Ensemble-Collector/1.0 (personal non-commercial weather reader)' } });
      audit.http_status = res.status;
      audit.response_headers = Object.fromEntries(['content-type', 'date', 'etag', 'last-modified', 'retry-after']
        .map(k => [k, res.headers.get(k)]));
      if (!res.ok) {
        audit.error = `HTTP ${res.status}`;
        if ([429, 500, 502, 503, 504].includes(res.status)) retryMs = retryDelay(res.headers, clock(), 1000 * attempt);
        // Do not retain arbitrary upstream error bodies or execute anything from them.
        try { await res.body?.cancel(); } catch {}
      } else {
        if (!/application\/(?:[\w.+-]*\+)?json/i.test(res.headers.get('content-type') ?? '')) throw new Error('Successful HTTP response is not JSON');
        const declared = Number(res.headers.get('content-length'));
        if (declared > maxBytes) throw new Error('Response exceeds download limit');
        const reader = res.body?.getReader();
        if (!reader) throw new Error('Empty response body');
        const chunks = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > maxBytes) { await reader.cancel(); throw new Error('Response exceeds download limit'); }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        const bytes = Buffer.concat(chunks);
        let raw;
        try { raw = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Malformed JSON'); }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.error) throw new Error('API error or unexpected JSON payload');
        audit.received_at_utc = iso(clock());
        audit.byte_length = size;
        audit.response_sha256 = createHash('sha256').update(bytes).digest('hex');
        audit.status = 'json_received'; audits.push(audit);
        return { ...audit, raw_response: raw, attempts: audits };
      }
    } catch (error) {
      audit.error = String(error?.cause?.code ?? error?.code ?? error?.message ?? error).slice(0, 200);
      // Transport failures get a bounded retry, not an uncontrolled hostname sweep.
      if (!/JSON|download limit|unexpected|API error/i.test(audit.error)) retryMs = 1000 * attempt;
    } finally { clearTimeout(timer); }
    audit.received_at_utc = iso(clock()); audit.status = 'access_failed';
    if (retryMs !== null && retryMs > maxRetryWaitMs)
      audit.do_not_retry_before_utc = iso(clock() + retryMs);
    audits.push(audit);
    if (attempt === attempts || retryMs === null || retryMs > maxRetryWaitMs) break;
    await sleep(retryMs);
  }
  return { ...audits.at(-1), attempts: audits };
}
export async function collectModel(model, options = {}) {
  const variables = options.variables ?? REQUIRED;
  const url = forecastURL(model, { variables, probe: options.probe });
  const metadata_before = await requestJSON(metadataURL(model), { ...options, attempts: 1, maxBytes: 128 * 1024 });
  const payload = await requestJSON(url, options);
  // Skip another request after a forecast failure; it cannot establish value-level success.
  const metadata_after = payload.raw_response ? await requestJSON(metadataURL(model), {
    ...options, attempts: 1, maxBytes: 128 * 1024 }) : { status: 'not_attempted_after_forecast_failure' };
  const result = { requested_model: model, requested_coordinates: [TARGET.latitude, TARGET.longitude],
    delivery_provider: 'Open-Meteo', model_initialization: null,
    ...payload, metadata_before, metadata_after };
  if (payload.raw_response) {
    try {
      const v = validateRecord(result, variables);
      result.numeric_validation = { validated_variables: Object.fromEntries(Object.entries(v.variables)
        .map(([k, x]) => [k, { usable: x.usable, missing_values: x.missing_values ?? null, problems: x.problems }])),
        member_series: v.expected_members, grid_distance_km: v.grid_distance_km,
        returned_coordinates: v.sampled_coordinates, problems: v.problems,
        model_initialization: null, same_run_comparison_permitted: false };
      result.status = v.problems.length ? 'partial_or_invalid_numerical_response' : 'numerical_values_received_initialization_unverified';
    } catch (error) { result.status = 'invalid_numerical_response'; result.validation_error = error.message; }
  }
  return result;
}
export async function collect(options = {}) {
  const clock = options.clock ?? Date.now;
  const started = iso(clock()), records = [];
  // Serial model collection avoids bursty member requests. Neither upstream counts as a third provider vote.
  for (const model of Object.keys(MODELS)) records.push(await collectModel(model, options));
  return { capture_schema: 'philly-ensemble-collector-v1', started_at_utc: started,
    saved_at_utc: iso(clock()), execution_location: 'standalone_node_service',
    scope: options.probe ? 'Six-hour connectivity probe, not a briefing' :
      'Three-day plus following-night temperature, water-equivalent precipitation and sustained wind; rolling-run provenance unverified',
    records };
}

/** Precision-bounded adjustment, not recovery of the unknowable unrounded forecast. */
export const PRECIPITATION_POLICY = 'ecmwf-packing-v1';
export const ECMWF_MODEL = 'ecmwf_ifs025_ensemble';
const HOUR = 3600000, EPS = 1e-9;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const utc = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?$/.test(s) ? Date.parse(s.endsWith('Z') ? s : s + 'Z') : NaN;
const key = id => id === 0 ? 'precipitation' : `precipitation_member${String(id).padStart(2, '0')}`;
const same = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= EPS;
export const roundTenth = x => Math.sign(x) * Math.round(Math.abs(x) * 10) / 10;
const lon = x => ((x + 180) % 360 + 360) % 360 - 180;

export function inspectNative(record) {
  const n = record.precipitation_quality?.native;
  const a = record.raw_response, b = n?.raw_response;
  if (record.requested_model !== ECMWF_MODEL || !n) return { status: 'not_checked', intervals: [] };
  const fail = reason => ({ status: 'unavailable', reason, intervals: [] });
  if (n.http_status !== 200 || !b?.hourly || !b.hourly_units) return fail('native_response_unavailable');
  if (!same(a?.latitude, b.latitude) || !same(a?.longitude, b.longitude) || b.utc_offset_seconds !== 0 ||
      !['UTC', 'GMT', 'Etc/UTC'].includes(b.timezone) || b.hourly_units.time !== 'iso8601') return fail('native_identity_or_units_mismatch');
  const echoed = b.model ?? b.models;
  if (echoed !== undefined && echoed !== null && echoed !== ECMWF_MODEL &&
      !(Array.isArray(echoed) && echoed.length === 1 && echoed[0] === ECMWF_MODEL)) return fail('native_model_mismatch');
  const t = b.hourly.time?.map(utc);
  if (!t?.length || t.some((v, i) => !finite(v) || v % (3 * HOUR) !== 0 || (i && v - t[i - 1] !== 3 * HOUR))) return fail('native_time_axis_invalid');
  const keys = Object.keys(b.hourly).filter(k => k === 'precipitation' || k.startsWith('precipitation_member'));
  if (keys.length !== 51 || Array.from({ length: 51 }, (_, id) => key(id)).some(k => !keys.includes(k))) return fail('native_member_set_invalid');
  const intervals = [];
  for (let id = 0; id < 51; id++) {
    const k = key(id), values = b.hourly[k];
    if (b.hourly_units[k] !== 'mm' || !Array.isArray(values) || values.length !== t.length) return fail('native_shape_or_units_invalid');
    for (let i = 0; i < t.length; i++) if (finite(values[i]) && values[i] < 0)
      intervals.push({ member_id: id, valid_utc: new Date(t[i]).toISOString(), native_mm: values[i] });
  }
  return { status: 'checked', intervals };
}

function stableRun(record) {
  const b = record.metadata_before?.raw_response, a = record.metadata_after?.raw_response;
  if (!b || !a || ['last_run_initialisation_time', 'last_run_availability_time', 'last_run_modification_time']
    .some(k => !finite(a[k]) || a[k] !== b[k]) || a.temporal_resolution_seconds !== 10800) return null;
  const received = utc(record.precipitation_quality?.native?.received_at_utc);
  const run = a.last_run_initialisation_time * 1000;
  if (!finite(received) || received - a.last_run_availability_time * 1000 < 600000 ||
      run > received || !finite(a.update_interval_seconds) || a.update_interval_seconds <= 0 ||
      received - run > (2 * a.update_interval_seconds + 43200) * 1000) return null;
  return run;
}

export function verifyPrecision(record, interval, proof) {
  const reject = reason => ({ accepted: false, reason });
  const run = stableRun(record), end = utc(interval.valid_utc);
  if (run === null || !proof || proof.member_id !== interval.member_id || utc(proof.valid_utc) !== end)
    return reject('missing_matching_precision_evidence');
  const evidence = record.precipitation_quality;
  if (evidence.policy !== PRECIPITATION_POLICY) return reject('unknown_precision_policy');
  const init = new Date(run);
  if (![0, 6, 12, 18].includes(init.getUTCHours()) || init.getUTCMinutes() || init.getUTCSeconds() || init.getUTCMilliseconds())
    return reject('unsupported_initialization');
  if (evidence.source_response_sha256 !== record.response_sha256 ||
      evidence.native_response_sha256 !== evidence.native?.response_sha256 ||
      !/^[0-9a-f]{64}$/.test(evidence.source_response_sha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(evidence.native_response_sha256 ?? '')) return reject('evidence_not_bound_to_response');
  const step = (end - run) / HOUR;
  if (!Number.isInteger(step) || step < 6 || step > 144 || step % 3 !== 0) return reject('unsupported_run_or_interval');
  const samples = [proof.previous, proof.current];
  for (let i = 0; i < 2; i++) {
    const p = samples[i], expectedStep = step - (i === 0 ? 3 : 0);
    const stamp = new Date(run).toISOString().replaceAll(/[-:]/g, '').slice(0, 11).replace('T', '');
    const date = stamp.slice(0, 8), hour = stamp.slice(8, 10);
    const expectedURL = `https://storage.googleapis.com/ecmwf-open-data/${date}/${hour}z/ifs/0p25/enfo/${date}${hour}0000-${expectedStep}h-enfo-ef.grib2`;
    if (!p || p.source_url !== expectedURL || p.paramId !== 228 || p.units !== 'm' || p.shortName !== 'tp' || p.startStep !== 0 ||
        p.endStep !== expectedStep || p.member_id !== interval.member_id || utc(p.initialization_utc) !== run ||
        utc(p.valid_utc) !== run + expectedStep * HOUR || p.gridType !== 'regular_ll' ||
        !same(p.grid_spacing_degrees, 0.25) || !same(p.latitude, record.raw_response.latitude) ||
        !same(lon(p.longitude), lon(record.raw_response.longitude)) || !['grid_ccsds', 'grid_simple'].includes(p.packingType) ||
        !Number.isInteger(p.bitsPerValue) || p.bitsPerValue < 1 || p.bitsPerValue > 32 ||
        !finite(p.accumulation_mm) || p.accumulation_mm < 0 || !finite(p.packing_error_mm) || p.packing_error_mm <= 0 ||
        !Number.isInteger(p.binaryScaleFactor) || !Number.isInteger(p.decimalScaleFactor) ||
        !/^[0-9a-f]{64}$/.test(p.sha256 ?? '')) return reject('grib_identity_or_precision_invalid');
    // ecCodes packingError can include rounding of the reference value. Refuse grossly inflated metadata.
    const halfStep = 1000 * 2 ** p.binaryScaleFactor * 10 ** (-p.decimalScaleFactor) / 2;
    if (!finite(halfStep) || halfStep <= 0 || Math.abs(p.packing_error_mm - halfStep) > Math.max(EPS, halfStep * 1e-5))
      return reject('unsupported_packing_error');
  }
  const delta = proof.current.accumulation_mm - proof.previous.accumulation_mm;
  const bound = proof.previous.packing_error_mm + proof.current.packing_error_mm;
  if (!(delta < 0) || -delta > bound + EPS) return reject('negative_exceeds_measured_precision');
  // 1 mm is the existing report's occurrence threshold, NOT a guessed correction cutoff.
  // An encoding uncertainty as large as that threshold is not acceptable for this product.
  if (bound >= 1) return reject('precision_insufficient_for_one_mm_product');
  if (!same(roundTenth(delta), interval.native_mm)) return reject('native_amount_not_reproduced');
  return { accepted: true, reason: 'source_reproduced_precision_consistent_adjustment',
    native_delta_mm: delta, precision_bound_mm: bound,
    native_possible_nonnegative_upper_mm: Math.max(0, delta + bound),
    initialization_candidate_utc: new Date(run).toISOString(),
    per_value_initialization_verified: false, exact_zero_proven: false };
}

export function precipitationOverrides(record, timestamps) {
  const check = inspectNative(record), overrides = new Map(), corrections = [], rejected = [];
  const evidence = record.precipitation_quality;
  const index = new Map(timestamps.map((t, i) => [t, i]));
  for (const interval of check.intervals) {
    const end = utc(interval.valid_utc), indices = [-2, -1, 0].map(h => index.get(end + h * HOUR));
    const overlapping = indices.filter(Number.isInteger);
    if (!overlapping.length) continue;
    const a = record.raw_response.hourly[key(interval.member_id)];
    const matches = indices.every(i => Number.isInteger(i) && same(a?.[i], roundTenth(interval.native_mm / 3)));
    const proofs = (evidence?.proofs?.intervals ?? []).filter(p => p.member_id === interval.member_id && utc(p.valid_utc) === end);
    const decision = matches && proofs.length === 1 ? verifyPrecision(record, interval, proofs[0]) :
      { accepted: false, reason: matches ? 'missing_unique_precision_evidence' : 'hourly_native_amounts_disagree_or_incomplete' };
    const entry = { ...interval, ...decision, hourly_indices: overlapping };
    if (decision.accepted) {
      for (const i of indices) overrides.set(`${interval.member_id}:${i}`, 0);
      corrections.push({ ...entry, corrected_native_mm: 0, corrected_hourly_mm: [0, 0, 0],
        original_hourly_mm: indices.map(i => a[i]),
        hourly_adjustment_mm: -indices.reduce((s, i) => s + a[i], 0) });
    } else {
      for (const i of overlapping) overrides.set(`${interval.member_id}:${i}`, null);
      rejected.push(entry);
    }
  }
  return { overrides, corrections, rejected, policy: PRECIPITATION_POLICY,
    native_check_status: check.status, native_check_reason: check.reason ?? null,
    native_negative_intervals: check.intervals.length,
    adjusted_intervals: corrections.length,
    adjusted_negative_hourly_cells: corrections.reduce((n, x) => n + x.original_hourly_mm.filter(v => v < 0).length, 0),
    unverified_native_intervals: rejected.length,
    max_precision_bound_mm: corrections.length ? Math.max(...corrections.map(x => x.precision_bound_mm)) : null,
    interpretation: 'Zeros are documented nonnegative adjustments, not proof of exact dry weather. Positive amounts are not corrected. Formal per-value initialization remains unverified.' };
}

/** Collection age and source usability are different questions. No network or writes. */
export const POLICY_VERSION = 'source-use-v1';
export const MAX_ACQUISITION_AGE_MINUTES = 90;
export const ACQUISITION_NOTICE = 'The acquisition deadline is not a forecast-validity deadline. After it, review each source and requested forecast window for explicitly dated fallback use.';
const minute = 60000;
function time(value) {
  if (typeof value !== 'string' || !/(Z|\+00:00)$/.test(value)) return NaN;
  return Date.parse(value);
}
export function acquisitionAge(received, now = Date.now()) {
  const stamp = time(received);
  if (!Number.isFinite(stamp) || stamp > now + 5 * minute)
    return { state: 'unverified', age_minutes: null, acquisition_fresh_until_utc: null };
  const age = (now - stamp) / minute;
  return { state: age <= MAX_ACQUISITION_AGE_MINUTES ? 'fresh' : 'dated',
    age_minutes: age,
    acquisition_fresh_until_utc: new Date(stamp + MAX_ACQUISITION_AGE_MINUTES * minute).toISOString() };
}
/**
 * Inputs describe checks the caller ACTUALLY performed, not provider success flags.
 * This function does not itself validate arrays, polygons, observations, or provenance.
 * request is the exact claim/outing interval; forecast expiry is never inferred from age.
 */
export function assessSourceUse(source, request, now = Date.now()) {
  const age = acquisitionAge(source?.received_at_utc, now);
  const result = (state, reason, allowed = false) => ({ policy_version: POLICY_VERSION,
    source_id: source?.id ?? null, collection: age, use_state: state,
    allowed_for_requested_claim: allowed, reason, same_run_comparison_permitted: false });
  if (source?.test_only === true) return result('unusable', 'Test evidence is never live evidence.');
  if (source?.validation !== 'passed' || source?.identity_verified !== true)
    return result('unusable', 'Source identity/content validation did not pass.');
  if (age.state === 'unverified') return result('unusable', 'Collection time is unverified.');
  if (source.kind === 'current_alerts') {
    const t = time(source.rechecked_at_utc);
    if (source.live_recheck_succeeded !== true || !Number.isFinite(t) ||
        t > now + minute || now - t > 15 * minute)
      return result('unverified_current', 'A successful recent live alert check is required; cached empty alerts are not an all-clear.');
    return result('current_check', 'Live alert check passed; individual alert geography and validity still apply.', true);
  }
  if (source.kind === 'current_observation') {
    const t = time(source.observed_at_utc);
    if (!Number.isFinite(t) || t > now + minute)
      return result('unverified_current', 'An actual observation time is required.');
    const limit = source.max_observation_age_minutes;
    if (!Number.isFinite(limit) || limit <= 0 || limit > 180)
      return result('unverified_current', 'Declare a source-appropriate observation age limit, no greater than three hours.');
    if (now - t > limit * minute)
      return result('historical_only', 'Observation is too old for the requested current-condition claim.');
    return result('current_observation', 'Observation meets the declared age check; retain its actual time and reporting area.', true);
  }
  if (!['model_forecast', 'official_forecast', 'daily_air_forecast', 'outlook'].includes(source.kind))
    return result('unusable', 'Unknown source meaning; no automatic substitution.');
  const start = time(request?.start_utc), end = time(request?.end_utc);
  const first = time(source.valid_start_utc), last = time(source.valid_end_utc);
  if (![start, end, first, last].every(Number.isFinite) || end <= start || end <= now ||
      start < first || end > last || source.requested_window_complete !== true)
    return result('unusable', 'The exact requested future interval is invalid, incomplete, or outside this source coverage.');
  if (source.materially_superseded === true)
    return result('historical_only', 'Newer verified evidence materially supersedes this forecast for this claim.');
  // A future outlook may support its future valid period, never a current-alert claim.
  if (age.state === 'fresh' && source.own_source_time_checked === true)
    return result('fresh_collection', 'Recently collected; source issue/validity and requested content were separately checked.', true);
  const review = source.dated_review;
  const checked = time(review?.checked_at_utc);
  if (review?.accepted !== true || typeof review.reason !== 'string' || !review.reason.trim() ||
      !Array.isArray(review.evidence_refs) || !review.evidence_refs.length ||
      !review.evidence_refs.every(x => typeof x === 'string' && x.trim()) ||
      !Number.isFinite(checked) || checked > now + minute || now - checked > 15 * minute)
    return result('review_required', 'Not automatically discarded: review issue/validity, newer evidence, and this claim; record a reason and references.');
  if (source.own_source_time_checked !== true)
    return result('review_required', 'Source issue/validity has not been independently checked.');
  return result('dated_fallback', review.reason, true);
}
/** A private report receipt, never a public collector output. */
export function makeConsumptionReceipt({ run, artifact, items, delivery, checked_at_utc }) {
  if (!Number.isFinite(time(checked_at_utc))) throw new Error('Receipt requires an actual UTC check time');
  if (!run?.id || !run?.head_sha || !artifact?.id || !artifact?.sha256)
    throw new Error('Receipt requires actual run, commit, artifact and archive hash');
  if (!['manual', 'scheduled'].includes(delivery?.execution_kind) ||
      !Number.isFinite(time(delivery.executed_at_utc))) throw new Error('Actual execution kind/time required');
  if (delivery.execution_kind === 'scheduled' && !Number.isFinite(time(delivery.scheduled_slot_utc)))
    throw new Error('A scheduled receipt must identify its actual scheduled slot');
  if (!Array.isArray(items) || !items.length) throw new Error('Source-level decisions required');
  for (const item of items) {
    if (!item.id || typeof item.collected !== 'boolean' || typeof item.validated !== 'boolean' ||
        typeof item.used !== 'boolean' || typeof item.reason !== 'string' || !item.reason.trim())
      throw new Error('Each source needs collected/validated/used flags and a reason');
    if (item.used && (!item.collected || !item.validated || !Array.isArray(item.claim_refs) || !item.claim_refs.length))
      throw new Error('Used evidence must be validated and linked to actual claims');
  }
  return { schema: 'private-briefing-consumption-v1', checked_at_utc, run, artifact, items, delivery,
    collected_is_not_used: true,
    scheduled_consumption_recorded: delivery.execution_kind === 'scheduled',
    // Execution start is not delivery. Only the delivery platform can verify delivery time.
    on_time_delivery_verified: false,
    destination: 'private conversation evidence only; never publish to the repository or public artifacts' };
}

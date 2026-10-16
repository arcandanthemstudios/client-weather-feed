/** Producer receipt only. Report consumption must be recorded by the actual private report. */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const dateOK = value => typeof value === 'string' && /Z$/.test(value) && Number.isFinite(Date.parse(value));
export function makeCollectionReceipt(files, env, now = new Date().toISOString(), { testOnly = false } = {}) {
  const capture = JSON.parse(files['capture.json']);
  const feed = JSON.parse(files['validated.json']);
  if (!dateOK(now) || !dateOK(capture.saved_at_utc) || !dateOK(feed.generated_at_utc) ||
      capture.capture_schema !== 'philly-ensemble-collector-v1' || feed.schema !== 'philly-ensemble-pages-v1' ||
      feed.test_only !== false || capture.test_only === true ||
      feed.summary?.source_capture_saved_at_utc !== capture.saved_at_utc ||
      Math.abs(Date.parse(capture.saved_at_utc) - Date.parse(feed.generated_at_utc)) > 300000)
    throw new Error('Producer receipt requires matching non-test capture and validated summary');
  if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
      !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') || !env.GITHUB_EVENT_NAME)
    throw new Error('Actual workflow run, attempt, commit and event are required');
  const records = capture.records ?? [];
  const items = records.map(record => {
    const model = feed.summary.models?.find(m => m.model === record.requested_model);
    return { id: record.requested_model, collected: record.http_status === 200 && !!record.raw_response,
      validated_at_collection: !!model && !model.error && model.complete_future_required_variables === true,
      received_at_utc: record.received_at_utc ?? null,
      used_in_report: null, use_reason: 'Only the report consumer can record actual use.' };
  });
  let supplementStatus = 'missing';
  if (files['supplement.json']) {
    try {
      const supplement = JSON.parse(files['supplement.json']);
      const match = supplement.schema === 'client-weather-supplement-v1' && supplement.test_only === false &&
        supplement.base_capture_saved_at_utc === capture.saved_at_utc && Array.isArray(supplement.sources);
      supplementStatus = match ? 'matching_capture' : 'mismatched_or_invalid';
      if (match) for (const source of supplement.sources) items.push({ id: source.id,
        collected: source.http_status === 200 && source.raw !== null && (source.raw !== undefined || source.data !== undefined),
        validation_status_at_collection: source.status ?? 'unverified',
        received_at_utc: source.received_at_utc ?? null, used_in_report: null,
        use_reason: 'Source issue, validity, content and actual report use require consumer checks.' });
    } catch { supplementStatus = 'malformed'; }
  }
  return { schema: 'collector-producer-receipt-v1', test_only: testOnly,
    generated_at_utc: now, run_id: env.GITHUB_RUN_ID, run_attempt: env.GITHUB_RUN_ATTEMPT,
    head_sha: env.GITHUB_SHA, event: env.GITHUB_EVENT_NAME,
    intended_report_slot_utc: dateOK(env.COLLECTOR_SLOT_UTC) ? env.COLLECTOR_SLOT_UTC : null,
    capture_saved_at_utc: capture.saved_at_utc, build_at_utc: feed.generated_at_utc,
    acquisition_fresh_until_utc: feed.acquisition_fresh_until_utc ?? feed.expires_at_utc ?? null,
    expiry_semantics: 'acquisition_age_only_not_forecast_validity',
    files: Object.entries(files).map(([name, value]) => ({ name, sha256: hash(value), byte_length: Buffer.byteLength(value) })),
    supplement_status: supplementStatus, items, artifact_id: null,
    artifact_id_note: 'Assigned by GitHub after upload; read actual artifact metadata.',
    report_consumption_verified: false, scheduled_report_verified: false,
    note: 'This receipt proves only recorded collection/build provenance, not a delivered forecast or current warning status.' };
}
async function main() {
  const files = {};
  for (const name of ['capture.json', 'validated.json', 'supplement.json']) {
    try { files[name] = await fs.readFile(resolve('_evidence', name), 'utf8'); }
    catch (error) { if (name !== 'supplement.json' || error.code !== 'ENOENT') throw error; }
  }
  const receipt = makeCollectionReceipt(files, process.env);
  await fs.writeFile('_evidence/collection-receipt.json', JSON.stringify(receipt));
  console.log(JSON.stringify({ schema: receipt.schema, run_id: receipt.run_id, run_attempt: receipt.run_attempt,
    build_at_utc: receipt.build_at_utc, supplement_status: receipt.supplement_status, report_consumption_verified: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

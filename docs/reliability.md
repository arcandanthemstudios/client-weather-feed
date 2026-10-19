# Collection deadlines and source use

A successful collection is not a successful report. A recently fetched source is not necessarily a current source. A dated forecast is not necessarily unusable.

## Active collection schedule

Effective with the October 19, 2026 schedule change, the native GitHub workflow uses `0 2,9,16 * * *` with `timezone: America/New_York`. This replaces the previous 05:35, 11:35 and 17:35 native schedule. The identical `WORKFLOW.yml` reference copy must stay aligned with `.github/workflows/weather.yml`.

| Intended collector start, Eastern | Associated report/check slot, Eastern | Planned lead time |
| --- | --- | --- |
| 02:00 | 06:00 | 4 hours |
| 09:00 | 12:00 | 3 hours |
| 16:00 | 18:00 | 2 hours |

This is a change to the existing collector's native schedule, not activation of another host or checker. The separate report/check schedules, delivery conditions, notification settings, permissions and privacy rules remain unchanged. A schedule entry is an intended start, not proof of actual execution, publication or report consumption. Inspect actual run history and artifact timestamps. Do not infer a missed collection solely because its acquisition age exceeds 90 minutes, and do not continue expecting the old :35 native starts.

A collection that starts on time can be acquisition-aged by its associated report. The 90-minute acquisition label is unchanged and is not the forecast's useful lifetime. Review covered forecast periods, source updates, completeness and newer evidence at report time; record accepted dated use and its reason. Freshly recheck alerts and current observations/air quality. Neither an early collection nor an earlier empty alert response establishes current conditions or an all-clear.

GitHub may delay or drop scheduled starts, especially near the start of an hour. Extra lead time is a buffer, not a punctuality guarantee. GitHub's documented spring-forward behavior advances a schedule in a skipped local hour to the next valid time; the 02:00 slot therefore moves to 03:00 on that transition day. Keep the IANA timezone rather than treating these hours as fixed UTC offsets.

## Independent starter and checker, optional and not activated here

`ops/watchdog.py` is a bounded external starter/checker, not another weather-report task. It is inactive until deployed to a connected external host with a securely configured token. `ops/render-watchdog.yaml` is a deployment template, not a claim that an external service exists. Neither is required for the native schedule above. The earlier free Apps Script/cron setup package is also not evidence of an active external service. Review any optional recovery design against the active schedule before activation; do not create extra executions or notifications from a report.

The existing optional design uses local 05:15, 11:15 and 17:15 America/New_York to inspect the existing collection and start the configured workflow on main only when necessary. At :35, it recovers a missed/failed start once, without duplicating a visible active run. At :50, it verifies actual artifacts and records missing/partial results without another start. These are prepared checker windows, not the active native collector starts. Report slots remain 06:00, 12:00 and 18:00. If this separate path is later activated, its automatic runs may overlap native runs; workflow concurrency serializes execution, not exactly-once delivery.

The Render template lists both possible UTC offsets. The script uses zoneinfo to execute only the relevant Eastern local-time window, and performs no API calls in the other offset's window. It never replays an elapsed window. The external service remains dependent on GitHub runners and upstream weather services. Neither schedule nor dispatch acceptance guarantees a deadline.

Use one external cron service only if separately activated. Configure GITHUB_ACTIONS_TOKEN in the hosting secret interface, never chat, repository files, generated artifacts, or logs. A fine-grained token should select only this repository with Actions write and Contents read (for the main ref); do not grant account-wide administration. Renew an expiring token through the secret interface. The existing ChatGPT connection's credentials are not exportable by this program.

The checker verifies run path, branch, head, artifact identity/digest, bounded ZIP paths/size, actual 51/21 member arrays, units, UTC coverage, target/grid support and receipts. Green CI and an accepted dispatch are insufficient. It records optional-source status separately. NWS source freshness, live alerts, observations and final claim-specific use still belong to the report consumer. Producer-ready is never all-sources-ready.

No user notifications are sent by the checker. Structured JSON state in each external execution log is the result; process exit success alone is not readiness. No calendar, report body, private addresses, credentials or personal history enter those logs. Do not configure extra email or webhook notifications while activating it. The :50 result is a checkpoint, not proof of the final :00 outcome.

## Two decisions, not one expiry

`acquisition_fresh_until_utc` is 90 minutes after the oldest relevant model receipt. `expires_at_utc` is retained as a compatibility alias with `expiry_semantics=acquisition_age_only_not_forecast_validity`. The limit is unchanged; its meaning is explicit. `eligibleNow` answers only eligibility as a fresh complete collection.

`src/freshness-policy.mjs` provides claim-specific decisions from actually validated inputs. It does not itself replace the raw-data validator. After the collection window closes, review actual source issue/observation and valid times, exact requested-period completeness, newer evidence and material changes. Record a specific reason and evidence for accepting dated fallback. Do not silently relabel it fresh, pool unequal models, or assert same-initialization provenance. Unknown per-value initialization does not forbid a labeled same-valid-period comparison.

Old observations cannot become current readings. Cached empty alerts cannot become an all-clear; a successful live official alert check and applicable geography/validity are required. A daily air forecast cannot become an hourly measured AQI. A future outlook may support only its actual future valid interval, not a present warning. Invalid, test-only, materially superseded or out-of-window evidence stays unusable for that claim. A missing optional field does not erase other valid evidence.

## Collection versus report receipts

`collection-receipt.json` joins the three evidence files in the workflow artifact. It records the actual run/attempt/commit, build, file hashes and collection/validation states. GitHub assigns artifact IDs after upload; consumers join actual artifact metadata. Producer receipts deliberately leave report use unknown and scheduled consumption unverified.

Every actual report must keep a private consumption receipt with run/attempt/commit/artifact ID and archive hash, source issue/valid/observation/receipt times, and per-source collected/validated/used flags. Used sources must identify the actual claim or table they supported. Rejected sources need a specific reason. Record the intended report slot separately from actual execution and completion. Execution start does not establish delivery time. Never upload these report receipts, calendars or personal context into this repository or its public artifacts.

## Acceptance evidence

Run `npm test` and `python3 -m unittest discover -s ops -p 'test_*.py' -v`.

The added tests simulate a missed start, partial base failure, optional failure, duplicate active run, exhausted retry budget, elapsed windows, DST, unsafe archives and false readiness. They do not skip production safety checks or overwrite live data with fixtures. A captured real artifact may additionally be checked locally with an explicitly historical as-of time; this proves decoding of that artifact, not current weather or an unattended schedule. Schedule regression tests check the early native cron, Eastern timezone, identical reference copy and retention of validation/receipt steps; they do not establish future punctuality.

Acceptance of the new native timing requires actual scheduled run and artifact timestamps, then a real report recording the exact artifact and fields it used. The optional external-recovery milestones remain separate: deployed service execution and controlled missed-start/partial-source recovery through that path. A manual success, changed prompt, passing test, uploaded artifact or green build alone does not establish scheduled delivery or external activation. Until those events are observed, label the corresponding acceptance checks pending.

Primary platform documentation:
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule
- https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
- https://render.com/docs/cronjobs
- https://render.com/docs/blueprint-spec

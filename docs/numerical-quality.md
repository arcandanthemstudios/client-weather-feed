# Numerical defects, usable windows and bounded recovery

The base collector preserves every raw response. It never replaces negative precipitation with zero, coerces strings to numbers, removes a model member from the expected ensemble, or combines values from different acquisitions.

## Validation and output

Identity, location, units, member IDs, time-axis and array-shape checks remain mandatory. Structural failures still reject the affected field or record. For structurally valid fields, invalid numerical cells are recorded with member ID, index, UTC validity timestamp, original value and reason in the retained evidence artifact, separate from public Pages. Repository artifact access rules still apply; this is not a private storage guarantee. Analysis uses a separate copied array with those cells marked unavailable. Null input remains missing, distinct from rejected values. Raw responses and their hashes are unchanged.

The legacy `usable` flag remains a strict whole-field validation result. `window_usable` indicates structural eligibility only: consumers must still check every member and time in the requested interval. Never interpret `window_usable` as complete numerical validation.

Hourly and period summaries preserve all expected member positions. Each period is aggregated within each member before ensemble statistics. An unaffected period can still contain all 51 or 21 members even if another period contains rejected data. An affected period reports the valid count, expected count and incomplete member IDs, but its median, percentiles and precipitation threshold fraction are null. There is no reduced-ensemble estimate or replacement zero.

`complete_future_required_variables` assesses the actual future cells, separately from `returned_value_checks_passed`. Overall readiness remains conservative: both checks and the existing acquisition/metadata gates must pass. A snapshot can therefore remain partial or a workflow remain red while containing valid independently usable fields and windows. This does not weaken the existing external checker's safeguards or activate a checker.

The 90-minute rule still describes acquisition age only. Source validity, newer evidence, test-only status and unknown per-value initialization retain their existing meaning. Selecting unaffected data does not authorize a report's use without its claim-specific source review.

## Numerical retry

Only a source with diagnosed numerical defects receives a numerical retry. It gets at most one additional whole-source acquisition after a five-second default wait. Provider Retry-After is honored; a wait above the existing ten-second budget stops the retry. Initial transport retries remain bounded to at most two attempts. The additional numerical acquisition gets one transport attempt, not another retry loop. Each acquisition has its own before/after metadata checks, source times, raw response and hash.

A clean retry is selected only when it preserves the first response's time coverage and passes the existing metadata guards. Otherwise the original response remains selected, with its original acquisition time. Both attempts and the latest failure remain in the retained evidence artifact. No fields, hours or members are spliced across acquisitions. A retry cannot make retained older data fresh.

Detailed rejected values and retry response archives are excluded from the public Pages projection. Public summaries expose only the necessary quality counts and window availability. Tests use synthetic data; real failure archives are not committed. Personal calendar data, credentials and private report-consumption receipts must never be written to the repository or its artifacts.

No workflow schedule, briefing schedule, notification, hosting configuration or dispatch behavior is changed by this repair. An ordinary source commit uses the existing push-triggered workflow; it is not proof of punctual scheduled collection or unattended briefing delivery.

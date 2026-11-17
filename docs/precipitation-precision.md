# Precision-bounded ECMWF precipitation adjustments (v1)

This policy is a documented analysis adjustment, not a repair of ECMWF's source
files and not proof that the unrounded forecast was exactly zero. Raw responses
and their hashes are unchanged. Unknown per-value initialization stays unknown.

## Acceptance rule

Only ECMWF IFS 0.25-degree ensemble precipitation is eligible. Every acquisition
also requests a three-hour precipitation response. It checks all 51 member
identities, units, time steps and sampled coordinates. This detects negative
native intervals even when hourly rounding displays three zeros.

For a negative native interval, use the stable before/after provider metadata to
select one candidate ECMWF run. Download only the two specific GRIB messages for
that member and the adjacent accumulated steps, from the fixed ECMWF public
Google mirror. Decode with ECMWF ecCodes. Require matching parameter, unit,
member, initialization candidate, native interval and exact sampled grid cell.
Require both accumulated totals to be finite and nonnegative, with start step
zero. Three-hour native steps 6 through 144 are supported; other periods stay
unavailable rather than being guessed or stitched to another run.

Let D be the later decoded total minus the earlier decoded total, in mm, and
let E1 and E2 be those two messages' ecCodes packingError values in mm. Set
B = E1 + E2. The correction requires -B <= D < 0, allowing only a 1e-9 mm
floating-point comparison tolerance. Also cross-check packingError against
binaryScaleFactor and decimalScaleFactor for the supported packing templates.
Reject precision uncertainty at least 1 mm because that is already as large as
the existing product's 1-mm precipitation-occurrence threshold. This is an
additional product-resolution safeguard, not a fixed negative-rain cutoff.

The decoded difference must reproduce the native API amount after rounding to
0.1 mm, and dividing that native amount by three and rounding must reproduce all
three hourly API values. Evidence must be bound to the current response hashes.
A duplicate proof, changed metadata, missing source, wrong grid/member/time/unit,
incomplete interval, unexplained magnitude or mismatch does not qualify.

Eligible intervals become zero only in copied calculation arrays. The original
native amount, three original hourly amounts, exact member and valid times,
measured precision bound, decoded source samples and source hashes are retained
in the evidence artifact. Global GRIB source messages are retained alongside
that artifact, not committed to the repository or served by Pages. GitHub
artifact access rules apply; artifacts in a public repository are not private.

## Limits and communication

A magnitude consistent with encoding precision is not proof of the exact
internal ECMWF stage that caused it. Identical final quantization scales can
also accompany an upstream numerical artifact. This policy uses independent
source reproduction plus a measured precision bound as a conservative
operational eligibility rule; it does not claim to recover the true field.
A matching candidate run is strong reproduction, not formal API value-level
provenance. Same-run comparison permissions remain false.

Positive precipitation is unchanged. Packing can also produce small positive
artifacts; this policy does not solve light-drizzle detection or calibrate
rain probabilities. Do not interpret an adjusted zero as proof of dry weather.

Public variable summaries, affected hourly/period summaries and text output
identify adjustments. A complete snapshot may include documented adjustments;
`returned_value_checks_passed` describes accepted analysis values, while
`raw_returned_value_checks_passed` distinguishes untouched numerical validity.
No model members are dropped. Unexplained native negatives, including negatives
hidden by hourly rounding, make the associated analysis cells unavailable.
Other complete windows, temperature, wind and the Canadian model are preserved.

No numerical retry is triggered solely by accepted adjustments. Other defects
retain the existing one-retry limit. There are no forecast-source substitutions,
member splices, synthetic live forecasts, schedule changes or freshness upgrades.

## Resource and failure bounds

The companion native request has one transport attempt. At most eight suspect
intervals per acquisition receive source verification. Each source transfer is
limited to 4 MiB, all source bytes to 32 MiB, and the decoder process to 60 seconds.
The HTTP reader requires exact 206 byte-range responses, rejects redirects and
full-model downloads, and stops further source requests after a 429. URL paths
are constructed from validated run/step identifiers; arbitrary URLs are refused.

The workflow installs the distribution's `python3-eccodes` package. Installation
failure is visible but does not discard independently usable weather fields.
Without a working decoder or matching source, corrections are not authorized.
Clean hourly data remain usable under the pre-existing checks when the extra
native request is unavailable, with native_check_status explicitly unavailable;
that is not a claim that hidden native anomalies were ruled out.

The independent Python checker repeats the identity, measured-bound and exact
value-reproduction checks. It does not trust a producer correction flag. Its ZIP
limits are 40 MiB compressed, 64 MiB expanded and 40 entries to accommodate the
bounded retained GRIB messages. Path, duplicate, symlink and format checks stay
in place. This change does not activate or reschedule that external checker.

## Primary references

- ECMWF explanation of packing errors, negative differences and small positive artifacts:
  https://confluence.ecmwf.int/spaces/UDOC/pages/208501579/Why+are+there+sometimes+small+negative+precipitation+accumulations+-+ecCodes+GRIB+FAQ
- ECMWF open-data access and distribution mirrors:
  https://github.com/ecmwf/ecmwf-opendata
- Open-Meteo ensemble model resolution and interval semantics:
  https://open-meteo.com/en/docs/ensemble-api

The older ECMWF FAQ's example thresholds are not applied as universal constants.
This collector derives B separately from the actual two source messages.

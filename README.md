# Client Weather Feed

A scheduled ensemble-weather data service for a configured forecast point. GitHub Actions runs a short Node.js job and GitHub Pages serves generated static files. The forecast target is independent of the repository name.

## Operation

The workflow is defined in `.github/workflows/weather.yml`. It runs on its configured schedule and can also be explicitly started through workflow_dispatch. `WORKFLOW.yml` is an identical reference copy. Node.js 22 or newer and Python 3.9 or newer are required for the full validation suite.

```sh
npm test
python3 -m unittest discover -s ops -p 'test_*.py' -v
npm run build
```

Tests run offline. A production build requests live data, checks coverage and units, and exports the site to `_site/`. The workflow adds a producer receipt to the separate evidence artifact.

## Published files and full evidence

- `index.html`: readable feed and collection status.
- `latest.txt`: script-free text summary.
- `latest.json`: derived base statistics, without explicit coordinates or request URLs.
- `status.json`: build timestamp, readiness and acquisition-freshness deadline.
- `supplement-status.json`: additional source statuses only, not their full numerical data.
- `capture.json`: a notice at the former raw-download address, not raw responses.

Public status and data use `client-ensemble-pages-v1`. Internal evidence retains compatibility schemas `philly-ensemble-collector-v1` and `philly-ensemble-pages-v1`. A successful HTTP request or ready-at-generation flag does not establish present freshness, completeness or use in a report.

Full `capture.json`, `validated.json`, `supplement.json` and `collection-receipt.json` are kept in the short-lived `collector-evidence` workflow artifact, not the Pages directory. A failed or missing supplement does not erase valid base data. A producer receipt records collection and validation, never actual report consumption.

This is data minimization, not anonymity. Repository source, commit history and artifact permissions remain separate. Artifacts in a public repository are not private. Never publish confidential location information, personal calendars, private report receipts or credentials here.

## Collection age is not forecast lifetime

The 90-minute acquisition limit is unchanged. `acquisition_fresh_until_utc` is the explicit deadline; legacy `expires_at_utc` has the same acquisition-only meaning. After that deadline, do not call the collection fresh. Do not automatically discard all forecasts either.

Review each source's own issue or observation time, exact forecast-valid period, numerical completeness, newer evidence and intended claim. An accepted dated fallback needs its age and review reason recorded. Old observations remain historical. Cached alerts never establish a current all-clear. See `docs/reliability.md` and `src/freshness-policy.mjs`.

## Sources and interpretation

The base collector explicitly requests ECMWF IFS ensemble and Canadian GEPS through Open-Meteo. It validates temperature, precipitation water equivalent and sustained near-surface wind. The separate supplement includes independently checked optional cloud, derived sunshine, liquid rain and gust requests, NWS forecasts and captured alerts, SPC/WPC outlooks, AirNow reporting-area data and CAMS model estimates. Not every optional source succeeds. Captured alerts require a fresh live check at report time; forecasts are not observations. Full supplementary numerical content is not published on Pages.

Each model is summarized separately. Ensemble percentiles are raw spread, not calibrated confidence intervals. Precipitation fractions apply to stated thresholds and intervals, not official probabilities. Highs and following nighttime lows are sampled extrema over documented intervals, with Celsius extrema together followed by Fahrenheit extrema.

Provider metadata is retained when available. A latest-model timestamp does not establish initialization for every value in a rolling response. Same-valid-period comparisons remain useful when labeled; same-initialization attribution remains unverified.

## Deployment and maintenance

GitHub Pages uses GitHub Actions. The workflow publishes only generated site files, verifies the deployed build and reports incomplete upstream base data. Scheduled starts can be late or missed.

`ops/watchdog.py` and `ops/render-watchdog.yaml` provide a bounded independent starter/checker deployment path. A checked-in template is not an active external schedule. Hosting connection, secret configuration and actual execution verification are required before activation can be claimed. The existing GitHub schedule remains in place. No report times or notification settings are changed by these files.

Use standard runners, short retention and eligible noncommercial API use. Public weather outputs describe a forecast target, not a device's live location or anyone's residence. See the reliability document for failure tests, private consumption receipts and acceptance criteria.

## Attribution

Code is MIT licensed. Weather data and derived statistics require attribution to Open-Meteo, ECMWF and Environment and Climate Change Canada under applicable licenses, including CC BY 4.0 as documented by Open-Meteo.

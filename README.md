# Client Weather Feed

A scheduled ensemble-weather data service for a configured forecast point. GitHub Actions runs a short Node.js job and GitHub Pages serves the generated static files. The forecast target is independent of the repository name.

## Operation

The workflow is defined in `.github/workflows/weather.yml`. It runs on its configured schedule and can also be started from the Actions tab with **Run workflow**. `WORKFLOW.yml` is a matching reference copy. Node.js 22 or newer is required.

```sh
npm test
npm run build
```

Tests run offline. A production build requests live data, checks coverage and units, then exports the site to `_site/`.

## Published files

- `index.html`: readable feed and status.
- `latest.txt`: script-free text summary.
- `latest.json`: derived statistics and validation status.
- `status.json`: build timestamp, readiness and expiry.
- `capture.json`: source-response evidence.

Readers must check `test_only`, `ready_at_generation`, `status_at_generation` and `expires_at_utc`. A successful HTTP request does not establish that the forecast is current or complete. A failed acquisition must remain visibly unavailable or partial.

## Sources and interpretation

The collector explicitly requests ECMWF IFS ensemble and Canadian GEPS through Open-Meteo. It validates temperature, precipitation water equivalent and sustained near-surface wind. This feed does not supply official warnings, air-quality forecasts or observed current conditions.

Each model is summarized separately. Ensemble percentiles are raw model spread, not calibrated confidence intervals. Precipitation fractions apply to the stated threshold and interval; they are not official precipitation probabilities. Temperature highs and following nighttime lows are sampled extrema over the documented intervals. Celsius extrema are grouped together, followed by Fahrenheit extrema.

Provider update metadata is retained when available. A latest-model timestamp does not establish the initialization of every value in a rolling response; per-value initialization and same-run comparison remain unverified unless explicitly demonstrated.

## Deployment and maintenance

Configure GitHub Pages to use GitHub Actions. The workflow publishes only generated site files, verifies the deployed build and reports incomplete upstream data. Scheduled jobs can be delayed or disabled, so consumers must enforce the recorded expiry.

Use standard runners, short artifact retention and eligible noncommercial API use. Do not add credentials or unrelated personal data to this repository. Public weather outputs describe a forecast target, not a device's live location or proof of anyone's residence.

## Attribution

Code is MIT licensed. Weather data and derived statistics require attribution to Open-Meteo, ECMWF and Environment and Climate Change Canada under the applicable data licenses, including CC BY 4.0 as documented by Open-Meteo.

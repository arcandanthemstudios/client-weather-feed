# 19107 ensemble feed: GitHub Actions + GitHub Pages

This is the GitHub-ready version of the existing collector. GitHub runs a short Node.js job; Pages hosts its resulting static files. It does not require Railway, Cloudflare, a running computer, a personal access token, or an Open-Meteo API key for eligible noncommercial use.

## Status before setup

The code and offline tests have been checked locally. No repository, workflow, or Pages site has been created by the assistant. A real run on GitHub and a read of the published feed are still required. The included archived six-hour temperature fixture is test evidence, not a live forecast. Production never reads that fixture.

## What becomes public

Use a **new public repository** for the free GitHub Pages configuration. Its code, workflow logs, weather-only test fixture, and generated weather feed will be visible. The collector requests only a fixed general Philadelphia point (39.95, -75.16), not the user's device location or address. It does not connect to calendars, email, health records, or personal apps. The point has not been programmatically checked against a postal polygon; sampled global-model grid cells can be outside 19107.

## Browser-only setup

A computer browser is convenient for this one-time folder upload. Nothing needs to remain running on that computer afterward.

1. Create a new repository under your GitHub account named `philly-weather-feed`. Choose **Public** and initialize it with a README. Use the default branch `main`.
2. Extract the download. In the repository, choose **Add file → Upload files**. Upload the contents of the `philly-weather-feed` folder, not the ZIP or an extra enclosing folder. The repository root must contain `package.json`, `README.md`, `WORKFLOW.yml`, `src/`, and `test/`. Keep the subfolders intact. Commit to `main`.
3. Open **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**. Skip GitHub's suggested workflow templates: this package supplies one.
4. Ensure `.github/workflows/weather.yml` exists in the repository. That folder is hidden on some computers. If it was not uploaded, open the uploaded `WORKFLOW.yml`, copy its entire raw contents, then choose **Add file → Create new file**. Name the new file exactly `.github/workflows/weather.yml`, paste, and commit to `main`. The visible root `WORKFLOW.yml` is a convenience copy; GitHub runs only the file in `.github/workflows/`.
5. Open **Actions → Collect and publish 19107 weather → Run workflow**, select `main`, then run. A code/workflow push also triggers a run, so do not repeatedly start duplicate jobs. If a first run started before Pages was enabled, rerun it after step 3.
6. Inspect the run. Its collection summary should show both requested models and complete data. A successful deployment alone is not enough: the final step intentionally fails if the numerical acquisition/coverage gate fails. The public page will still explain the incomplete status.
7. Open the URL displayed by **Settings → Pages** or the deployment. With the suggested repository name under `arcandanthemstudios`, its expected address after deployment is `https://arcandanthemstudios.github.io/philly-weather-feed/`. It is not live merely because this README exists.

## What runs and when

`.github/workflows/weather.yml` requests collection at 05:35, 11:35, and 17:35 in `America/New_York`. GitHub's native `timezone` field handles the local-time schedule. These are acquisition jobs ahead of the existing 06:00, 12:00 and 18:00 briefing/check slots. This package does not modify any ChatGPT task.

Each job checks out code, installs Node.js 22 through the official action, runs offline tests, fetches data once, exports static files, deploys Pages, and retrieves `status.json` to confirm the deployed build timestamp. It then stops. No continuously running web server is used.

GitHub can delay or drop scheduled jobs during high demand. Public-repository schedules are disabled after 60 days without repository activity; check Actions and re-enable a disabled workflow when needed. This project does not create artificial keep-alive commits. Scheduler delays must be handled by timestamps, not by pretending an old capture is new.

## URLs and acceptance checks

Relative to the deployed site:

- `index.html`: readable status and model summary; browser-side expiry warning.
- `latest.txt`: concise, script-free text feed.
- `latest.json`: member statistics, hourly windows, validation and provenance.
- `status.json`: small acquisition/coverage summary and expiry.
- `capture.json`: the original weather responses and request metadata.

For a complete current supplement, `status.json` must have:

- `schema: "philly-ensemble-pages-v1"` and `test_only: false`.
- `ready_at_generation: true` and `status_at_generation: "complete"`.
- The actual current time no later than `expires_at_utc`.
- Both model deadlines and coverage checks, not one model silently substituted for another.

The default maximum acquisition age is 90 minutes. This is an operational guard for scheduled briefings, not a claim that meteorological skill expires after 90 minutes. The static JSON's build-time readiness cannot update itself between runs; consumers must compare the deadline to their current clock. HTTP 200 alone proves neither freshness nor numerical completeness. On a failed acquisition, this version publishes an explicit partial/unavailable snapshot rather than relabeling the last successful one.

## Data and interpretation

Requests use the explicit model IDs `ecmwf_ifs025_ensemble` and `cmc_gem_geps`, through Open-Meteo. Expected API series counts are 51 and 21, validated on each response; a provider change should fail for investigation, not trigger automatic substitution. This counts API series, not independently verified upstream control-member identities.

Collected variables are temperature, preceding-hour precipitation water equivalent, and sustained 10 m wind. Four UTC forecast days plus one past day provide the specified three local days and following nights. The past-day values remain model-delivered data, not observations. Gusts, current observations, alerts, air quality, and calendars are not supplied by this feed.

Celsius high/nighttime low stay together, then Fahrenheit high/nighttime low. Temperature extrema use sampled 06:00–18:00 highs and the following 18:00–06:00 lows, not official daily maximum/minimum products. Rainfall sums use the documented preceding-hour intervals; raw member fractions above a specified threshold are not NWS precipitation probabilities. Per-model percentile ranges are uncalibrated model spread. Do not pool the models' unequal member counts.

The metadata endpoint is checked before and after numerical retrieval when available. Reported latest-run metadata does not establish initialization for each value in a rolling API response. `per_value_model_initialization_verified` and `same_run_comparison_permitted` remain false. Missing optional metadata is disclosed; known stale/future/changing metadata blocks the readiness gate.

NWS point/hourly forecasts, official alerts and local observations remain the actual briefing's foundation. This feed only adds ensemble evidence.

## Free-use boundaries

Use a public repository, standard `ubuntu-latest` runners and the included short artifact retention (`retention-days: 1`). Do not select larger paid runners, raise paid storage limits, or put secrets into this repository. Free standard public-runner minutes do not make all possible account storage usage free: review your account's existing Actions/Packages storage and spending controls.

Open-Meteo's open-access API supports noncommercial use, is rate limited, and has no uptime guarantee. API requests from GitHub's network can still fail or be throttled. The first GitHub execution is the test of this new acquisition environment; a successful browser capture does not guarantee it.

## Connector access and the briefing

The GitHub connector exposed in this chat can read repository files, workflow runs, logs and artifacts. It cannot create this repository, push the files, enable Pages or trigger a run. No GitHub credential should be pasted into chat.

After creation, make sure the new repository is allowed in the ChatGPT GitHub app's repository access settings. Share the repository link in the conversation. Actual workflow logs and weather artifacts can then be inspected with the connector. Pages provides a public readable feed, but the scheduled briefing's ability to retrieve it still needs a successful test. Do not claim the briefing is integrated merely because Pages deployed successfully.

## Troubleshooting

- No workflow in Actions: check the exact `.github/workflows/weather.yml` path and `main` branch, not just the root `WORKFLOW.yml` copy.
- Pages setup/deployment fails: verify Settings → Pages uses GitHub Actions. Check any repository/organization policy or `github-pages` environment approval requirement.
- HTTP 400 / changed schema: inspect the collection result and current API model/variable documentation. Do not randomly swap to a deterministic/default model.
- HTTP 429: honor Retry-After; do not repeatedly click Run workflow. The collector has bounded retry behavior.
- One model is missing: the site publishes partial status and the workflow ends with a failure. Do not use it as a complete comparison.
- Red post-deployment verification step: Pages may still be serving an older build or be inaccessible; inspect the concrete error and timestamps.
- Old site after a workflow/build failure: check `expires_at_utc`. An earlier deployed site can remain accessible; it is not made fresh by reloading.
- Data are ready at build but stale between checks: expected with a 90-minute consumer guard and three daily collections. Do not interpret the all-day public page as continuous monitoring.

## Local code tests (optional, not needed for browser setup)

With Node.js 22 or newer: `npm test`. There are no third-party runtime dependencies to install. `npm run build` performs a real one-shot network acquisition and exports `_site/`; offline tests never contact weather services. The publication workflow does not run on pull requests and does not need repository write permission.

## Official references checked October 9, 2026

- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
- https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://help.openai.com/en/articles/11145903-connecting-github-to-chatgpt
- https://open-meteo.com/en/docs/ensemble-api
- https://open-meteo.com/en/docs/model-updates
- https://open-meteo.com/en/pricing

Code is MIT licensed. Weather data have separate attribution requirements: Open-Meteo, ECMWF and Environment and Climate Change Canada, CC BY 4.0 as documented by Open-Meteo. Derived statistics and conversions are identified in the feed.

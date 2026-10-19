# Retry-safe Pages packages

The collection job names each Pages upload `github-pages-<run_id>-<collection_attempt>` and exports that exact name as `pages_artifact_name`. Both the upload action and deployment job use that producer output. The deployment job validates the name and fails explicitly if it is missing or belongs to another run. It does not guess the default artifact or pick the newest package by title.

A collection retry creates a new package name. A deployment-only retry must reuse the output from the collection that actually built the package, not recompute a name using the deployment retry number. The existing expected-build check still verifies the site publication against the producer's build timestamp.

Older uploads are not deleted or overwritten. The separate `collector-evidence` archive keeps its existing name, content, one-day retention, hashes and producer receipt. Consumers disambiguate evidence from multiple attempts by artifact ID and the receipt's run/attempt, not by name alone. This change does not publish full source evidence, private reports or calendar data.

Reruns use their original commit and workflow. Start validation from a run containing this fix; rerunning an older broken workflow does not acquire the repair. Collection success, artifact upload, site deployment and actual report use remain separate outcomes. This fix resolves package-name ambiguity; it does not guarantee scheduled starts or activate an external recovery service.

The regression tests execute the workflow's actual naming and validation shell snippets. They check distinct attempts, invalid identities, exact producer-output wiring, deployment-only retries, and preservation of evidence and schedule. Run `node --test test/pages-artifact.test.mjs`, then the full existing suites. Real collection and deployment retries require separate live verification; tests alone do not establish platform behavior.

Official references:
- https://github.com/actions/upload-pages-artifact/blob/v4/action.yml
- https://github.com/actions/deploy-pages/blob/v4/action.yml
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/pass-job-outputs
- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs

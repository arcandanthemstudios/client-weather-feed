/** Execute the actual workflow shell snippets, not a substitute naming function. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/weather.yml', import.meta.url), 'utf8');
const reference = readFileSync(new URL('../WORKFLOW.yml', import.meta.url), 'utf8');
function step(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const next = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, next < 0 ? workflow.length : next);
}
function script(name) {
  const match = step(name).match(/^        run: \|\n([\s\S]*)/m);
  assert.ok(match, 'Expected a literal shell script');
  return match[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
}
function execute(name, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pages-package-test-'));
  const output = join(dir, 'outputs');
  try {
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script(name)], {
      encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1',
        GITHUB_OUTPUT: output, ...env }
    });
    if (result.error) throw result.error;
    return { status: result.status, stderr: result.stderr,
      output: existsSync(output) ? readFileSync(output, 'utf8') : '' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const naming = "Name this collection's Pages package";
const guard = 'Verify the collected Pages package name';

test('Pages naming is unique for each run and collection attempt', () => {
  const first = execute(naming);
  const retry = execute(naming, { GITHUB_RUN_ATTEMPT: '2' });
  const other = execute(naming, { GITHUB_RUN_ID: '67890' });
  for (const result of [first, retry, other]) assert.equal(result.status, 0, result.stderr);
  assert.equal(first.output, 'artifact_name=github-pages-12345-1\n');
  assert.equal(retry.output, 'artifact_name=github-pages-12345-2\n');
  assert.equal(new Set([first.output, retry.output, other.output]).size, 3);
});

test('Pages naming refuses missing or unsafe workflow identities', () => {
  for (const env of [{ GITHUB_RUN_ID: '' }, { GITHUB_RUN_ATTEMPT: '' },
    { GITHUB_RUN_ID: '12/34' }, { GITHUB_RUN_ATTEMPT: '2\nartifact_name=wrong' },
    { GITHUB_RUN_ATTEMPT: '0' }]) {
    const result = execute(naming, env);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, '');
  }
});

test('Pages upload and deployment share the producer job output without guessing', () => {
  assert.equal(workflow, reference);
  assert.ok(workflow.includes('pages_artifact_name: ${{ steps.pages_package.outputs.artifact_name }}'));
  assert.ok(step('Upload only the generated public weather site')
    .includes('name: ${{ steps.pages_package.outputs.artifact_name }}'));
  assert.ok(step('Deploy the weather feed')
    .includes('artifact_name: ${{ needs.collect.outputs.pages_artifact_name }}'));
  assert.ok(step(guard).includes('PAGES_ARTIFACT_NAME: ${{ needs.collect.outputs.pages_artifact_name }}'));
  const deploy = workflow.split('\n  deploy:\n')[1];
  assert.ok(!deploy.includes('github.run_attempt'));
  assert.ok(!deploy.includes('GITHUB_RUN_ATTEMPT'));
  assert.ok(!step('Deploy the weather feed').includes('||'));
});

test('A deploy-only retry keeps the earlier collection package name', () => {
  const result = execute(guard, { GITHUB_RUN_ATTEMPT: '3', PAGES_ARTIFACT_NAME: 'github-pages-12345-2' });
  assert.equal(result.status, 0, result.stderr);
});

test('Deployment rejects missing, wrong-run and malformed package names', () => {
  for (const name of ['', 'github-pages', 'github-pages-67890-1',
    'github-pages-12345-0', 'github-pages-12345-1\nextra']) {
    assert.notEqual(execute(guard, { PAGES_ARTIFACT_NAME: name }).status, 0);
  }
});

test('Retry repair retains evidence, approved schedule and safety checks', () => {
  assert.ok(workflow.includes("cron: '35 0,6 * * *'"));
  assert.ok(workflow.includes("cron: '13 14 * * *'"));
  assert.ok(workflow.includes("timezone: 'America/New_York'"));
  assert.ok(workflow.includes('name: collector-evidence'));
  assert.ok(workflow.includes('path: _evidence/'));
  assert.ok(workflow.includes('EXPECTED_BUILD: ${{ needs.collect.outputs.generated_at_utc }}'));
  assert.ok(workflow.includes('cancel-in-progress: false'));
  assert.ok(!workflow.includes('overwrite: true'));
  assert.ok(!workflow.includes('contents: write'));
});

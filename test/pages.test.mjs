import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFeed, eligibleNow, renderText, renderHTML, writeSite } from '../src/static-feed.mjs';
import { syntheticCapture, original, clone, NOW } from './helpers.mjs';
function controlledSyntheticCapture() {
  const c = syntheticCapture();
  c.capture_schema = 'philly-ensemble-collector-v1';
  c.execution_location = 'github_actions_once';
  return c;
}
test('Public export refuses archived browser capture', () => {
  assert.throws(() => makeFeed(original, NOW), /Only a new acquisition/);
});
test('Public export refuses explicitly synthetic upstream capture', () => {
  assert.throws(() => makeFeed(syntheticCapture(), NOW), /Only a new acquisition/);
});
test('Explicit test export is never eligible as current weather', () => {
  const f = makeFeed(syntheticCapture(), NOW, {testOnly:true});
  assert.equal(f.test_only,true); assert.equal(eligibleNow(f,NOW),false);
  assert.match(renderText(f),/TEST FIXTURE/);
});
test('Synthetic transport test: acquisition expiry uses the oldest model receipt', () => {
  const c=controlledSyntheticCapture();
  c.records[0].received_at_utc=new Date(NOW-120000).toISOString();
  const f=makeFeed(c,NOW);
  assert.equal(f.ready_at_generation,true);
  assert.equal(Date.parse(f.expires_at_utc),NOW+88*60000);
  assert.equal(eligibleNow(f,NOW+30*60000),true);
  assert.equal(eligibleNow(f,NOW+89*60000),false);
});
test('A successful build cannot make a one-model dataset a complete comparison', () => {
  const c=controlledSyntheticCapture(); c.records.pop();
  const f=makeFeed(c,NOW);
  assert.equal(f.status_at_generation,'partial');
  assert.equal(f.ready_at_generation,false); assert.equal(f.expires_at_utc,null);
});
test('Failed data acquisition produces an unavailable status, not a fabricated forecast', () => {
  const c=controlledSyntheticCapture();
  c.records=c.records.map(r=>({requested_model:r.requested_model,http_status:null,error:'Timeout'}));
  const f=makeFeed(c,NOW);
  assert.equal(f.status_at_generation,'unavailable'); assert.equal(f.ready_at_generation,false);
  assert.match(renderText(f),/NOT READY/);
});
test('Static export never upgrades run provenance', () => {
  const f=makeFeed(controlledSyntheticCapture(),NOW);
  assert.equal(f.per_value_model_initialization_verified,false);
  assert.equal(f.same_run_comparison_permitted,false);
});
test('HTML escapes upstream error strings', () => {
  const f=makeFeed(syntheticCapture(),NOW,{testOnly:true});
  f.summary.models[0].error='<script>alert("injected")</script>';
  const html=renderHTML(f);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>alert("injected")</script>'));
});
test('Project Pages links are relative, not account-root absolute paths', () => {
  const f=makeFeed(syntheticCapture(),NOW,{testOnly:true});
  assert.match(renderHTML(f),/href="latest.json"/);
  assert.ok(!renderHTML(f).includes('href="/latest.json"'));
  assert.ok(!renderText(f).includes('Use /latest.json'));
});
test('Export writes only a bounded site file list', async () => {
  const dir=await fs.mkdtemp(join(tmpdir(),'weather-pages-test-'));
  try {
    const c=syntheticCapture(), f=makeFeed(c,NOW,{testOnly:true});
    await writeSite(dir,c,f);
    assert.deepEqual((await fs.readdir(dir)).sort(),['.nojekyll','capture.json','index.html','latest.json','latest.txt','robots.txt','status.json'].sort());
    assert.equal(JSON.parse(await fs.readFile(join(dir,'latest.json'),'utf8')).test_only,true);
    assert.equal(JSON.parse(await fs.readFile(join(dir,'capture.json'),'utf8')).test_only,true);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('Export refuses the working directory as a destination', async()=> {
  const c=syntheticCapture(), f=makeFeed(c,NOW,{testOnly:true});
  await assert.rejects(writeSite('.',c,f),/unsafe/);
});
test('Workflow copies match and use Eastern timezone and official Pages artifact deployment', async()=> {
  const a=await fs.readFile('.github/workflows/weather.yml','utf8');
  const b=await fs.readFile('WORKFLOW.yml','utf8');
  assert.equal(a,b); assert.match(a,/timezone: 'America\/New_York'/);
  assert.match(a,/cron: '35 0,6,15 \* \* \*'/);
  assert.match(a,/actions\/deploy-pages@v4/); assert.match(a,/path: _site/);
  assert.ok(!a.includes('contents: write')); assert.match(a,/retention-days: 1/);
});
test('Feed does not forbid the retrieval crawler it is intended to serve', async () => {
  const dir=await fs.mkdtemp(join(tmpdir(),'weather-crawler-test-'));
  try {
    const c=syntheticCapture(), f=makeFeed(c,NOW,{testOnly:true});
    await writeSite(dir,c,f);
    const robots=await fs.readFile(join(dir,'robots.txt'),'utf8');
    assert.ok(!robots.includes('Disallow: /'));
    assert.ok(robots.includes('Allow: /'));
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

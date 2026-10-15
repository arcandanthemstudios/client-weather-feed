import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExtra, wetTiming, contains, outlook, productTime, acquire } from '../src/supplement.mjs';
import { syntheticRecord, NOW } from './helpers.mjs';
function optional(variable='cloud_cover',unit='%',value=40){
 const r=syntheticRecord(),raw=r.raw_response,h={time:raw.hourly.time},units={time:'iso8601'};
 for(let i=0;i<21;i++){const k=i?`${variable}_member${String(i).padStart(2,'0')}`:variable;h[k]=h.time.map(()=>value);units[k]=unit;}
 return{...raw,hourly:h,hourly_units:units};
}
test('Optional cloud fields validate independently',()=>assert.equal(validateExtra(optional(),'cmc_gem_geps','cloud_cover',NOW).status,'validated'));
test('Missing optional values stay unavailable, not zero',()=>assert.equal(validateExtra(optional('sunshine_duration','s',null),'cmc_gem_geps','sunshine_duration',NOW).status,'unavailable'));
test('A gust is not inferred from sustained wind',()=>assert.throws(()=>validateExtra(optional(),'cmc_gem_geps','wind_gusts_10m',NOW)));
test('Incomplete member set is rejected',()=>{const r=optional();delete r.hourly.cloud_cover_member20;assert.throws(()=>validateExtra(r,'cmc_gem_geps','cloud_cover',NOW));});
test('Cloud percentage out of range rejected',()=>assert.throws(()=>validateExtra(optional('cloud_cover','%',101),'cmc_gem_geps','cloud_cover',NOW)));
test('Wrong units rejected',()=>assert.throws(()=>validateExtra(optional('wind_gusts_10m','km/h',20),'cmc_gem_geps','wind_gusts_10m',NOW)));
test('Wrong model location rejected',()=>{const r=optional();r.latitude=0;assert.throws(()=>validateExtra(r,'cmc_gem_geps','cloud_cover',NOW));});
test('Hourly gaps rejected',()=>{const r=optional();r.hourly.time[1]=r.hourly.time[0];assert.throws(()=>validateExtra(r,'cmc_gem_geps','cloud_cover',NOW));});
test('All-day wet forecasts mark both boundaries censored',()=>{const t=wetTiming(syntheticRecord(),NOW).days[0];assert.equal(t.wet_members,21);assert.equal(t.starts_before_day_not_excluded_members,21);assert.equal(t.ends_after_day_not_excluded_members,21);});
test('Dry members are in occurrence denominator but have no timing',()=>{const r=syntheticRecord();for(const[k,v]of Object.entries(r.raw_response.hourly))if(k.startsWith('precipitation'))v.fill(0);const t=wetTiming(r,NOW).days[0];assert.equal(t.raw_wet_fraction,0);assert.equal(t.first_wet_interval_start,null);});
test('Daily timing uses preceding-hour interval start',()=>{const r=syntheticRecord();for(const[k,v]of Object.entries(r.raw_response.hourly))if(k.startsWith('precipitation')){v.fill(0);const i=r.raw_response.hourly.time.indexOf('2026-10-08T15:00');v[i]=1;}const t=wetTiming(r,NOW).days[0];assert.equal(t.first_wet_interval_start.median_utc,'2026-10-08T14:00:00.000Z');assert.equal(t.last_wet_interval_end.median_utc,'2026-10-08T15:00:00.000Z');});
const geom={type:'Polygon',coordinates:[[[0,0],[10,0],[10,10],[0,10],[0,0]],[[4,4],[6,4],[6,6],[4,6],[4,4]]]};
test('Polygon containment respects holes and outside points',()=>{assert.equal(contains(geom,[2,2]),true);assert.equal(contains(geom,[5,5]),false);assert.equal(contains(geom,[20,20]),false);});
test('Geometry boundary counts as included',()=>assert.equal(contains(geom,[0,0]),true));
test('Empty outlook without valid-time evidence is not all-clear',()=>assert.equal(outlook({type:'FeatureCollection',features:[]},NOW).status,'validity_unverified_or_stale'));
test('Expired outlook not used',()=>{const raw={type:'FeatureCollection',features:[{geometry:geom,properties:{ISSUE:'202001010000',VALID:'202001010000',EXPIRE:'202001020000'}}]};assert.equal(outlook(raw,NOW).status,'validity_unverified_or_stale');});
test('Parse issue times, do not replace missing with retrieval time',()=>{assert.equal(productTime('202610151200'),Date.parse('2026-10-15T12:00Z'));assert.equal(productTime(null),null);});
test('Refuse unapproved network destination',async()=>assert.rejects(acquire('https://example.com')));
test('Successful HTTP error payload is still an error',async()=>{const result=await acquire('https://api.weather.gov/points/test',{fetchImpl:async()=>new Response(JSON.stringify({error:'bad'}),{headers:{'content-type':'application/json'}})});assert.equal(result.status,'unavailable');});
test('Size budget enforced on streamed response',async()=>{const result=await acquire('https://api.weather.gov/points/test',{maxBytes:2,fetchImpl:async()=>new Response('1234')});assert.equal(result.status,'unavailable');});

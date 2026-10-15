import test from 'node:test';import assert from 'node:assert/strict';
import {airNow,nwsForecast,finalize} from '../src/source-checks.mjs';
const now=Date.parse('2026-10-15T22:00:00Z');
// Synthetic station names and data; no live observations in tests.
const row=(kind='O',value='30',date='10/15/26',hour='17:00')=>`10/15/26|${date}|${hour}|EDT|0|${kind}|Y|Test Area|PA|39.95|-75.15|OZONE|${value}|Good|No||Test Agency`;
test('AirNow parses observation time separately from source issue date',()=>{const r=airNow(row(),now);assert.equal(r.current.observed_at_utc,'2026-10-15T21:00:00.000Z');assert.equal(r.current.aqi,30);assert.equal(r.issue_clock_time_reported,false);});
test('Blank AQI does not turn into zero; category-only forecast retained',()=>{const r=airNow(row('F','','10/16/26',''),now);assert.equal(r.forecasts[0].aqi,null);assert.equal(r.forecasts[0].category,'Good');assert.equal(r.current,null);});
test('Sentinel negative AQI is missing',()=>{const r=airNow(row('O','-999'),now);assert.equal(r.current,null);});
test('Old observation is not current clean air',()=>assert.equal(airNow(row('O','30','10/14/26'),now).current,null));
test('Future observation rejected',()=>assert.equal(airNow(row('O','30','10/16/26'),now).current,null));
test('Malformed data is not interpreted',()=>assert.throws(()=>airNow('not|a|weather|file',now)));
test('NWS freshness uses updateTime, not generatedAt',()=>{const r=nwsForecast({properties:{updateTime:'2026-10-13T00:00:00Z',generatedAt:'2026-10-15T22:00:00Z',validTimes:'2026-10-13T00:00:00Z/P7D'}},now);assert.equal(r.status,'stale_forecast');});
test('NWS missing issue time remains unverified',()=>assert.equal(nwsForecast({properties:{validTimes:'2026-10-15T00:00:00Z/P7D'}},now).status,'source_time_unverified'));
test('Unknown field format does not block other sources',()=>{const r=finalize({sources:[{id:'airnow-reporting-areas',raw:'bad'},{id:'independent',status:'validated'}]},now);assert.equal(r.sources[0].status,'parse_failed');assert.equal(r.sources[1].status,'validated');});

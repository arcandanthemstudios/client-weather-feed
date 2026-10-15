/** Independent enrichment. Optional failures never invalidate the base weather feed. */
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TARGET, MODELS, iso, parseUTC, stats, boundary, addDate, localParts, kmBetween, validateRecord } from './core.mjs';
import { forecastURL } from './collect.mjs';
const H = 3600000;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const HOSTS = new Set(['ensemble-api.open-meteo.com','air-quality-api.open-meteo.com','api.weather.gov','www.spc.noaa.gov','mapservices.weather.noaa.gov','files.airnowtech.org']);
export const EXTRA = { cloud_cover: ['%',0,100], sunshine_duration: ['s',0,3600], wind_gusts_10m: ['m/s',0,150], rain: ['mm',0,2000] };
export async function acquire(url, { text = false, maxBytes = 8 * 1024 * 1024, fetchImpl = fetch } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) throw new Error('Unapproved acquisition host');
  const receipt = { url: u.href, requested_at_utc: iso(Date.now()), source_issue_time: null };
  try {
    const r = await fetchImpl(u, { redirect:'error', signal:AbortSignal.timeout(20000), headers:{ Accept:text?'text/plain,*/*':'application/geo+json,application/json', 'User-Agent':'Client-Weather-Feed/1.2 (noncommercial data reader)' } });
    receipt.http_status = r.status;
    receipt.last_modified_header = r.headers.get('last-modified');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (Number(r.headers.get('content-length')) > maxBytes) throw new Error('Download budget exceeded');
    let size=0; const chunks=[];
    for await (const bytes of r.body) { size+=bytes.length; if(size>maxBytes) throw new Error('Download budget exceeded'); chunks.push(Buffer.from(bytes)); }
    const body=Buffer.concat(chunks).toString('utf8');
    const raw=text?body:JSON.parse(body);
    if (!text && (!raw || raw.error)) throw new Error('Upstream JSON error');
    return {...receipt, received_at_utc:iso(Date.now()), status:'received', bytes:size, raw};
  } catch(e) { return {...receipt, received_at_utc:iso(Date.now()), status:'unavailable', error:String(e.message).slice(0,180)}; }
}
export function validateExtra(raw, model, variable, now=Date.now()) {
  if (!MODELS[model] || !EXTRA[variable] || !raw?.hourly || raw.utc_offset_seconds !== 0) throw new Error('Unexpected optional response');
  if (!finite(raw.latitude)||!finite(raw.longitude)||kmBetween(TARGET,raw)>40) throw new Error('Wrong or unknown model location');
  const time=raw.hourly.time?.map(parseUTC);
  if(!time?.length || time.some((t,i)=>i>0&&t-time[i-1]!==H)) throw new Error('Invalid time axis');
  const keys=Object.keys(raw.hourly).filter(k=>k===variable||new RegExp(`^${variable}_member[0-9]+$`).test(k));
  const ids=keys.map(k=>k===variable?0:Number(k.split('_member')[1]));
  const count=MODELS[model].count, [unit,min,max]=EXTRA[variable];
  if(keys.length!==count || new Set(ids).size!==count || ids.some(i=>i<0||i>=count)) throw new Error('Incomplete member identities');
  const memberId=k=>k===variable?0:Number(k.split('_member')[1]);
  keys.sort((a,b)=>memberId(a)-memberId(b));
  const arrays=keys.map(k=>raw.hourly[k]);
  if(keys.some(k=>raw.hourly_units?.[k]!==unit)||arrays.some(a=>!Array.isArray(a)||a.length!==time.length)) throw new Error('Wrong units or array length');
  if(arrays.some(a=>a.some(v=>v!==null&&(!finite(v)||v<min||v>max)))) throw new Error('Invalid optional value');
  const end=boundary(addDate(localParts(now).date,3),6);
  const from=Math.ceil(now/H)*H;
  const needed=[]; for(let t=from;t<end;t+=H) needed.push(time.indexOf(t));
  const complete=needed.length>0&&needed.every(i=>i>=0&&arrays.every(a=>finite(a[i])));
  const valid=arrays.flat().filter(finite).length;
  const hourly=time.map((t,i)=>({valid_utc:iso(t),...stats(arrays.map(a=>a[i]),count)})).filter(x=>parseUTC(x.valid_utc)>=from&&parseUTC(x.valid_utc)<end);
  return { status:complete?'validated':valid?'partial':'unavailable', variable, units:unit, members:count, finite_values:valid,
    missing_values:arrays.length*time.length-valid, complete_future_window:complete, hourly,
    sampled_coordinates:{latitude:raw.latitude,longitude:raw.longitude}, per_value_run_verified:false,
    note:variable==='sunshine_duration'?'Provider-derived sunshine, not daylight length or measured sunshine.':variable==='wind_gusts_10m'?'Modeled gust maxima, not a severe-thunderstorm probability.':'Raw member statistics, not calibrated confidence.' };
}
/** Daily envelope of wet intervals, not a claim of continuous rain or calibrated confidence. */
export function wetTiming(record, now=Date.now(), threshold=0.1) {
  const v=validateRecord(record), a=v.variables.precipitation;
  if(!a?.usable) return {status:'unavailable'};
  return {status:'derived', threshold_mm_per_hour:threshold, phase:'water equivalent; rain versus snow not inferred',
    method:'Per member, first/last wet interval and wettest 3-hour block inside each day. All days include dry members in occurrence fraction. Timing ranges condition on wet members. Separate rounds can share one envelope. Boundary-censored ends are not cessation forecasts.',
    confidence_score:null, calibrated_probability:false,
    days:[0,1,2].map(d=>{
      const date=addDate(localParts(now).date,d), start=boundary(date,0), end=boundary(addDate(date,1),0);
      const idx=[]; for(let t=start+H;t<=end;t+=H) idx.push(v.timestamps.indexOf(t));
      if(idx.some(i=>i<0)||a.arrays.some(x=>idx.some(i=>!finite(x[i])))) return {date,status:'incomplete'};
      const first=[],last=[],peak=[],totals=[]; let censoredStart=0,censoredEnd=0,multiple=0;
      for(const row of a.arrays){const x=idx.map(i=>row[i]); totals.push(x.reduce((p,c)=>p+c,0)); const wet=x.map((n,i)=>n>=threshold?i:-1).filter(i=>i>=0); if(!wet.length)continue;
        first.push(start+wet[0]*H); last.push(start+(wet.at(-1)+1)*H); censoredStart+=wet[0]===0; censoredEnd+=wet.at(-1)===23;
        multiple+=wet.some((i,j)=>j>0&&i-wet[j-1]>2); const sums=x.slice(0,-2).map((_,i)=>x[i]+x[i+1]+x[i+2]); peak.push(start+sums.indexOf(Math.max(...sums))*H);
      }
      const timing=values=>{if(!values.length)return null; const s=stats(values,values.length);return {p10_utc:iso(s.p10),median_utc:iso(s.median),p90_utc:iso(s.p90),conditional_members:s.n};};
      return {date,timezone:'America/New_York',status:'derived',wet_members:first.length,total_members:a.arrays.length,raw_wet_fraction:first.length/a.arrays.length,
        first_wet_interval_start:timing(first),last_wet_interval_end:timing(last),wettest_3h_block_start:timing(peak),
        starts_before_day_not_excluded_members:censoredStart,ends_after_day_not_excluded_members:censoredEnd,members_with_separate_rounds:multiple,
        amount_24h_mm:stats(totals,a.arrays.length)};
    })};
}
function ringContains(r,p){let inside=false;for(let i=0,j=r.length-1;i<r.length;j=i++){const[a,b]=r[i],[c,d]=r[j];const cross=(p[0]-a)*(d-b)-(p[1]-b)*(c-a);if(Math.abs(cross)<1e-9&&p[0]>=Math.min(a,c)&&p[0]<=Math.max(a,c)&&p[1]>=Math.min(b,d)&&p[1]<=Math.max(b,d))return true;if(((b>p[1])!==(d>p[1]))&&(p[0]<(c-a)*(p[1]-b)/(d-b)+a))inside=!inside;}return inside;}
export function contains(g,p=[TARGET.longitude,TARGET.latitude]){const poly=r=>r.length&&ringContains(r[0],p)&&!r.slice(1).some(h=>ringContains(h,p));if(g?.type==='Polygon')return poly(g.coordinates);if(g?.type==='MultiPolygon')return g.coordinates.some(poly);return false;}
export function productTime(value){if(typeof value!=='string')return null;let s=value.trim();if(/^\d{12}$/.test(s))s=s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8)+'T'+s.slice(8,10)+':'+s.slice(10,12)+'Z';else if(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s))s=s.replace(' ','T')+'Z';const t=Date.parse(s);return Number.isFinite(t)?t:null;}
export function outlook(raw,now=Date.now()){
  if(raw?.type!=='FeatureCollection'||!Array.isArray(raw.features)||raw.exceededTransferLimit)throw new Error('Incomplete outlook geometry');
  const versions=raw.features.map(f=>{const p=f.properties??{};return{issue:productTime(p.ISSUE??p.issue_time),start:productTime(p.VALID??p.start_time),end:productTime(p.EXPIRE??p.end_time)};});
  if(!versions.length||versions.some(t=>t.issue===null||t.start===null||t.end===null||t.issue>now+300000||t.end<=now||t.end<=t.start))return{status:'validity_unverified_or_stale',applicable_categories:null};
  const matching=raw.features.filter(f=>contains(f.geometry)).map(f=>f.properties);
  return{status:'validated',periods:versions.filter((x,i,a)=>a.findIndex(y=>JSON.stringify(x)===JSON.stringify(y))===i).map(t=>({issued_utc:iso(t.issue),start_utc:iso(t.start),end_utc:iso(t.end)})),
    applicable_categories:matching,match_count:matching.length,
    interpretation:matching.length?'Official area outlook applies at configured point; not an active warning or property-level probability.':'Point outside displayed risk areas for these valid periods; this does not establish zero risk.'};
}
async function attempt(id,url,parser,options){const r=await acquire(url,options);if(r.status==='received'){try{r.data=parser(r.raw);r.status=r.data?.status??'validated';}catch(e){r.status='parse_failed';r.error=String(e.message);}}return{id,...r};}
export async function enrich(base,now=Date.now()){
  const output={schema:'client-weather-supplement-v1',test_only:false,generated_at_utc:iso(now),base_capture_saved_at_utc:base.saved_at_utc,
    expires_at_utc:iso(now+90*60000),sources:[],rain_timing:[],rule:'Check every source issue/valid/observation time. Cached alerts never replace a fresh official warning check. Missing data is not clear weather or good air. Artifact access is not privacy in a public repository.'};
  for(const record of base.records??[]){try{output.rain_timing.push({model:record.requested_model,received_at_utc:record.received_at_utc,...wetTiming(record,now)});}catch(e){output.rain_timing.push({model:record.requested_model,status:'unavailable',error:e.message});}}
  for(const model of Object.keys(MODELS))for(const variable of Object.keys(EXTRA))output.sources.push(await attempt(`${model}:${variable}`,forecastURL(model,{variables:[variable]}),r=>validateExtra(r,model,variable,now)));
  const coord=`${TARGET.latitude},${TARGET.longitude}`;
  const point=await attempt('nws-point',`https://api.weather.gov/points/${coord}`,r=>{if(!r.properties?.forecastHourly)throw new Error('No forecast grid');return r.properties;});output.sources.push(point);
  if(point.data){for(const [id,key] of [['nws-hourly','forecastHourly'],['nws-forecast','forecast'],['nws-grid','forecastGridData']])if(point.data[key])output.sources.push(await attempt(id,point.data[key],r=>{if(!r.properties)throw new Error('No forecast properties');return r.properties;}));}
  output.sources.push(await attempt('nws-alerts',`https://api.weather.gov/alerts/active?point=${encodeURIComponent(coord)}`,r=>{if(!Array.isArray(r.features)||r.pagination?.next)throw new Error('Incomplete alert response');return{status:'validated_at_retrieval',features:r.features,source_updated:r.updated??null,requires_fresh_read_for_warning_advice:true};}));
  for(let day=1;day<=3;day++){
    output.sources.push(await attempt(`spc-day${day}`,`https://www.spc.noaa.gov/products/outlook/day${day}otlk_cat.lyr.geojson`,r=>outlook(r,now)));
    const q=new URL(`https://mapservices.weather.noaa.gov/vector/rest/services/hazards/wpc_precip_hazards/MapServer/${day-1}/query`);q.search=new URLSearchParams({where:'1=1',outFields:'*',outSR:'4326',returnGeometry:'true',f:'geojson'});
    output.sources.push(await attempt(`wpc-day${day}`,q.href,r=>outlook(r,now)));
  }
  output.sources.push(await attempt('airnow-reporting-areas','https://files.airnowtech.org/airnow/today/reportingarea.dat',r=>({status:'received_requires_format_validation',header_preview:r.split(/\r?\n/).slice(0,8)}),{text:true}));
  const air=new URL('https://air-quality-api.open-meteo.com/v1/air-quality');air.search=new URLSearchParams({latitude:String(TARGET.latitude),longitude:String(TARGET.longitude),domains:'cams_global',hourly:'us_aqi,pm2_5,ozone',forecast_days:'4',timezone:'UTC'});
  output.sources.push(await attempt('cams-global',air.href,r=>{if(r.utc_offset_seconds!==0||!r.hourly?.time||!finite(r.latitude)||kmBetween(TARGET,r)>70)throw new Error('Wrong air-quality location/time');const expected={us_aqi:'USAQI',pm2_5:'μg/m³',ozone:'μg/m³'};for(const[k,u]of Object.entries(expected))if(!Array.isArray(r.hourly[k])||r.hourly[k].length!==r.hourly.time.length||r.hourly[k].some(x=>!finite(x)||x<0)||r.hourly_units[k]!==u)throw new Error(`Invalid air variable ${k}`);return{status:'validated_model_only',hourly:r.hourly,hourly_units:r.hourly_units,sampled_coordinates:{latitude:r.latitude,longitude:r.longitude},note:'CAMS model prediction via Open-Meteo, not an observed AirNow NowCast. AQI methods/averaging periods differ; no exact clean-air guarantee.'};}));
  return output;
}
export async function main(){const base=JSON.parse(await fs.readFile('_evidence/capture.json','utf8'));
  if(base.capture_schema!=='philly-ensemble-collector-v1'||base.execution_location!=='github_actions_once')throw new Error('Not a production collection');
  let extra;
  try{extra=await enrich(base);}catch(e){extra={schema:'client-weather-supplement-v1',generated_at_utc:iso(Date.now()),status:'failed',error:e.message,sources:[]};}
  await fs.writeFile('_evidence/supplement.json',JSON.stringify(extra));
  const receipt={schema:extra.schema,generated_at_utc:extra.generated_at_utc,base_capture_saved_at_utc:base.saved_at_utc,expires_at_utc:extra.expires_at_utc??null,
    full_data_published:false,sources:extra.sources.map(s=>({id:s.id,status:s.status})),note:'Additional source evidence is retained as a workflow artifact. No new location metadata is published here.'};
  await fs.writeFile('_site/supplement-status.json',JSON.stringify(receipt));console.log(JSON.stringify(receipt));}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();

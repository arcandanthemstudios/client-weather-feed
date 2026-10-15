/** Normalize source data only after its actual fields and time semantics are checked. */
import { promises as fs } from 'node:fs';
import { TARGET, iso, parseUTC, kmBetween, localParts, boundary, addDate } from './core.mjs';
import { wetTiming } from './supplement.mjs';
const H=3600000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const CATEGORIES=['Good','Moderate','Unhealthy for Sensitive Groups','Unhealthy','Very Unhealthy','Hazardous'];
function sourceDate(s){const m=/^(\d{2})\/(\d{2})\/(\d{2})$/.exec(s);if(!m)return null;const out=`20${m[3]}-${m[1]}-${m[2]}`;const d=new Date(`${out}T00:00Z`);return Number.isFinite(+d)&&d.toISOString().slice(0,10)===out?out:null;}
/** Published reportingarea.dat columns, verified against the acquired official file. */
export function airNow(text,now=Date.now()){
 const parsed=[];
 for(const line of text.split(/\r?\n/)){
  const f=line.split('|'); if(f.length!==17)continue;
  const issued=sourceDate(f[0]),day=sourceDate(f[1]),latitude=Number(f[9]),longitude=Number(f[10]);
  if(!issued||!day||!['O','F','Y'].includes(f[5])||!f[9]||!f[10]||!finite(latitude)||!finite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180||!CATEGORIES.includes(f[13]))continue;
  const n=f[12].trim()===''?null:Number(f[12]); const aqi=finite(n)&&n>=0&&n<=1000?n:null;
  parsed.push({issued_date:issued,valid_date:day,hour:f[2],timezone:f[3],kind:f[5],primary:f[6]==='Y',reporting_area:f[7],state:f[8],latitude,longitude,pollutant:f[11],aqi,category:f[13],action_day:f[14],discussion:f[15],agency:f[16],raw_line:line});
 }
 if(!parsed.length)throw new Error('No valid AirNow rows; do not guess column meanings');
 const closest=parsed.map(r=>({...r,distance_km:kmBetween(TARGET,r)})).sort((a,b)=>a.distance_km-b.distance_km)[0];
 if(closest.distance_km>40)throw new Error('No nearby reporting area');
 const rows=parsed.filter(r=>r.reporting_area===closest.reporting_area&&r.state===closest.state);
 const offsets={EDT:-4,EST:-5,CDT:-5,CST:-6,MDT:-6,MST:-7,PDT:-7,PST:-8,UTC:0,GMT:0};
 const observations=rows.filter(r=>r.kind==='O').map(r=>{const m=/^(\d\d):(\d\d)$/.exec(r.hour);const offset=offsets[r.timezone];
  const t=m&&offset!==undefined&&+m[1]<=23&&+m[2]<=59?Date.parse(`${r.valid_date}T${r.hour}:00Z`)-offset*H:NaN;
  return{...r,observed_at_utc:Number.isFinite(t)?iso(t):null,current_eligible:Number.isFinite(t)&&now-t>=-300000&&now-t<=3*H};});
 const fresh=observations.filter(r=>r.current_eligible&&r.aqi!==null);const latest=fresh.length?Math.max(...fresh.map(r=>Date.parse(r.observed_at_utc))):null;
 const sameHour=fresh.filter(r=>Date.parse(r.observed_at_utc)===latest);const current=sameHour.sort((a,b)=>b.aqi-a.aqi)[0]??null;
 const today=localParts(now).date;
 const forecasts=rows.filter(r=>r.kind==='F'&&r.valid_date>=today&&r.valid_date<=addDate(today,2)&&r.issued_date<=today).sort((a,b)=>b.issued_date.localeCompare(a.issued_date)).filter((r,i,a)=>a.findIndex(x=>x.valid_date===r.valid_date&&x.pollutant===r.pollutant)===i);
 const clean=r=>{if(!r)return null;const{raw_line,latitude,longitude,...safe}=r;return safe;};
 return{status:current?'validated_reporting_area':forecasts.length?'forecast_only':'stale_or_unavailable',
  selection:'Nearest reporting-area centroid, not a ZIP-to-area lookup or monitor inside the target ZIP.',reporting_area:closest.reporting_area,state:closest.state,distance_km:closest.distance_km,
  current:clean(current),observations:observations.map(clean),forecasts:forecasts.map(clean),issue_clock_time_reported:false,
  current_note:'Area-level AirNow current observation; not final daily AQI or a measurement at the target point. Forecasts are from the named state/local agency.',
  retained_source_lines:rows.map(r=>r.raw_line)};
}
export function nwsForecast(raw,now=Date.now()){
 const p=raw?.properties;
 if(!p)throw new Error('Missing NWS forecast properties');
 const issued=Date.parse(p.updateTime);
 const valid=/^([^/]+)\/P/.exec(p.validTimes??'');
 if(!Number.isFinite(issued)||!valid||issued>now+300000)return{status:'source_time_unverified',properties:p};
 const age=(now-issued)/H;
 return{status:age>18?'stale_forecast':'validated_forecast',source_updated_utc:iso(issued),source_valid_times:p.validTimes,
  generated_at_source:p.generatedAt??null,issue_age_hours:age,properties:p,
  caveat:'Inspect field-specific valid intervals and units. Source update is not download time. A grid cell is not a street observation.'};
}
export function liquidRainTiming(source,now=Date.now()){
 if(source.data?.status!=='validated'||!source.id.endsWith(':rain'))return null;
 const model=source.id.split(':')[0],raw=source.raw,hourly={time:raw.hourly.time},hourly_units={time:raw.hourly_units.time};
 for(const[k,a]of Object.entries(raw.hourly))if(k==='rain'||/^rain_member\d+$/.test(k)){const dest=k.replace(/^rain/,'precipitation');hourly[dest]=a;hourly_units[dest]=raw.hourly_units[k];}
 const r={requested_model:model,http_status:source.http_status,received_at_utc:source.received_at_utc,requested_coordinates:[TARGET.latitude,TARGET.longitude],raw_response:{...raw,hourly,hourly_units}};
 return{model,received_at_utc:source.received_at_utc,...wetTiming(r,now),phase:'Liquid rain from the separately requested provider rain field; not total snow-plus-rain water equivalent.',source_field:'rain'};
}
export function finalize(extra,now=Date.now()){
 for(const source of extra.sources??[]){
  try{
   if(source.id==='airnow-reporting-areas'&&typeof source.raw==='string'){
    source.data=airNow(source.raw,now); source.raw=source.data.retained_source_lines.join('\n');delete source.data.retained_source_lines;source.status=source.data.status;
   }
   if(['nws-hourly','nws-forecast','nws-grid'].includes(source.id)&&source.raw){source.data=nwsForecast(source.raw,now);source.status=source.data.status;}
   if(source.id==='cams-global'&&source.raw?.hourly){const r=source.raw,t=r.hourly.time.map(parseUTC);const end=boundary(addDate(localParts(now).date,3),6);
    if(t.some((x,i)=>i&&x-t[i-1]!==H)||t.at(-1)<end||t[0]>now)throw new Error('Incomplete CAMS time coverage');
    source.data.model_initialization_verified=false;source.data.coverage_start_utc=iso(t[0]);source.data.coverage_end_utc=iso(t.at(-1));
   }
  }catch(e){source.status='parse_failed';source.error=e.message;delete source.data;}
 }
 extra.liquid_rain_timing=(extra.sources??[]).map(s=>{try{return liquidRainTiming(s,now);}catch{return null;}}).filter(Boolean);
 extra.normalizer_version='source-checks-v1';extra.completed_at_utc=iso(now);
 return extra;
}
export async function main(){const path='_evidence/supplement.json';const extra=finalize(JSON.parse(await fs.readFile(path,'utf8')));await fs.writeFile(path,JSON.stringify(extra));
 const receipt={schema:extra.schema,generated_at_utc:extra.generated_at_utc,completed_at_utc:extra.completed_at_utc,expires_at_utc:extra.expires_at_utc,
  normalizer_version:extra.normalizer_version,full_data_published:false,sources:extra.sources.map(s=>({id:s.id,status:s.status})),note:'Additional evidence is retained in the workflow artifact; public geography and request URLs remain omitted.'};
 await fs.writeFile('_site/supplement-status.json',JSON.stringify(receipt));console.log(JSON.stringify(receipt));}

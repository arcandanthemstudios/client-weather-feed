"""Bounded, fixed-origin ECMWF evidence acquisition. No forecast correction here.

Read one JSON request on stdin. Return decoded GRIB samples and per-interval
errors on stdout. ecCodes is installed by the workflow, not downloaded at runtime.
"""
from __future__ import annotations
import datetime as dt
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sys
import time
import urllib.request
import urllib.error

ORIGIN = 'https://storage.googleapis.com/ecmwf-open-data/'
MAX_INTERVALS = 8
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('ECMWF redirect refused')

def timestamp(value):
    if not isinstance(value, str) or not value.endswith('Z'):
        raise ValueError('UTC ISO timestamp required')
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))

def source_base(run, step):
    if run.hour not in (0, 6, 12, 18) or run.minute or run.second or run.microsecond:
        raise ValueError('Invalid initialization')
    if type(step) is not int or step < 3 or step > 144 or step % 3:
        raise ValueError('Only native three-hour intervals through step 144 are supported')
    return f'{ORIGIN}{run:%Y%m%d}/{run:%H}z/ifs/0p25/enfo/{run:%Y%m%d%H}0000-{step}h-enfo-ef'

def select_index(data, run, step, member):
    matches = []
    for line in data.decode('utf-8').splitlines():
        row = json.loads(line)
        if (str(row.get('param')) == 'tp' and str(row.get('levtype')) == 'sfc' and
            str(row.get('stream')) == 'enfo' and str(row.get('date')) == run.strftime('%Y%m%d') and
            str(row.get('time')).zfill(4) == run.strftime('%H%M') and str(row.get('step')) == str(step) and
            ((member == 0 and row.get('type') == 'cf' and str(row.get('number', '0')) == '0') or
             (member > 0 and row.get('type') == 'pf' and str(row.get('number')) == str(member)))):
            matches.append(row)
    if len(matches) != 1:
        raise ValueError('Missing or duplicate exact member/step index record')
    row = matches[0]
    if type(row.get('_offset')) is not int or row['_offset'] < 0 or type(row.get('_length')) is not int or not 16 <= row['_length'] <= MAX_FILE_BYTES:
        raise ValueError('Invalid or oversized GRIB byte range')
    return row

def decode_grib(data, latitude, longitude):
    import eccodes as ec
    if len(data) < 20 or data[:4] != b'GRIB' or data[7] != 2 or int.from_bytes(data[8:16], 'big') != len(data) or data[-4:] != b'7777':
        raise ValueError('Expected exactly one complete GRIB2 message')
    gid = ec.codes_new_from_message(data)
    try:
        get = lambda k: ec.codes_get(gid, k)
        nearest = ec.codes_grib_find_nearest(gid, latitude, longitude, npoints=1)[0]
        if abs(nearest['lat'] - latitude) > 1e-7 or abs((nearest['lon'] - longitude + 180) % 360 - 180) > 1e-7:
            raise ValueError('GRIB grid point does not match API sample')
        if get('iDirectionIncrementInDegrees') != 0.25 or get('jDirectionIncrementInDegrees') != 0.25:
            raise ValueError('Unexpected grid spacing')
        member = int(get('number')) if ec.codes_is_defined(gid, 'number') else (0 if get('dataType') == 'cf' else -1)
        def date_at(date, hour):
            return dt.datetime.strptime(f'{int(get(date)):08d}{int(get(hour)):04d}', '%Y%m%d%H%M').replace(tzinfo=dt.timezone.utc).isoformat().replace('+00:00', 'Z')
        return {k: get(k) for k in ['paramId', 'units', 'shortName', 'startStep', 'endStep', 'gridType', 'packingType', 'bitsPerValue', 'binaryScaleFactor', 'decimalScaleFactor']} | {
            'member_id': member, 'initialization_utc': date_at('dataDate', 'dataTime'),
            'valid_utc': date_at('validityDate', 'validityTime'),
            'latitude': nearest['lat'], 'longitude': nearest['lon'], 'grid_spacing_degrees': 0.25,
            'accumulation_mm': float(nearest['value']) * 1000,
            'packing_error_mm': float(get('packingError')) * 1000,
            'sha256': hashlib.sha256(data).hexdigest(), 'decoder_version': ec.codes_get_api_version()}
    finally:
        ec.codes_release(gid)

class Downloader:
    def __init__(self):
        self.opener = urllib.request.build_opener(NoRedirect)
        self.deadline = time.monotonic() + 50
        self.total = 0
        self.cache = {}
    def get(self, url, byte_range=None):
        if not re.fullmatch(r'https://storage\.googleapis\.com/ecmwf-open-data/\d{8}/(?:00|06|12|18)z/ifs/0p25/enfo/\d{14}-\d+h-enfo-ef\.(?:index|grib2)', url):
            raise ValueError('Unapproved ECMWF source URL')
        remaining = self.deadline - time.monotonic()
        if remaining <= 0 or self.total >= MAX_TOTAL_BYTES:
            raise ValueError('Precision evidence acquisition budget exhausted')
        headers = {'Accept-Encoding': 'identity', 'User-Agent': 'Client-weather-precision-audit/1.0'}
        if byte_range:
            start, size = byte_range
            headers['Range'] = f'bytes={start}-{start + size - 1}'
        try:
            response = self.opener.open(urllib.request.Request(url, headers=headers), timeout=min(8, remaining))
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                self.deadline = 0  # Do not make more requests after provider rate limiting.
            raise
        with response:
            if response.status != (206 if byte_range else 200):
                raise ValueError('Expected exact partial content, not a full model download')
            if byte_range:
                match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
                if not match or tuple(map(int, match.groups()[:2])) != (start, start + size - 1) or int(match.group(3)) <= start + size - 1:
                    raise ValueError('Mismatched GRIB Content-Range')
            limit = min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - self.total)
            data = response.read(limit + 1)
            self.total += len(data)
            if len(data) > limit or (byte_range and len(data) != size):
                raise ValueError('Oversized or truncated source data')
            return data
    def sample(self, run, step, member, latitude, longitude):
        base = source_base(run, step)
        if base not in self.cache:
            self.cache[base] = self.get(base + '.index')
        row = select_index(self.cache[base], run, step, member)
        data = self.get(base + '.grib2', (row['_offset'], row['_length']))
        sample = decode_grib(data, latitude, longitude)
        sample.update(source_url=base + '.grib2', byte_offset=row['_offset'], byte_length=row['_length'],
                      index_sha256=hashlib.sha256(self.cache[base]).hexdigest())
        # Global GRIB fields, not personal records; retained only beside existing raw evidence.
        dest = Path('_evidence/ecmwf-precision')
        dest.mkdir(parents=True, exist_ok=True)
        (dest / (sample['sha256'] + '.grib2')).write_bytes(data)
        return sample

def run_request(request, downloader=None):
    run = timestamp(request['initialization_utc'])
    lat, lon = request['latitude'], request['longitude']
    if not all(type(x) in (int, float) and math.isfinite(x) for x in (lat, lon)) or not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise ValueError('Invalid grid coordinate')
    candidates = request['intervals']
    if not isinstance(candidates, list) or len(candidates) > MAX_INTERVALS:
        raise ValueError('Too many precision intervals')
    downloader = downloader or Downloader()
    result = []
    for entry in candidates:
        item = {'member_id': entry.get('member_id'), 'valid_utc': entry.get('valid_utc')}
        try:
            member = entry['member_id']
            if type(member) is not int or not 0 <= member <= 50:
                raise ValueError('Invalid ensemble member')
            step = (timestamp(entry['valid_utc']) - run).total_seconds() / 3600
            if not step.is_integer() or not 6 <= step <= 144 or int(step) % 3:
                raise ValueError('No supported matching run interval')
            item['previous'] = downloader.sample(run, int(step) - 3, member, lat, lon)
            item['current'] = downloader.sample(run, int(step), member, lat, lon)
        except Exception as exc:
            item['error'] = type(exc).__name__ + ': ' + str(exc)[:160]
        result.append(item)
    return {'status': 'checked', 'intervals': result}

if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError('Oversized precision request')
        print(json.dumps(run_request(json.loads(raw)), allow_nan=False))
    except Exception as exc:
        print(json.dumps({'status': 'unavailable', 'intervals': [], 'error': type(exc).__name__ + ': ' + str(exc)[:160]}))

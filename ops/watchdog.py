#!/usr/bin/env python3
"""External bounded starter/checker. Standard library only. No weather or user notifications.

The sole remote write is workflow_dispatch for the configured collector on main.
A dispatch acceptance, green job, or ZIP download is not a validated collection.
This program never creates a report-consumption receipt.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

UTC = timezone.utc
EASTERN = ZoneInfo('America/New_York')
WORKFLOW = '.github/workflows/weather.yml'
MEMBERS = {'ecmwf_ifs025_ensemble': 51, 'cmc_gem_geps': 21}
UNITS = {'temperature_2m': '°C', 'precipitation': 'mm', 'wind_speed_10m': 'm/s'}
MAX_ZIP = 5 * 1024 * 1024
MAX_UNPACKED = 25 * 1024 * 1024
ACTIVE = {'queued', 'in_progress', 'waiting', 'requested', 'pending'}


def stamp(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError('Missing timestamp')
    dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None or dt.utcoffset() != timedelta(0):
        raise ValueError('Expected explicitly UTC timestamp')
    return dt.astimezone(UTC)


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace('+00:00', 'Z')


def reject_constant(value: str):
    raise ValueError('Non-finite JSON constant')


def loads(raw: bytes):
    return json.loads(raw.decode('utf-8'), parse_constant=reject_constant)


def phase_at(now: datetime):
    """Use local wall clock, including DST; late executions never invent earlier checks."""
    local = now.astimezone(EASTERN)
    if local.hour not in (5, 11, 17):
        return None
    stage = next((name for low, high, name in ((15, 25, 'start'), (35, 45, 'recover'), (50, 60, 'verify'))
                  if low <= local.minute < high), None)
    if stage is None:
        return None
    deadline = local.replace(hour=local.hour + 1, minute=0, second=0, microsecond=0).astimezone(UTC)
    return {'stage': stage, 'deadline': deadline, 'slot': iso(deadline)}


def expected_target() -> tuple[float, float]:
    # Reuse existing configuration; do not introduce another public location label/file.
    source = (Path(__file__).resolve().parents[1] / 'src/core.mjs').read_text()
    match = re.search(r'TARGET\s*=\s*Object\.freeze\(\{\s*latitude:\s*([-\d.]+),\s*longitude:\s*([-\d.]+)', source)
    if not match:
        raise ValueError('Existing target configuration changed; inspect before proceeding')
    return tuple(map(float, match.groups()))


def distance_km(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(min(1, math.sqrt(h)))


def finite(value):
    return type(value) in (float, int) and math.isfinite(value)


def read_package(archive: bytes) -> dict:
    if len(archive) > MAX_ZIP:
        raise ValueError('Archive exceeds download budget')
    output = {}
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        entries = z.infolist()
        if len(entries) > 12 or sum(x.file_size for x in entries) > MAX_UNPACKED:
            raise ValueError('Archive exceeds expansion budget')
        seen = set()
        for info in entries:
            p = PurePosixPath(info.filename)
            if p.is_absolute() or '..' in p.parts or '\\' in info.filename or ((info.external_attr >> 16) & 0o170000) == 0o120000:
                raise ValueError('Unsafe ZIP path or symlink')
            if info.filename in seen:
                raise ValueError('Duplicate archive filename')
            seen.add(info.filename)
            if info.filename in ('capture.json', 'validated.json', 'supplement.json', 'collection-receipt.json'):
                output[info.filename] = loads(z.read(info))
    if not {'capture.json', 'validated.json'}.issubset(output):
        raise ValueError('Missing base artifact files')
    return output


def inspect_package(archive: bytes, now: datetime, deadline: datetime, target) -> dict:
    files = read_package(archive)
    capture, feed = files['capture.json'], files['validated.json']
    if capture.get('capture_schema') != 'philly-ensemble-collector-v1' or capture.get('execution_location') != 'github_actions_once':
        raise ValueError('Unexpected capture schema/origin')
    if feed.get('schema') != 'philly-ensemble-pages-v1' or feed.get('test_only') is not False or capture.get('test_only') is True:
        raise ValueError('Unexpected/test-only validated data')
    saved, built = stamp(capture['saved_at_utc']), stamp(feed['generated_at_utc'])
    if saved > now + timedelta(minutes=5) or built > now + timedelta(minutes=5) or abs((saved - built).total_seconds()) > 300:
        raise ValueError('Capture/build timestamp mismatch')
    if feed.get('summary', {}).get('source_capture_saved_at_utc') != capture['saved_at_utc']:
        raise ValueError('Summary belongs to another capture')
    records = capture.get('records', [])
    ids = [r.get('requested_model') for r in records]
    if len(set(ids)) != len(ids) or set(ids) != set(MEMBERS):
        raise ValueError('Missing/duplicate/unapproved model')
    end_local = deadline.astimezone(EASTERN).replace(hour=6, minute=0, second=0, microsecond=0) + timedelta(days=3)
    required_end = end_local.astimezone(UTC)
    receipts, checks = [], []
    for record in records:
        model = record['requested_model']
        check = {'model': model, 'numerical_content_validated': False, 'reason': None}
        try:
            received = stamp(record['received_at_utc'])
            if received > now + timedelta(minutes=5):
                raise ValueError('Future receipt')
            receipts.append(received)
            if record.get('http_status') != 200:
                raise ValueError('Numerical request failed')
            coords = record.get('requested_coordinates', [])
            if len(coords) != 2 or any(not finite(v) for v in coords) or any(abs(a - b) > 1e-6 for a, b in zip(coords, target)):
                raise ValueError('Different requested target')
            raw = record['raw_response']
            if raw.get('error') or raw.get('utc_offset_seconds') != 0 or raw.get('timezone') not in ('UTC', 'GMT', 'Etc/UTC'):
                raise ValueError('Invalid response/timezone')
            echo = raw.get('model', raw.get('models'))
            if echo is not None and echo not in (model, [model]):
                raise ValueError('Model identity mismatch')
            grid = (raw.get('latitude'), raw.get('longitude'))
            if any(not finite(x) for x in grid) or abs(grid[0]) > 90 or abs(grid[1]) > 180 or distance_km(target, grid) > 40:
                raise ValueError('Invalid spatial support')
            hourly, units = raw['hourly'], raw['hourly_units']
            if units.get('time') not in ('iso8601', 'unixtime'):
                raise ValueError('Unknown time units')
            times = [datetime.fromtimestamp(t, UTC) if finite(t) else stamp(t if t.endswith(('Z', '+00:00')) else t + 'Z') for t in hourly['time']]
            if not times or len(times) > 250 or any(b - a != timedelta(hours=1) for a, b in zip(times, times[1:])):
                raise ValueError('Nonconsecutive or excessive time axis')
            required = []
            t = deadline.replace(minute=0, second=0, microsecond=0)
            while t <= required_end:
                required.append(t)
                t += timedelta(hours=1)
            index = {t: i for i, t in enumerate(times)}
            if any(t not in index for t in required):
                raise ValueError('Forecast does not cover report through final following night')
            for variable, unit in UNITS.items():
                members = {}
                for key, values in hourly.items():
                    if key == variable:
                        member = 0
                    elif key.startswith(variable + '_member'):
                        suffix = key[len(variable + '_member'):]
                        if not suffix.isdecimal():
                            raise ValueError('Malformed member identity')
                        member = int(suffix)
                    else:
                        continue
                    if member in members:
                        raise ValueError('Duplicate logical member')
                    if units.get(key) != unit or not isinstance(values, list) or len(values) != len(times):
                        raise ValueError('Member units/array length mismatch')
                    if any(v is not None and not finite(v) for v in values):
                        raise ValueError('Non-numeric model value')
                    if variable != 'temperature_2m' and any(finite(v) and v < 0 for v in values):
                        raise ValueError('Negative interval/wind value')
                    if any(not finite(values[index[t]]) for t in required):
                        raise ValueError('Missing required future numerical values')
                    members[member] = values
                if set(members) != set(range(MEMBERS[model])):
                    raise ValueError('Incomplete member set')
            meta = next((m.get('metadata', {}) for m in feed['summary'].get('models', []) if m.get('model') == model), {})
            if meta.get('status') in ('provider_metadata_stale', 'invalid_or_future_metadata', 'metadata_changed_during_fetch', 'provider_update_still_propagating'):
                raise ValueError('Provider metadata guard requires review')
            check.update(numerical_content_validated=True, received_at_utc=iso(received),
                         coverage_end_utc=iso(times[-1]), api_series_count=MEMBERS[model])
        except (ValueError, KeyError, TypeError, OverflowError) as exc:
            check['reason'] = str(exc)
        checks.append(check)
    fresh_until = min(receipts) + timedelta(minutes=90) if len(receipts) == 2 else None
    declared = feed.get('acquisition_fresh_until_utc', feed.get('expires_at_utc'))
    if declared is not None and fresh_until and abs((stamp(declared) - fresh_until).total_seconds()) > 1:
        raise ValueError('Declared acquisition deadline differs from actual oldest receipt')
    base_ready = all(x['numerical_content_validated'] for x in checks) and bool(fresh_until and fresh_until >= max(now, deadline))
    supplement = files.get('supplement.json')
    supplement_matches = bool(supplement and supplement.get('schema') == 'client-weather-supplement-v1' and
        supplement.get('test_only') is False and supplement.get('base_capture_saved_at_utc') == capture['saved_at_utc'] and
        supplement.get('normalizer_version') == 'source-checks-v1')
    source_list = supplement.get('sources', []) if supplement_matches else []
    if not isinstance(source_list, list):
        supplement_matches, source_list = False, []
    source_ids = [s.get('id') for s in source_list if isinstance(s, dict)]
    if len(source_ids) != len(set(source_ids)):
        supplement_matches, source_list = False, []
    components = {s['id']: s.get('status', 'unverified') for s in source_list if isinstance(s, dict) and isinstance(s.get('id'), str)}
    core_gaps = [x for x in ('nws-hourly', 'nws-forecast') if components.get(x) != 'validated_forecast']
    # Status is a retrieval receipt, NOT source-level use authorization or current warning advice.
    return {'schema': 'collector-check-v1', 'base_ready_for_slot': base_ready,
            'core_retrieval_gaps': core_gaps, 'supplement_matches': supplement_matches,
            'supplement_statuses_at_collection': components, 'supplement_content_use_not_verified': True,
            'archive_sha256': hashlib.sha256(archive).hexdigest(), 'capture_saved_at_utc': iso(saved),
            'build_at_utc': iso(built), 'acquisition_fresh_until_utc': iso(fresh_until) if fresh_until else None,
            'report_slot_utc': iso(deadline), 'checked_at_utc': iso(now), 'models': checks,
            'delivered_before_slot': built <= deadline, 'report_consumption_verified': False}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHubAPI:
    def __init__(self, repository: str, token: str, target):
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or not token:
            raise ValueError('Repository and a securely configured Actions token are required')
        self.root = 'https://api.github.com/repos/' + repository
        self.token, self.target, self.budget = token, target, 30
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, url, *, method='GET', data=None, signed=False):
        self.budget -= 1
        if self.budget < 0:
            raise RuntimeError('Request budget exhausted')
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or parsed.username or parsed.password:
            raise ValueError('Unsafe delivery URL')
        if not signed and not url.startswith(self.root + '/'):
            raise ValueError('Unapproved API scope')
        if signed and not (parsed.hostname and (parsed.hostname.endswith('.blob.core.windows.net') or parsed.hostname.endswith('.actions.githubusercontent.com') or parsed.hostname.endswith('.githubusercontent.com'))):
            raise ValueError('Unapproved artifact delivery host')
        headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'client-weather-watchdog', 'X-GitHub-Api-Version': '2026-03-10'}
        if not signed:
            headers['Authorization'] = 'Bearer ' + self.token
        encoded = json.dumps(data).encode() if data is not None else None
        if encoded is not None:
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(url, data=encoded, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=12) as response:
                body = response.read(MAX_ZIP + 1)
                if len(body) > MAX_ZIP:
                    raise ValueError('Response exceeds download budget')
                return response.status, dict(response.headers), body
        except urllib.error.HTTPError as error:
            if error.code in (301, 302, 303, 307, 308) and method == 'GET':
                return error.code, dict(error.headers), b''
            # Do not print URLs, tokens, response bodies or retry past rate/auth controls.
            raise RuntimeError('GitHub HTTP ' + str(error.code)) from None

    def get(self, path):
        status, _, body = self.request(self.root + path)
        if status != 200:
            raise RuntimeError('Expected GitHub JSON response')
        return loads(body)

    def runs(self):
        result = []
        for page in range(1, 4):
            data = self.get('/actions/workflows/weather.yml/runs?branch=main&per_page=100&page=' + str(page))
            entries = data.get('workflow_runs', [])
            result.extend(entries)
            if len(result) >= data.get('total_count', 0) or len(entries) < 100:
                break
        else:
            raise RuntimeError('Run listing exceeds bounded complete coverage')
        return [r for r in result if r.get('path') == WORKFLOW and r.get('head_branch') == 'main']

    def head(self):
        return self.get('/git/ref/heads/main')['object']['sha']

    def inspect_run(self, run, now, deadline):
        data = self.get('/actions/runs/' + str(run['id']) + '/artifacts?name=collector-evidence&per_page=100')
        if data.get('total_count', 0) > 100:
            raise RuntimeError('Artifact list incomplete')
        artifacts = [a for a in data.get('artifacts', []) if a.get('name') == 'collector-evidence' and a.get('expired') is False]
        for artifact in sorted(artifacts, key=lambda a: a.get('created_at', ''), reverse=True)[:2]:
            if artifact.get('size_in_bytes', MAX_ZIP + 1) > MAX_ZIP:
                continue
            status, headers, body = self.request(self.root + '/actions/artifacts/' + str(artifact['id']) + '/zip')
            if status in (301, 302, 303, 307, 308):
                location = next((v for k, v in headers.items() if k.lower() == 'location'), None)
                status, _, body = self.request(location or '', signed=True)
            if status != 200:
                raise RuntimeError('Artifact download did not return ZIP bytes')
            digest = artifact.get('digest')
            if digest and digest != 'sha256:' + hashlib.sha256(body).hexdigest():
                raise ValueError('Artifact digest mismatch')
            result = inspect_package(body, now, deadline, self.target)
            result.update(run_id=run['id'], run_attempt=run.get('run_attempt'), head_sha=run['head_sha'], artifact_id=artifact['id'])
            return result
        return None

    def dispatch(self, slot):
        status, _, body = self.request(self.root + '/actions/workflows/weather.yml/dispatches', method='POST',
                                      data={'ref': 'main', 'inputs': {'collection_slot': slot}})
        if status not in (200, 204):
            raise RuntimeError('Dispatch was not accepted')
        data = loads(body) if body.strip() else {}
        return {'http_status': status, 'workflow_run_id': data.get('workflow_run_id'), 'accepted_not_completed': True}


def run_phase(now, api, *, check_only=False):
    phase = phase_at(now)
    if phase is None:
        return {'state': 'outside_approved_window', 'checked_at_utc': iso(now), 'remote_write': False}
    receipt = {'schema': 'collector-watchdog-v1', 'checked_at_utc': iso(now),
               'stage': phase['stage'], 'report_slot_utc': phase['slot'],
               'report_consumption_verified': False, 'remote_write': False, 'errors': []}
    runs, head = api.runs(), api.head()
    runs = sorted(runs, key=lambda r: r.get('created_at', ''), reverse=True)
    receipt['latest_attempt'] = {k: runs[0].get(k) for k in ('id', 'event', 'status', 'conclusion', 'created_at', 'head_sha')} if runs else None
    fresh = None
    for run in [r for r in runs if r.get('head_sha') == head and r.get('status') == 'completed'][:4]:
        try:
            check = api.inspect_run(run, now, phase['deadline'])
            if check and check['base_ready_for_slot']:
                fresh = check
                break
        except (RuntimeError, ValueError, KeyError, TypeError) as exc:
            receipt['errors'].append({'run_id': run['id'], 'error_type': type(exc).__name__})
    if fresh:
        receipt.update(state='base_ready' if not fresh['core_retrieval_gaps'] else 'base_ready_core_partial', collection=fresh)
        if not fresh['core_retrieval_gaps'] or phase['stage'] != 'recover':
            return receipt
    active = [r for r in runs if r.get('head_sha') == head and r.get('status') in ACTIVE and
              stamp(r['created_at']) >= phase['deadline'] - timedelta(hours=2)]
    if active:
        receipt.update(state='collection_running_or_queued', active_run_ids=[r['id'] for r in active])
        return receipt
    attempts = [r for r in runs if r.get('event') == 'workflow_dispatch' and
                r.get('display_title') == 'Refresh client weather feed [' + phase['slot'] + ']']
    if check_only or phase['stage'] == 'verify':
        receipt['state'] = 'base_ready_core_partial' if fresh else 'collection_missing_by_checkpoint'
        return receipt
    if len(attempts) >= 2 or (phase['stage'] == 'start' and attempts):
        receipt['state'] = 'retry_budget_exhausted'
        return receipt
    receipt.update(state='dispatch_accepted_not_completed', dispatch=api.dispatch(phase['slot']), remote_write=True)
    return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check-only', action='store_true', help='Never dispatch')
    args = parser.parse_args()
    now = datetime.now(UTC)
    if phase_at(now) is None:
        print(json.dumps({'state': 'outside_approved_window', 'checked_at_utc': iso(now)}))
        return
    try:
        api = GitHubAPI(os.environ.get('COLLECTOR_REPOSITORY', ''), os.environ.get('GITHUB_ACTIONS_TOKEN', ''), expected_target())
        result = run_phase(now, api, check_only=args.check_only)
    except Exception as error:
        # Structured operational failure, not a user notification or a fabricated ready state.
        result = {'schema': 'collector-watchdog-v1', 'state': 'check_failed', 'checked_at_utc': iso(now),
                  'error_type': type(error).__name__, 'report_consumption_verified': False}
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    main()

"""Controlled failure tests. Fixtures never enter the production feed."""
import copy
import io
import json
import unittest
import zipfile
from datetime import datetime, timedelta
from watchdog import UTC, MEMBERS, UNITS, iso, phase_at, inspect_package, read_package, run_phase

TARGET = (40.0, -75.0)  # Synthetic spatial fixture, not a user location.
NOW = datetime(2026, 10, 16, 9, 35, tzinfo=UTC)
DEADLINE = datetime(2026, 10, 16, 10, tzinfo=UTC)

def package():
    times = [iso(datetime(2026, 10, 15, tzinfo=UTC) + timedelta(hours=i)) for i in range(120)]
    records = []
    for model, count in MEMBERS.items():
        hourly, units = {'time': times}, {'time': 'iso8601'}
        for var, unit in UNITS.items():
            for member in range(count):
                key = var if member == 0 else var + '_member' + str(member).zfill(2)
                hourly[key] = [10.0 if var == 'temperature_2m' else 0.0] * len(times)
                units[key] = unit
        records.append({'requested_model': model, 'requested_coordinates': list(TARGET), 'received_at_utc': '2026-10-16T09:16:00Z',
                        'http_status': 200, 'raw_response': {'model': model, 'latitude': TARGET[0], 'longitude': TARGET[1],
                        'timezone': 'UTC', 'utc_offset_seconds': 0, 'hourly': hourly, 'hourly_units': units}})
    capture = {'capture_schema': 'philly-ensemble-collector-v1', 'execution_location': 'github_actions_once',
               'saved_at_utc': '2026-10-16T09:16:00Z', 'records': records}
    feed = {'schema': 'philly-ensemble-pages-v1', 'test_only': False, 'generated_at_utc': capture['saved_at_utc'],
            'expires_at_utc': '2026-10-16T10:46:00Z', 'summary': {'source_capture_saved_at_utc': capture['saved_at_utc'], 'models': []}}
    supplement = {'schema': 'client-weather-supplement-v1', 'test_only': False, 'normalizer_version': 'source-checks-v1',
                  'base_capture_saved_at_utc': capture['saved_at_utc'], 'sources': [
                      {'id': 'nws-hourly', 'status': 'validated_forecast'}, {'id': 'nws-forecast', 'status': 'validated_forecast'},
                      {'id': 'cmc_gem_geps:wind_gusts_10m', 'status': 'unavailable'}]}
    return {'capture.json': capture, 'validated.json': feed, 'supplement.json': supplement}

def zipped(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, value in files.items():
            z.writestr(name, json.dumps(value))
    return output.getvalue()

def run(id=1, state='completed', event='schedule', slot=None):
    return {'id': id, 'head_sha': 'fixture-sha', 'status': state, 'event': event, 'conclusion': 'success' if state == 'completed' else None,
            'created_at': '2026-10-16T09:16:00Z', 'display_title': 'Refresh client weather feed' + (' [' + slot + ']' if slot else '')}

class FakeAPI:
    def __init__(self, runs=None, result=None):
        self.entries, self.result, self.dispatched = runs or [], result, []
    def runs(self): return self.entries
    def head(self): return 'fixture-sha'
    def inspect_run(self, *args): return copy.deepcopy(self.result)
    def dispatch(self, slot):
        self.dispatched.append(slot)
        return {'http_status': 200, 'workflow_run_id': 99, 'accepted_not_completed': True}

class WatchdogTests(unittest.TestCase):
    def test_missed_start_is_recovered_but_not_called_complete(self):
        api = FakeAPI()
        result = run_phase(NOW, api)
        self.assertEqual(result['state'], 'dispatch_accepted_not_completed')
        self.assertEqual(api.dispatched, ['2026-10-16T10:00:00Z'])
        self.assertFalse(result['report_consumption_verified'])
    def test_start_is_not_repeated_for_same_slot(self):
        api = FakeAPI([run(event='workflow_dispatch', slot='2026-10-16T10:00:00Z')])
        result = run_phase(NOW.replace(minute=20), api)
        self.assertEqual(result['state'], 'retry_budget_exhausted')
        self.assertEqual(api.dispatched, [])
    def test_only_one_recovery_after_initial_attempt(self):
        api = FakeAPI([run(event='workflow_dispatch', slot='2026-10-16T10:00:00Z')])
        self.assertTrue(run_phase(NOW, api)['remote_write'])
        api.entries.append(run(2, event='workflow_dispatch', slot='2026-10-16T10:00:00Z'))
        self.assertEqual(run_phase(NOW, api)['state'], 'retry_budget_exhausted')
        self.assertEqual(len(api.dispatched), 1)
    def test_verify_records_miss_without_dispatch(self):
        api = FakeAPI()
        self.assertEqual(run_phase(NOW.replace(minute=50), api)['state'], 'collection_missing_by_checkpoint')
        self.assertFalse(api.dispatched)
    def test_running_or_queued_work_is_not_duplicated(self):
        for status in ('queued', 'in_progress'):
            api = FakeAPI([run(state=status)])
            self.assertEqual(run_phase(NOW, api)['state'], 'collection_running_or_queued')
            self.assertFalse(api.dispatched)
    def test_no_past_window_is_replayed(self):
        api = FakeAPI()
        self.assertEqual(run_phase(DEADLINE, api)['state'], 'outside_approved_window')
        self.assertFalse(api.dispatched)
    def test_dst_keeps_local_report_deadline(self):
        winter = phase_at(datetime(2026, 11, 2, 10, 15, tzinfo=UTC))
        summer = phase_at(datetime(2026, 10, 16, 9, 15, tzinfo=UTC))
        self.assertEqual(winter['slot'], '2026-11-02T11:00:00Z')
        self.assertEqual(summer['slot'], '2026-10-16T10:00:00Z')
        self.assertIsNone(phase_at(datetime(2026, 10, 16, 10, 15, tzinfo=UTC)))
    def test_validated_raw_base_and_optional_failure(self):
        result = inspect_package(zipped(package()), NOW, DEADLINE, TARGET)
        self.assertTrue(result['base_ready_for_slot'])
        self.assertEqual(result['supplement_statuses_at_collection']['cmc_gem_geps:wind_gusts_10m'], 'unavailable')
        self.assertFalse(result['report_consumption_verified'])
        api = FakeAPI([run()], result)
        self.assertEqual(run_phase(NOW, api)['state'], 'base_ready')
        self.assertFalse(api.dispatched)
    def test_partial_base_is_not_hidden_by_green_build(self):
        files = package()
        files['capture.json']['records'][1]['raw_response']['hourly']['precipitation_member20'][40] = None
        files['validated.json']['ready_at_generation'] = True
        result = inspect_package(zipped(files), NOW, DEADLINE, TARGET)
        self.assertFalse(result['base_ready_for_slot'])
        self.assertTrue(result['models'][0]['numerical_content_validated'])
        self.assertFalse(result['models'][1]['numerical_content_validated'])
        self.assertTrue(run_phase(NOW, FakeAPI([run()], result))['remote_write'])
    def test_missing_member_and_wrong_units_fail(self):
        for change in ('member', 'units'):
            files = package(); raw = files['capture.json']['records'][0]['raw_response']
            if change == 'member': del raw['hourly']['wind_speed_10m_member50']
            else: raw['hourly_units']['wind_speed_10m'] = 'mph'
            self.assertFalse(inspect_package(zipped(files), NOW, DEADLINE, TARGET)['base_ready_for_slot'])
    def test_old_package_not_freshened_by_build_flag(self):
        files = package()
        for record in files['capture.json']['records']: record['received_at_utc'] = '2026-10-15T23:45:00Z'
        files['validated.json']['expires_at_utc'] = '2026-10-16T01:15:00Z'
        self.assertFalse(inspect_package(zipped(files), NOW, DEADLINE, TARGET)['base_ready_for_slot'])
    def test_future_and_mismatched_capture_rejected(self):
        for value in ('2026-10-16T12:00:00Z', '2026-10-15T09:16:00Z'):
            files = package(); files['capture.json']['saved_at_utc'] = value
            with self.assertRaises(ValueError): inspect_package(zipped(files), NOW, DEADLINE, TARGET)
    def test_test_capture_is_not_weather(self):
        files = package(); files['validated.json']['test_only'] = True
        with self.assertRaises(ValueError): inspect_package(zipped(files), NOW, DEADLINE, TARGET)
    def test_untrusted_zip_path_is_rejected(self):
        files = package(); files['../escape.json'] = {}
        with self.assertRaises(ValueError): read_package(zipped(files))
    def test_missing_or_mismatched_supplement_does_not_erase_base(self):
        for change in ('missing', 'mismatch'):
            files = package()
            if change == 'missing': del files['supplement.json']
            else: files['supplement.json']['base_capture_saved_at_utc'] = 'different'
            result = inspect_package(zipped(files), NOW, DEADLINE, TARGET)
            self.assertTrue(result['base_ready_for_slot'])
            self.assertFalse(result['supplement_matches'])
            self.assertEqual(result['core_retrieval_gaps'], ['nws-hourly', 'nws-forecast'])
    def test_newer_failure_is_visible_while_valid_prior_base_is_retained(self):
        result = inspect_package(zipped(package()), NOW, DEADLINE, TARGET)
        newer = run(2); newer.update(conclusion='failure', created_at='2026-10-16T09:30:00Z')
        receipt = run_phase(NOW, FakeAPI([newer, run()], result))
        self.assertEqual(receipt['latest_attempt']['conclusion'], 'failure')
        self.assertFalse(receipt['remote_write'])
    def test_check_only_never_writes(self):
        api = FakeAPI()
        self.assertFalse(run_phase(NOW, api, check_only=True)['remote_write'])
        self.assertFalse(api.dispatched)

if __name__ == '__main__': unittest.main()

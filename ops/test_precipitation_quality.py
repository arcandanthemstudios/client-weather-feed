"""Cross-runtime policy parity and independent artifact validation."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import unittest
from datetime import datetime, timezone
from precipitation_quality import overrides
from test_watchdog import package, zipped
from watchdog import inspect_package

ROOT = Path(__file__).resolve().parents[1]

@unittest.skipUnless(shutil.which('node'), 'Node needed for synthetic cross-runtime fixtures')
class PrecisionParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(['node', '--input-type=module', '-e',
            "import {fixture} from './test/precision-fixture.mjs'; console.log(JSON.stringify([fixture().r,fixture(-0.1).r]));"],
            cwd=ROOT, capture_output=True, check=True, timeout=10)
        cls.fixture, cls.hidden = json.loads(result.stdout)

    def results(self, record):
        times = [datetime.fromisoformat(t.rstrip('Z')).replace(tzinfo=timezone.utc) for t in record['raw_response']['hourly']['time']]
        py = {f'{member}:{i}': value for (member, i), value in overrides(record, times).items()}
        result = subprocess.run(['node', '--input-type=module', '-e',
            "import fs from 'node:fs'; import {precipitationOverrides} from './src/precipitation-quality.mjs';"
            "const r=JSON.parse(fs.readFileSync(0,'utf8')); const t=r.raw_response.hourly.time.map(x=>Date.parse(x.endsWith('Z')?x:x+'Z'));"
            "console.log(JSON.stringify(Object.fromEntries(precipitationOverrides(r,t).overrides)));"],
            cwd=ROOT, input=json.dumps(record).encode(), capture_output=True, check=True, timeout=10)
        self.assertEqual(py, json.loads(result.stdout))
        return py

    def test_valid_and_hidden_intervals_match_both_runtimes(self):
        for record in (self.fixture, self.hidden):
            before = copy.deepcopy(record)
            self.assertEqual(list(self.results(record).values()), [0, 0, 0])
            self.assertEqual(record, before)

    def test_bad_evidence_is_independently_rejected(self):
        cases = [('member_id', 43), ('paramId', 167), ('units', 'mm'), ('endStep', 39), ('startStep', 33),
                 ('longitude', -75.0), ('packing_error_mm', 0.9), ('accumulation_mm', 7.0),
                 ('source_url', 'https://invalid.example/field'), ('sha256', 'invalid')]
        for field, value in cases:
            with self.subTest(field=field):
                r = copy.deepcopy(self.fixture)
                r['precipitation_quality']['proofs']['intervals'][0]['current'][field] = value
                self.assertEqual(list(self.results(r).values()), [None, None, None])

    def test_hidden_negative_without_source_cannot_be_clean_zero(self):
        r = copy.deepcopy(self.hidden); r['precipitation_quality']['proofs']['intervals'] = []
        self.assertEqual(list(self.results(r).values()), [None, None, None])

    def test_hash_metadata_and_policy_mismatch(self):
        for kind in ('hash', 'metadata', 'policy', 'duplicate'):
            r = copy.deepcopy(self.fixture); q = r['precipitation_quality']
            if kind == 'hash': q['source_response_sha256'] = 'b' * 64
            if kind == 'metadata': r['metadata_after']['raw_response']['last_run_modification_time'] += 1
            if kind == 'policy': q['policy'] = 'unrecognized'
            if kind == 'duplicate': q['proofs']['intervals'].append(copy.deepcopy(q['proofs']['intervals'][0]))
            self.assertEqual(list(self.results(r).values()), [None, None, None])

    def test_checker_accepts_verified_correction_not_producer_assertion(self):
        record = copy.deepcopy(self.fixture)
        files = package()
        for r in files['capture.json']['records']:
            if r['requested_model'] == 'ecmwf_ifs025_ensemble':
                r.clear(); r.update(record)
            else:
                r['requested_coordinates'] = record['requested_coordinates']
                r['received_at_utc'] = record['received_at_utc']
                r['raw_response']['hourly']['time'] = record['raw_response']['hourly']['time']
                for k, values in r['raw_response']['hourly'].items():
                    if k != 'time': r['raw_response']['hourly'][k] = [values[0]] * len(record['raw_response']['hourly']['time'])
        files['capture.json']['saved_at_utc'] = record['received_at_utc']
        feed = files['validated.json']; feed['generated_at_utc'] = record['received_at_utc']
        feed['summary']['source_capture_saved_at_utc'] = record['received_at_utc']; feed['expires_at_utc'] = '2026-11-17T13:30:00Z'
        now = datetime(2026, 11, 17, 12, tzinfo=timezone.utc)
        result = inspect_package(zipped(files), now, now, tuple(record['requested_coordinates']))
        self.assertTrue(result['base_ready_for_slot'], result)
        self.assertEqual(result['models'][0]['precision_adjusted_hourly_cells'], 3)
        files['capture.json']['records'][0]['precipitation_quality']['proofs']['intervals'] = []
        self.assertFalse(inspect_package(zipped(files), now, now, tuple(record['requested_coordinates']))['base_ready_for_slot'])

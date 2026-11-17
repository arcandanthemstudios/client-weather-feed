"""Offline evidence-acquisition safeguards. Synthetic data only."""
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import ecmwf_precision as p

RUN = dt.datetime(2026, 11, 17, tzinfo=dt.timezone.utc)
URL = p.source_base(RUN, 36) + '.grib2'

class Reply(io.BytesIO):
    def __init__(self, body=b'GRIB', status=206, content_range='bytes 10-13/100'):
        super().__init__(body); self.status = status; self.headers = {'Content-Range': content_range}
class Opener:
    def __init__(self, reply): self.reply = reply; self.calls = 0
    def open(self, *args, **kwargs):
        self.calls += 1
        if isinstance(self.reply, Exception): raise self.reply
        return self.reply

class PrecisionTests(unittest.TestCase):
    def test_fixed_origin(self):
        d = p.Downloader()
        for url in ['https://evil.example/model.grib2', 'http://storage.googleapis.com/ecmwf-open-data/x',
                    'https://storage.googleapis.com/another-bucket/x.grib2']:
            with self.assertRaises(ValueError): d.get(url)
    def test_only_supported_steps(self):
        for step in [0, 1, 145, 150, -3, 3.0, True]:
            with self.assertRaises(ValueError): p.source_base(RUN, step)
    def test_range_success(self):
        d = p.Downloader(); d.opener = Opener(Reply())
        self.assertEqual(d.get(URL, (10, 4)), b'GRIB')
    def test_full_download_refused(self):
        d = p.Downloader(); d.opener = Opener(Reply(status=200))
        with self.assertRaises(ValueError): d.get(URL, (10, 4))
    def test_wrong_range_and_truncation_refused(self):
        for reply in [Reply(content_range='bytes 11-14/100'), Reply(body=b'GR'), Reply(content_range='bytes 10-13/13')]:
            d = p.Downloader(); d.opener = Opener(reply)
            with self.assertRaises(ValueError): d.get(URL, (10, 4))
    def test_rate_limit_stops_all_further_requests(self):
        d = p.Downloader(); d.opener = Opener(urllib.error.HTTPError(URL, 429, 'limited', {}, None))
        with self.assertRaises(urllib.error.HTTPError): d.get(URL, (10, 4))
        with self.assertRaises(ValueError): d.get(URL, (10, 4))
        self.assertEqual(d.opener.calls, 1)
    def test_redirect_refused(self):
        with self.assertRaises(ValueError): p.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.invalid')
    def test_index_exact_identity_and_uniqueness(self):
        row = dict(param='tp', levtype='sfc', stream='enfo', date='20261117', time='0000', step='36', type='pf', number='44', _offset=100, _length=200)
        encode = lambda x: (json.dumps(x) + '\n').encode()
        self.assertEqual(p.select_index(encode(row), RUN, 36, 44), row)
        for data in [encode(row) * 2, encode(row | {'date': '20261116'}), encode(row | {'number': '43'}),
                     encode(row | {'_length': p.MAX_FILE_BYTES + 1}), encode(row | {'_offset': -1})]:
            with self.assertRaises(ValueError): p.select_index(data, RUN, 36, 44)
    def test_request_budget(self):
        request = {'initialization_utc': '2026-11-17T00:00:00Z', 'latitude': 0, 'longitude': 0, 'intervals': [{}] * 9}
        with self.assertRaises(ValueError): p.run_request(request)
    def test_no_failure_imputation(self):
        class Broken:
            def sample(self, *args): raise ValueError('source missing')
        request = {'initialization_utc': '2026-11-17T00:00:00Z', 'latitude': 0, 'longitude': 0,
                   'intervals': [{'member_id': 44, 'valid_utc': '2026-11-18T12:00:00Z'}]}
        output = p.run_request(request, Broken())
        self.assertIn('error', output['intervals'][0]); self.assertNotIn('current', output['intervals'][0])

    @unittest.skipUnless(importlib.util.find_spec('eccodes'), 'ECMWF decoder installed in CI; offline container has no ecCodes')
    def test_real_decoder_on_synthetic_grib(self):
        import eccodes as ec
        gid = ec.codes_grib_new_from_samples('regular_ll_sfc_grib2')
        try:
            # This is a tiny synthetic global-grid sample, not any user's location.
            for k, v in {'Ni': 2, 'Nj': 2, 'latitudeOfFirstGridPointInDegrees': 0.25,
                         'longitudeOfFirstGridPointInDegrees': 0.0, 'latitudeOfLastGridPointInDegrees': 0.0,
                         'longitudeOfLastGridPointInDegrees': 0.25, 'iDirectionIncrementInDegrees': 0.25,
                         'jDirectionIncrementInDegrees': 0.25, 'paramId': 228, 'dataDate': 20261117,
                         'dataTime': 0, 'stepType': 'accum', 'endStep': 36, 'packingType': 'grid_ccsds', 'bitsPerValue': 12}.items():
                ec.codes_set(gid, k, v)
            ec.codes_set_values(gid, [0.0, 0.007568359375, 0.0078125, 0.1])
            raw = ec.codes_get_message(gid)
            decoded = p.decode_grib(raw, 0.0, 0.0)
            self.assertEqual(decoded['paramId'], 228); self.assertEqual(decoded['units'], 'm')
            self.assertEqual(decoded['endStep'], 36); self.assertGreater(decoded['packing_error_mm'], 0)
            self.assertEqual(decoded['grid_spacing_degrees'], 0.25)
            self.assertAlmostEqual(decoded['accumulation_mm'], 7.8125, delta=0.04)
        finally:
            ec.codes_release(gid)

if __name__ == '__main__': unittest.main()

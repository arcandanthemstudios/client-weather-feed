"""Independent standard-library check of ecmwf-packing-v1 source evidence.

Never trusts the producer's correction count or readiness flag. This verifier
repeats the source identity, precision and raw-to-native-to-hourly comparisons.
"""
from datetime import datetime, timezone
import math
import re

MODEL = 'ecmwf_ifs025_ensemble'
HOUR = 3600
EPS = 1e-9


def finite(x):
    return type(x) in (int, float) and math.isfinite(x)


def same(a, b):
    return finite(a) and finite(b) and abs(a - b) <= EPS


def stamp(s):
    if not isinstance(s, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?', s):
        raise ValueError('Invalid precision timestamp')
    return datetime.fromisoformat(s.rstrip('Z')).replace(tzinfo=timezone.utc).timestamp()


def key(member):
    return 'precipitation' if member == 0 else f'precipitation_member{member:02d}'


def rounded(x):
    return math.copysign(math.floor(abs(x) * 10 + 0.5) / 10, x)


def longitude(x):
    return (x + 180) % 360 - 180


def require(test):
    if not test:
        raise ValueError('Unverified precipitation precision evidence')


def verify(record, member, end, native_mm, proof):
    q = record['precipitation_quality']
    require(q.get('policy') == 'ecmwf-packing-v1')
    before, after = record['metadata_before']['raw_response'], record['metadata_after']['raw_response']
    for field in ('last_run_initialisation_time', 'last_run_availability_time', 'last_run_modification_time'):
        require(finite(after[field]) and after[field] == before[field])
    run, received = after['last_run_initialisation_time'], stamp(q['native']['received_at_utc'])
    update = after['update_interval_seconds']
    require(after['temporal_resolution_seconds'] == 10800 and finite(update) and update > 0 and
            received - after['last_run_availability_time'] >= 600 and run <= received and
            received - run <= 2 * update + 43200)
    require(q['source_response_sha256'] == record['response_sha256'] and
            q['native_response_sha256'] == q['native']['response_sha256'])
    for value in (q['source_response_sha256'], q['native_response_sha256']):
        require(isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value))
    step = (end - run) / HOUR
    require(step.is_integer() and 6 <= step <= 144 and step % 3 == 0 and
            proof['member_id'] == member and stamp(proof['valid_utc']) == end)
    init = datetime.fromtimestamp(run, timezone.utc)
    require(init.hour in (0, 6, 12, 18) and not (init.minute or init.second or init.microsecond))
    raw = record['raw_response']
    for p, expected_step in ((proof['previous'], int(step) - 3), (proof['current'], int(step))):
        expected_url = (f'https://storage.googleapis.com/ecmwf-open-data/{init:%Y%m%d}/{init:%H}z/'
                        f'ifs/0p25/enfo/{init:%Y%m%d%H}0000-{expected_step}h-enfo-ef.grib2')
        require(p['source_url'] == expected_url and p['paramId'] == 228 and p['shortName'] == 'tp' and
                p['units'] == 'm' and p['startStep'] == 0 and p['endStep'] == expected_step and
                p['member_id'] == member and stamp(p['initialization_utc']) == run and
                stamp(p['valid_utc']) == run + expected_step * HOUR and p['gridType'] == 'regular_ll' and
                same(p['grid_spacing_degrees'], 0.25) and same(p['latitude'], raw['latitude']) and
                same(longitude(p['longitude']), longitude(raw['longitude'])) and
                p['packingType'] in ('grid_ccsds', 'grid_simple') and type(p['bitsPerValue']) is int and
                1 <= p['bitsPerValue'] <= 32 and finite(p['accumulation_mm']) and p['accumulation_mm'] >= 0 and
                finite(p['packing_error_mm']) and p['packing_error_mm'] > 0 and
                type(p['binaryScaleFactor']) is int and type(p['decimalScaleFactor']) is int and
                isinstance(p['sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', p['sha256']))
        half_step = 1000 * 2.0 ** p['binaryScaleFactor'] * 10.0 ** -p['decimalScaleFactor'] / 2
        require(finite(half_step) and half_step > 0 and
                abs(p['packing_error_mm'] - half_step) <= max(EPS, half_step * 1e-5))
    delta = proof['current']['accumulation_mm'] - proof['previous']['accumulation_mm']
    bound = proof['previous']['packing_error_mm'] + proof['current']['packing_error_mm']
    require(delta < 0 and -delta <= bound + EPS and bound < 1 and same(rounded(delta), native_mm))


def overrides(record, times):
    """Return (member,index):0 for verified intervals; None for known defects."""
    q = record.get('precipitation_quality', {})
    if record['requested_model'] != MODEL or not q.get('native'):
        return {}
    native = q['native']
    raw, result = record['raw_response'], {}
    try:
        n = native['raw_response']
        require(native['http_status'] == 200 and n['utc_offset_seconds'] == 0 and
                n['timezone'] in ('UTC', 'GMT', 'Etc/UTC') and n['hourly_units']['time'] == 'iso8601' and
                same(n['latitude'], raw['latitude']) and same(n['longitude'], raw['longitude']) and
                n.get('model', n.get('models')) in (None, MODEL, [MODEL]))
        axis = list(map(stamp, n['hourly']['time']))
        require(axis and all(t % (3 * HOUR) == 0 and (i == 0 or t - axis[i-1] == 3 * HOUR) for i, t in enumerate(axis)))
        keys = {k for k in n['hourly'] if k == 'precipitation' or k.startswith('precipitation_member')}
        require(keys == {key(i) for i in range(51)})
        for k in keys:
            require(n['hourly_units'][k] == 'mm' and isinstance(n['hourly'][k], list) and len(n['hourly'][k]) == len(axis))
    except (KeyError, ValueError, TypeError, OverflowError):
        return {}  # A failed companion cannot authorize any adjustment.
    index = {t.timestamp(): i for i, t in enumerate(times)}
    for member in range(51):
        for end, amount in zip(axis, n['hourly'][key(member)]):
            if not finite(amount) or amount >= 0:
                continue
            indices = [index.get(end + h * HOUR) for h in (-2, -1, 0)]
            accepted = False
            try:
                require(all(i is not None for i in indices))
                require(all(same(raw['hourly'][key(member)][i], rounded(amount / 3)) for i in indices))
                proofs = [p for p in q.get('proofs', {}).get('intervals', [])
                          if p.get('member_id') == member and stamp(p.get('valid_utc')) == end]
                require(len(proofs) == 1)
                verify(record, member, end, amount, proofs[0])
                accepted = True
            except (KeyError, ValueError, TypeError, OverflowError, IndexError):
                pass
            for i in indices:
                if i is not None:
                    result[member, i] = 0 if accepted else None
    return result

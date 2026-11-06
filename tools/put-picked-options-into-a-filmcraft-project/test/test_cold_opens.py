#!/usr/bin/env python3
"""Cold opens' edits (filmcraft_preview.build_edits on a scratch copy of the base project, no export, never the original or the live app):
for each of three made-up cold-open specs the stitched opening has the length the spec says (opening_s), V1 has no gap or overlap over it, the grade layer on V2 covers
all of it (also under a hold at 0:00), the cut's sound on A1 is off exactly where `a1_mute` says and on everywhere else, the overlay sits on V3 from 0:00 (V4 under a
hold picture, which sits on V3 for the hold), its sound on A2, and the film itself starts right after the opening (the clip after it is the graded cut's first).
Ported from the film repository's test_cold_opens.py (its three round-8 cold opens); the assertions are unchanged, the specs made up in the same shapes
(one range with a mute; one range, a hold at 0:00 and its picture; a jump cut of two ranges with a hold, its picture and a mute).
Run: python3 test_cold_opens.py"""
import json, os, shutil, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import preview_world as world  # noqa: E402
import filmcraft_preview as f  # noqa: E402
import option_folders  # noqa: E402
from option_folders import rdir  # noqa: E402

T = f.T
FPS = 24000 / 1001


def frames(a, b):
    return round(b * FPS) - round(a * FPS)


def made_up_specs():
    """Three cold opens in the shapes the film used; opening_s is the stitched length plus the hold, on frames."""
    one = [[610.95, 613.30]]
    two = [[300.10, 303.75]]
    three = [[728.86, 731.63], [732.29, 736.33]]
    hold = 4.25
    hold_f = round(hold * FPS)
    specs = []
    for k, (ranges, held, mute, picture) in enumerate(((one, False, [[0.30, 0.95]], False), (two, True, [], True),
                                                       (three, True, [[hold_f / FPS + 0.5, hold_f / FPS + 1.2]], True)), start=1):
        stitched = sum(frames(a, b) for a, b in ranges)
        edit = {'prepend': ranges, 'overlay': {'at': 0}, 'preview': [0, 12.0], 'head_extend': [[stitched / FPS, 5]]}
        if mute:
            edit['a1_mute'] = mute
        if held:
            edit['hold'] = {'at': 0, 'seconds': hold}
        if picture:
            edit['hold_picture'] = {'image': 'stills/hold.png', 'at': 0, 'seconds': hold}
        specs.append({'id': f'x00-r8-{k}', 'edit': edit, 'duration_s': 6.0, 'still_at': 3.0,
                      'opening_s': (stitched + (hold_f if held else 0)) / FPS})
    return specs


def covered(items, a, b, tol):
    """True when the clips of one track cover a..b with no gap (clips butt or overlap by at most tol ticks)."""
    t = a
    for c in sorted(items, key=lambda c: c['start']):
        if c['start'] > t + tol:
            return False
        t = max(t, c['start'] + c['duration'])
    return t >= b - tol


def main():
    film, env = world.film(made_up_specs())
    os.environ['PATH'] = env['PATH']
    ids = [s['id'] for s in made_up_specs()]
    for oid in ids:
        option_folders.configure({'film': film, 'option': oid, 'settings': world.settings()})
        spec = option_folders.spec_of(oid)
        assert os.path.exists(rdir('specs', oid, oid + '.json'))
        with tempfile.TemporaryDirectory() as d:
            proj = os.path.join(d, oid + '.fcproj')
            shutil.copyfile(option_folders.base_project(), proj)
            f.build_edits(proj, oid, spec)
            s = f.seq(proj)
            n = round(spec['opening_s'] * 24000 / 1001)
            opening = n * f.FRAME_TICKS
            tol = f.FRAME_TICKS // 2
            v1 = sorted(s['video'][0]['items'], key=lambda c: c['start'])
            assert v1[0]['start'] == 0, (oid, v1[0]['start'])
            gaps = [b['start'] - (a['start'] + a['duration']) for a, b in zip(v1, v1[1:]) if a['start'] < opening + tol]   # the opening and the join into the film (the film has its own gaps later)
            assert all(abs(g) <= 10 for g in gaps), f'{oid}: V1 has a gap or overlap (ticks: {[g for g in gaps if abs(g) > 10]})'
            assert any(abs(c['start'] - opening) <= tol for c in v1), f'{oid}: no V1 clip starts where the opening ends ({spec["opening_s"]} s)'
            assert covered(s['video'][1]['items'], 0, opening, tol), f'{oid}: the grade layer on V2 does not cover the opening'
            ov_track = 3 if spec['edit'].get('hold_picture') else 2   # the hold picture takes V3 and the overlay goes on V4
            ov = [c for c in s['video'][ov_track]['items'] if c.get('name') == 'overlay.mov']
            assert ov and ov[0]['start'] == 0, f'{oid}: overlay.mov is not on its track at 0:00'
            if spec['edit'].get('hold_picture'):
                hp = [c for c in s['video'][2]['items'] if c.get('name') == os.path.basename(spec['edit']['hold_picture']['image'])]
                assert hp and hp[0]['start'] == 0 and abs(hp[0]['duration'] - round(spec['edit']['hold_picture']['seconds'] * 24000 / 1001) * f.FRAME_TICKS) <= tol, f'{oid}: hold picture is not on V3 for the hold'
            snd = [c for c in s['audio'][1]['items'] if c.get('name') == 'sound.wav']
            assert snd and snd[0]['start'] == 0, f'{oid}: sound.wav is not on A2 at 0:00'
            a1_off = [(c['start'], c['start'] + c['duration']) for c in s['audio'][0]['items'] if not c['enabled']]
            want = [(round(a * 24000 / 1001) * f.FRAME_TICKS, round(b * 24000 / 1001) * f.FRAME_TICKS) for a, b in spec['edit'].get('a1_mute', [])]
            assert len(a1_off) == len(want) and all(abs(x[0] - w[0]) <= tol and abs(x[1] - w[1]) <= tol for x, w in zip(sorted(a1_off), sorted(want))), (oid, a1_off, want)
            hold = spec['edit'].get('hold')
            if hold:   # nothing of the cut's sound plays during the hold
                assert not [c for c in s['audio'][0]['items'] if c['enabled'] and c['start'] < round(hold['seconds'] * 24000 / 1001) * f.FRAME_TICKS - tol], f'{oid}: the cut\'s sound plays under the hold'
            assert spec['edit']['hold_picture']['image'].startswith(film) if spec['edit'].get('hold_picture') else True, 'a relative picture is read against the film'
        print(oid, 'ok')
    print('cold opens: ok')


if __name__ == '__main__':
    main()

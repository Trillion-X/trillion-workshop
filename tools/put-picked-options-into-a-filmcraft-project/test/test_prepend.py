#!/usr/bin/env python3
"""filmcraft_preview.prepend (the `prepend` edit op): on a scratch copy of a made-up base project (never the original, never the live app),
two ranges of the graded cut (a jump cut: one clip, the "um" left out) are copied to the start of the sequence and
  - the sequence grows by exactly the two ranges' length;
  - V1, its linked A1 and the V2 grade layer all start with the copies, back to back, with no gap;
  - each copy shows the same part of the same media as the range it came from (source in point, name, length);
  - everything that was there still plays after the copies, unchanged in length.
Ported from the film repository's test_prepend.py; its assertions unchanged. Here filmcraft-cli is the stand-in (test/stand_in_filmcraft_cli.py);
FILMCRAFT_CLI and PREVIEW_TEST_BASE name a real build and a real base project to run it against FilmCraft itself.
Run: python3 test_prepend.py"""
import os, shutil, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import preview_world as world  # noqa: E402
import filmcraft_preview as f  # noqa: E402
import option_folders  # noqa: E402

T, FT = f.T, f.FRAME_TICKS
RANGES = [[728.86, 731.63], [732.29, 736.33], [397.04, 399.78]]  # out of time order on purpose: the copies keep the order given


def total(s):
    return max(c['start'] + c['duration'] for k in ('video', 'audio') for tr in s[k] for c in tr['items'])


def source_of(s, track, t):
    """(media name, source in-point in ticks at time t) of the clip on a track at t."""
    tr = s['video' if track[0] == 'V' else 'audio'][int(track[1:]) - 1]
    for c in tr['items']:
        if c['start'] <= t < c['start'] + c['duration']:
            return c['name'], c['sourceIn'] + (t - c['start'])
    raise AssertionError(f'no clip on {track} at {t}')


def main():
    film, env = world.film()
    os.environ['PATH'] = env['PATH']
    option_folders.FILMCRAFT_CLI = os.environ.get('FILMCRAFT_CLI') or 'filmcraft-cli'
    base = os.environ.get('PREVIEW_TEST_BASE') or os.path.join(film, 'cuts', world.CHAPTER, 'base-graded-copy.fcproj')
    with tempfile.TemporaryDirectory() as d:
        proj = os.path.join(d, 'scratch.fcproj')
        shutil.copyfile(base, proj)
        before = f.seq(proj)
        want = [(f.frame_tick(a), f.frame_tick(b)) for a, b in RANGES]
        length = sum(b - a for a, b in want)
        secs = f.prepend(proj, RANGES)
        after = f.seq(proj)
        assert abs(secs * T - length) < FT, (secs, length / T)
        assert total(after) == total(before) + length, (total(after) / T, (total(before) + length) / T)
        at = 0
        for a, b in want:
            for tr in ('V1', 'A1', 'V2'):
                assert source_of(after, tr, at + FT) == source_of(before, tr, a + FT), (tr, at / T, a / T)
                assert source_of(after, tr, at + b - a - FT) == source_of(before, tr, b - FT), (tr, 'end', at / T, b / T)
            at += b - a
        # what was there before still plays, shifted by the stitched length
        for t in (0, 100 * T, 397 * T, 1000 * T, total(before) - FT):
            for tr in ('V1', 'A1', 'V2'):
                assert source_of(after, tr, t + length) == source_of(before, tr, t), (tr, t / T)
        # V1 and A1 are cut at the same places in the stitched part
        cuts = lambda s, k: [c['start'] for c in s[k][0]['items'] if c['start'] < length]
        assert cuts(after, 'video') == cuts(after, 'audio'), (cuts(after, 'video'), cuts(after, 'audio'))
        try:
            f.prepend(proj, [[10.0, 12.0], [11.0, 13.0]])
        except SystemExit as e:
            assert 'overlap' in str(e)
        else:
            raise AssertionError('overlapping ranges were accepted')
    print('prepend: ok')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""The preview tools as commands (one JSON request in, the answer on the last line) on a made-up film with the stand-in
filmcraft-cli, ffmpeg and ffprobe: the plan is the exact command list a build runs and writes nothing; the settings pick the
chapter, the layout, the lock and the export; publish and watch keep the person's rule (never show an unfinished preview);
the composite, the overlay step, the working preview and the review pack. Run: python3 test_filmcraft_preview.py"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import preview_world as world  # noqa: E402

CHECKS = []


def check(fn):
    CHECKS.append(fn)
    return fn


EVERY_OP = {'id': 'x05-r4-1', 'still_at': 40.0, 'duration_s': 6.0,
            'watch': '05 a made-up moment - A every edit at once',
            'edit': {'cuts': [[80.0, 81.5]], 'head_extend': [[37.28725, 4]], 'hold': {'at': 45.5, 'seconds': 2.0}, 'a1_mute': [[47.0, 47.6]],
                     'gain': [[50.0, 52.0, -3]], 'scale': [[41.0, 100], [44.0, 112]],
                     'hold_picture': {'image': 'stills/eyes-open.png', 'at': 45.5, 'seconds': 2.0}, 'overlay': {'at': 44.0},
                     'preview': [38.0, 58.0]}}
PLAIN = {'id': 'x09-r4-1', 'still_preview': 1.0, 'edit': {'preview': [60.0, 70.0]}}


def norm(rows, film):
    out = []
    for e in rows:
        text = json.dumps(e).replace(film, '<film>')
        text = re.sub(r'"[^"]*fc-\d+\.jsonl"', '"<ops>"', text)
        text = re.sub(r'(measured_(?:I|TP|LRA|thresh)|offset)=[^:,"]+', lambda m: m.group(1) + '={v}', text)
        out.append(json.loads(text))
    return out


def plan_rows(plan):
    rows = []
    for st in plan:
        if 'argv' in st:
            e = {'prog': os.path.basename(st['argv'][0]), 'argv': st['argv'][1:]}
            if 'ops' in st:
                e['ops'] = st['ops']
            rows.append(e)
    return rows


def files(root):
    return sorted(os.path.relpath(os.path.join(d, f), root) for d, _, fs in os.walk(root) for f in fs)


@check
def plan_is_the_build_and_writes_nothing():
    film, env = world.film([EVERY_OP])
    req = {'film': film, 'option': 'x05-r4-1', 'settings': world.settings()}
    before = files(film)
    code, ans, _ = world.run('filmcraft_preview.py', {**req, 'plan': True}, env)
    assert code == 0, ans
    assert files(film) == before, 'a plan writes nothing in the film'
    plan = ans['result']['plan']
    assert plan[0] == {'mkdir': os.path.join(film, 'cuts', world.CHAPTER, 'projects-round-4')}, plan[0]
    assert plan[1]['copy'][1].endswith('projects-round-4/x05-r4-1.fcproj')
    log = os.path.join(tempfile.mkdtemp(), 'real.log')
    code, real, _ = world.run('filmcraft_preview.py', req, env, {'FILMCRAFT_STAND_IN_LOG': log})
    assert code == 0, real
    assert norm(plan_rows(plan), film) == norm(world.log_rows(log), film), 'the plan names every command the build runs, in order'
    ids = [o['id'] for st in plan for o in st.get('ops', [])]
    for op in ('sequence.addEditAllTracks', 'edit.rippleDelete', 'timeline.trim', 'clip.insertFrameHoldSegment', 'timeline.razor',
               'clip.enable', 'clip.audioGain', 'effects.setParam', 'file.import', 'sequence.addTracks', 'timeline.place', 'clip.fillFrame'):
        assert op in ids, op
    exports = [st['argv'] for st in plan if 'export' in st.get('argv', [])]
    assert exports and exports[0][exports[0].index('export'):] == ['export', os.path.join(film, 'cuts', world.CHAPTER, 'work-round-4', 'pending', '_export-x05-r4-1.mp4'),
                                                                     '--format', 'h264', '--start', '38.0', '--end', '58.0', '--scale', '0.5', '--quality', '70']
    loud = [st['argv'] for st in plan if st.get('argv', [None])[0] == 'ffmpeg' and any('measured_I={input_i}' in a for a in st['argv'])]
    assert loud, 'pass 2 of the loudness master names what pass 1 measures'
    assert {'remove': os.path.join(film, 'cuts', world.CHAPTER, 'work-round-4', 'pending', '_export-x05-r4-1.mp4')} in plan


@check
def a_build_leaves_the_preview_its_still_and_the_project_and_no_scratch():
    film, env = world.film([EVERY_OP])
    code, ans, _ = world.run('filmcraft_preview.py', {'film': film, 'option': 'x05-r4-1', 'settings': world.settings()}, env)
    assert code == 0, ans
    r = ans['result']
    pend = os.path.join(film, 'cuts', world.CHAPTER, 'work-round-4', 'pending')
    assert r['preview'] == os.path.join(pend, 'x05-r4-1.mp4') and os.path.exists(r['preview'])
    assert os.path.exists(r['still']) and not os.path.exists(os.path.join(pend, '_export-x05-r4-1.mp4'))
    assert os.path.exists(r['project'])
    assert os.path.exists(os.path.join(film, 'cuts', '.render.lock')), 'the lock file is named relative to the film'
    proj = json.load(open(r['project']))
    assert [c['name'] for c in proj['sequence']['video'][3]['items']] == ['overlay.mov'], 'the overlay goes on V4 under a hold picture'
    assert proj['root']['children'][0]['name'] == 'eyes-open.png'
    assert json.load(open(os.path.join(film, 'cuts', world.CHAPTER, 'base-graded-copy.fcproj')))['next'] < proj['next'], 'the base project is never changed'


@check
def the_settings_name_the_export_loudness_still_and_layout():
    film, env = world.film([PLAIN])
    os.rename(os.path.join(film, 'cuts', world.CHAPTER, 'specs-round-4'), os.path.join(film, 'cuts', world.CHAPTER, 'r4-specs'))
    s = world.settings(export={'format': 'prores', 'scale': 1.0, 'quality': 90}, loudness={'I': -16, 'TP': -1, 'LRA': 9}, still_qscale=2,
                       layout={'specs': 'r{round}-specs', 'work': 'r{round}-work'})
    code, ans, _ = world.run('filmcraft_preview.py', {'film': film, 'option': 'x09-r4-1', 'settings': s, 'plan': True}, env)
    assert code == 0, ans
    argv = [st['argv'] for st in ans['result']['plan'] if 'argv' in st]
    export = next(a for a in argv if 'export' in a)
    assert export[export.index('export') + 1].endswith('/r4-work/pending/_export-x09-r4-1.mp4')
    assert export[export.index('--format'):] == ['--format', 'prores', '--start', '60.0', '--end', '70.0', '--scale', '1.0', '--quality', '90']
    assert any('loudnorm=I=-16:TP=-1:LRA=9:print_format=json' in x for a in argv for x in a)
    still = argv[-1]
    assert still[still.index('-ss') + 1] == '1.000' and still[still.index('-q:v') + 1] == '2'


@check
def the_option_id_picks_its_chapter_and_its_round():
    film, env = world.film([PLAIN])
    two = os.path.join(film, 'cuts', 'options-two', 'specs-round-3')
    os.makedirs(two)
    json.dump({'id': 'y01-r3-1', 'edit': {'preview': [1.0, 2.0]}}, open(os.path.join(two, 'y01-r3-1.json'), 'w'))
    shutil.copyfile(os.path.join(film, 'cuts', world.CHAPTER, 'base-graded-copy.fcproj'), os.path.join(film, 'cuts', 'options-two', 'base-graded-copy.fcproj'))
    s = world.settings()
    s['preview']['chapters']['two'] = {'options_folder': 'cuts/options-two', 'option_ids': '^y'}
    code, ans, _ = world.run('filmcraft_preview.py', {'film': film, 'option': 'y01-r3-1', 'settings': s, 'plan': True}, env)
    assert code == 0 and '/options-two/projects-round-3/' in ans['result']['project'], ans
    code, ans, _ = world.run('filmcraft_preview.py', {'film': film, 'option': 'z01-r3-1', 'settings': s, 'plan': True}, env)
    assert code == 1 and 'no chapter of the settings holds it' in ans['error'], ans
    code, ans, _ = world.run('filmcraft_preview.py', {'film': film, 'option': 'x-1', 'settings': s, 'plan': True}, env)
    assert code == 1 and 'no round in this option id' in ans['error'], ans
    code, ans, _ = world.run('filmcraft_preview.py', {'film': film, 'settings': s}, env)
    assert code == 1 and 'names no option' in ans['error'], ans
    code, ans, _ = world.run('filmcraft_preview.py', {'film': film, 'option': 'x77-r4-1', 'settings': s, 'plan': True}, env)
    assert code == 1 and 'no spec at' in ans['error'], ans


@check
def the_settings_row_is_the_films_row_of_this_folder():
    film, env = world.film([PLAIN])
    row = {'id': 'record:setting:put-picked-options-into-a-filmcraft-project~film~made-up-film', 'type': 'record:setting',
           'value': {'name': 'made up', 'tool': 'tool:put-a-picked-option-into-a-filmcraft-project', 'scope_kind': 'film',
                     'scope_id': 'made-up-film', 'settings': json.dumps({**world.settings(), 'protected_projects': []}), 'from': 'made up', 'status': 'active'}}
    code, ans, _ = world.run('filmcraft_preview.py', {'film': film, 'option': 'x09-r4-1', 'settings_record': row, 'plan': True}, env)
    assert code == 0, ans
    other = json.loads(json.dumps(row))
    other['value']['tool'] = 'tool:something-else'
    code, ans, _ = world.run('filmcraft_preview.py', {'film': film, 'option': 'x09-r4-1', 'settings_record': other, 'plan': True}, env)
    assert code == 1 and 'not for this folder' in ans['error'], ans
    retired = json.loads(json.dumps(row))
    retired['value']['status'] = 'retired'
    code, ans, _ = world.run('filmcraft_preview.py', {'film': film, 'option': 'x09-r4-1', 'settings_record': retired, 'plan': True}, env)
    assert code == 1 and 'retired' in ans['error'], ans
    door = os.path.join(film, 'no-door')
    code, ans, _ = world.run('filmcraft_preview.py', {'film': film, 'option': 'x09-r4-1', 'settings_record': row['id'], 'plan': True}, env,
                             {'TRILLION_BIN': door})
    assert code == 1 and 'could not read' in ans['error'], ans


@check
def publish_moves_a_whole_preview_and_refuses_a_wrong_one():
    film, env = world.film([EVERY_OP, PLAIN])
    s = world.settings()
    for oid in ('x05-r4-1', 'x09-r4-1'):
        assert world.run('filmcraft_preview.py', {'film': film, 'option': oid, 'settings': s}, env)[0] == 0
    opt = os.path.join(film, 'cuts', world.CHAPTER)
    code, ans, _ = world.run('publish_preview.py', {'film': film, 'options': ['x05-r4-1'], 'action': 'publish', 'settings': s, 'plan': True}, env)
    assert code == 0 and os.path.exists(os.path.join(opt, 'work-round-4', 'pending', 'x05-r4-1.mp4')), 'a plan moves nothing'
    code, ans, _ = world.run('publish_preview.py', {'film': film, 'option': 'x05-r4-1', 'action': 'publish', 'settings': s}, env)
    assert code == 0 and ans['result']['published'][0]['duration_s'] == 20.0, ans
    assert os.path.exists(os.path.join(opt, 'previews-round-4', 'x05-r4-1.mp4')) and os.path.exists(os.path.join(opt, 'previews-round-4', 'x05-r4-1.jpg'))
    assert not os.path.exists(os.path.join(opt, 'work-round-4', 'pending', 'x05-r4-1.mp4'))
    code, ans, _ = world.run('publish_preview.py', {'film': film, 'option': 'x05-r4-1', 'action': 'publish', 'settings': s}, env)
    assert code == 1 and 'nothing pending' in ans['error'], ans
    wrong = world.settings(frame=[3840, 2160])
    code, ans, _ = world.run('publish_preview.py', {'film': film, 'option': 'x09-r4-1', 'action': 'publish', 'settings': wrong}, env)
    assert code == 1 and 'ffprobe refused' in ans['error'] and os.path.exists(os.path.join(opt, 'work-round-4', 'pending', 'x09-r4-1.mp4')), ans
    code, ans, _ = world.run('publish_preview.py', {'film': film, 'option': 'x09-r4-1', 'action': 'ship', 'settings': s}, env)
    assert code == 1 and 'use publish' in ans['error'], ans


@check
def watch_needs_the_check_the_gate_and_a_watch_name():
    film, env = world.film([EVERY_OP, PLAIN])
    s = world.settings()
    opt = os.path.join(film, 'cuts', world.CHAPTER)
    for oid in ('x05-r4-1', 'x09-r4-1'):
        assert world.run('filmcraft_preview.py', {'film': film, 'option': oid, 'settings': s}, env)[0] == 0
        assert world.run('publish_preview.py', {'film': film, 'option': oid, 'settings': s}, env)[0] == 0
    req = {'film': film, 'option': 'x05-r4-1', 'action': 'watch', 'settings': s}
    code, ans, _ = world.run('publish_preview.py', req, env)
    assert code == 1 and 'has not been run' in ans['error'], ans
    prev = os.path.join(opt, 'previews-round-4', 'x05-r4-1.mp4')
    os.makedirs(os.path.join(opt, 'work-round-4', 'qa'))
    json.dump({prev: {'made_up': True}}, open(os.path.join(opt, 'work-round-4', 'qa', 'x05-r4-1.json'), 'w'))
    no_gate = world.settings(content_gate=None)
    code, ans, _ = world.run('publish_preview.py', {**req, 'settings': no_gate}, env)
    assert code == 1 and 'no content gate' in ans['error'], ans
    code, ans, _ = world.run('publish_preview.py', req, env, {'GATE_FAILS': '1'})
    assert code == 1 and 'made-up-row-1' in ans['error'], ans
    watch = os.path.join(opt, 'ROUND 4 - watch these')
    assert not os.path.exists(watch) or not os.listdir(watch)
    log = os.path.join(film, 'gate.log')
    code, ans, _ = world.run('publish_preview.py', req, env, {'GATE_LOG': log})
    assert code == 0, ans
    assert os.path.samefile(os.path.join(watch, EVERY_OP['watch'] + '.mp4'), prev) and not [f for f in os.listdir(watch) if f.endswith('.linking')]
    assert world.log_rows(log) == [[film, 'x05-r4-1']], 'the gate is asked about this option of this film'
    optional = world.settings(content_gate=None, require_content_gate=False)
    os.makedirs(os.path.join(opt, 'work-round-4', 'qa'), exist_ok=True)
    json.dump({os.path.join(opt, 'previews-round-4', 'x09-r4-1.mp4'): {}}, open(os.path.join(opt, 'work-round-4', 'qa', 'x09-r4-1.json'), 'w'))
    code, ans, _ = world.run('publish_preview.py', {**req, 'option': 'x09-r4-1', 'settings': optional}, env)
    assert code == 1 and 'no watch name' in ans['error'], ans


@check
def the_composite_is_planned_from_the_chapters_base_export():
    spec = {'id': 'x03-r1-1', 'still_at': 12.0, 'duration_s': 6.0, 'edit': {'overlay': {'at': 11.0}, 'preview': [10.0, 20.0]}}
    film, env = world.film([spec])
    s = world.settings()
    code, ans, _ = world.run('filmcraft_preview.py', {'film': film, 'option': 'x03-r1-1', 'settings': s, 'how': 'composite', 'plan': True}, env)
    assert code == 1 and 'composite {base, base_t0}' in ans['error'], ans
    s['preview']['chapters']['one']['composite'] = {'base': 'work/base-export.mp4', 'base_t0': 5.0}
    code, ans, _ = world.run('filmcraft_preview.py', {'film': film, 'option': 'x03-r1-1', 'settings': s, 'how': 'composite', 'plan': True}, env)
    assert code == 0, ans
    argv = [st['argv'] for st in ans['result']['plan'] if 'argv' in st]
    comp = next(a for a in argv if a[:4] == ['nice', '-n', '10', 'ffmpeg'])
    assert comp[comp.index('-ss') + 1] == '5.0000' and comp[comp.index('-i') + 1].endswith('/options-one/work/base-export.mp4')
    at = round(11.0 * 24000 / 1001) * 1001 / 24000  # where FilmCraft puts it: on a frame
    assert comp[comp.index('-itsoffset') + 1] == f'{at - 10.0:.6f}', 'the overlay is placed where the project puts it'
    assert any(f'adelay=delays={round((at - 10.0) * 48000)}S' in x for x in comp), 'the sound is placed in samples'
    assert comp[-1].endswith('/pending/_scratch-x03-r1-1.mov'), 'one scratch per option'
    assert not os.path.exists(os.path.join(film, 'cuts', world.CHAPTER, 'projects-round-1', 'x03-r1-1.fcproj'))


@check
def the_overlay_step_renders_into_the_options_out_folder_under_the_build_lock():
    spec = {'id': 'x04-r2-1', 'duration_s': 6.0, 'edit': {'overlay': {'at': 3.0}, 'preview': [2.0, 9.0]}}
    film, env = world.film([spec])
    shutil.rmtree(os.path.join(film, 'cuts', world.CHAPTER, 'out-round-2'))
    tool = os.path.join(film, 'stand-in-overlay.py')
    open(tool, 'w').write('import json, os, sys\nr = json.load(sys.stdin)\nos.makedirs(r["out"], exist_ok=True)\n'
                          'json.dump(r, open(os.path.join(r["out"], "request.json"), "w"))\n'
                          'json.dump({"duration": 6.0}, open(os.path.join(r["out"], "overlay.mov"), "w"))\n'
                          'json.dump({"duration": 6.0}, open(os.path.join(r["out"], "sound.wav"), "w"))\n'
                          'print(json.dumps({"result": {"id": r["spec_record"], "held": os.environ.get("OVERLAY_RENDER_LOCK_HELD")}}))\n')
    req = {'film': film, 'option': 'x04-r2-1', 'settings': world.settings(),
           'overlay': {'request': {'spec_record': 'made-up-spec', 'lock': {'file': '/nowhere'}}, 'command': [sys.executable, tool]}}
    code, ans, _ = world.run('filmcraft_preview.py', req, env)
    assert code == 0, ans
    out = os.path.join(film, 'cuts', world.CHAPTER, 'out-round-2', 'x04-r2-1')
    asked = json.load(open(os.path.join(out, 'request.json')))
    assert asked['out'] == out and 'lock' not in asked
    assert ans['result']['overlay']['held'] == os.path.realpath(os.path.join(film, 'cuts', '.render.lock'))
    proj = json.load(open(ans['result']['project']))
    assert [c['name'] for c in proj['sequence']['video'][2]['items']] == ['overlay.mov']
    refuser = os.path.join(film, 'stand-in-overlay-refuses.py')
    open(refuser, 'w').write('import json\nprint(json.dumps({"error": "no look"}))\nraise SystemExit(1)\n')
    bad = dict(req, overlay={'request': {}, 'command': [sys.executable, refuser]})
    code, ans, _ = world.run('filmcraft_preview.py', bad, env)
    assert code == 1 and 'the overlay tool refused: no look' in ans['error'], ans


@check
def the_working_preview_is_planned_from_the_cut():
    film, env = world.film([EVERY_OP])
    s = world.settings()
    code, ans, _ = world.run('working_preview.py', {'film': film, 'option': 'x05-r4-1', 'settings': s, 'cut': '/made/up/cut.mp4', 'plan': True}, env)
    assert code == 1 and 'no edit.prepend' in ans['error'], ans
    spec = {'id': 'x00-r8-1', 'edit': {'prepend': [[100.0, 102.0], [103.0, 104.5]], 'hold': {'at': 0, 'seconds': 1.5}, 'a1_mute': [[0.2, 0.6]],
                                       'overlay': {'at': 0}, 'preview': [0, 10.0]}}
    film, env = world.film([spec])
    code, ans, _ = world.run('working_preview.py', {'film': film, 'option': 'x00-r8-1', 'settings': s, 'plan': True}, env)
    assert code == 1 and 'give cut' in ans['error'], ans
    code, ans, _ = world.run('working_preview.py', {'film': film, 'option': 'x00-r8-1', 'settings': s, 'cut': '/made/up/cut.mp4', 'plan': True}, env)
    assert code == 0, ans
    plan = ans['result']['plan']
    main = next(st['argv'] for st in plan if st.get('argv', [''])[:4] == ['nice', '-n', '10', 'ffmpeg'])
    assert main.count('/made/up/cut.mp4') == 4, 'the hold, two ranges and the film from 0:00'
    fc = main[main.index('-filter_complex') + 1]
    assert 'loop=loop=35' in fc and "volume=0:enable='between(t,0.20000,0.60000)'" in fc
    assert main[main.index('-t') + 1] == f'{round(10.0 * 24000 / 1001) / (24000 / 1001):.5f}'
    assert ans['result']['preview'].endswith('/work-round-8/working/x00-r8-1.mp4') and not os.path.exists(ans['result']['preview'])


@check
def the_review_pack_has_sheets_and_a_transcript():
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        print('  skipped: no ffmpeg here')
        return
    try:
        import PIL  # noqa: F401
    except ImportError:
        print('  skipped: no Pillow here')
        return
    spec = {'id': 'x00-r8-2', 'edit': {'preview': [0, 3]}}
    film, _ = world.film([spec])
    env = dict(os.environ, PYTHONPATH=os.path.join(HERE, 'stand_in_whisper'), WHISPER_BACKEND='mlx')
    working = os.path.join(film, 'cuts', world.CHAPTER, 'work-round-8', 'working')
    os.makedirs(working)
    video = os.path.join(working, 'x00-r8-2.mp4')
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=13.5', '-f', 'lavfi', '-i',
                    'sine=f=440:d=13.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video], check=True)
    code, ans, done = world.run('review_pack.py', {'film': film, 'option': 'x00-r8-2', 'settings': world.settings()}, env)
    assert code == 0, (ans, done.stderr[-600:])
    r = ans['result']
    assert r['tiles'] == 14 and [os.path.basename(p) for p in r['sheets']] == ['sheet-01.jpg', 'sheet-02.jpg'] and all(map(os.path.exists, r['sheets']))
    assert open(os.path.join(r['pack'], 'transcript.txt')).read() == '00:00 Made up words.\n00:01 A question?\n00:02 No end\n'
    code, ans, _ = world.run('review_pack.py', {'film': film, 'option': 'x00-r8-2', 'settings': world.settings(), 'video': '/made/up.mp4'}, env)
    assert code == 1 and 'no preview at' in ans['error'], ans


def main():
    for fn in CHECKS:
        fn()
        print('ok', fn.__name__)
    print(f'test_filmcraft_preview: {len(CHECKS)} checks pass')


if __name__ == '__main__':
    main()

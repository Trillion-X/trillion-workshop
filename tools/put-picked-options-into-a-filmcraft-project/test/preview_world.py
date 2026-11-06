"""A made-up film for the preview tests: a film folder with one chapter's option folder, a made-up base project for the stand-in
filmcraft-cli, made-up overlay files, and a bin folder whose filmcraft-cli, ffmpeg and ffprobe are the stand-ins. Nothing here is a
real film, person or project."""
import json
import os
import stat
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DO = os.path.join(HERE, '..', 'do-work')
sys.path.insert(0, HERE)
sys.path.insert(0, DO)
from made_up_project import base_project  # noqa: E402

CHAPTER = 'options-one'


def settings(**over):
    pv = {'chapters': {'one': {'options_folder': f'cuts/{CHAPTER}', 'option_ids': '^x'}},
          'lock': {'file': 'cuts/.render.lock'},
          'content_gate': {'command': ['{python}', os.path.join(HERE, 'stand_in_gate.py'), '{film}', '{option}']}}
    pv.update(over)
    return {'preview': pv}


def bin_folder(root):
    b = os.path.join(root, 'bin')
    os.makedirs(b, exist_ok=True)
    for name, script, extra in (('filmcraft-cli', 'stand_in_filmcraft_cli.py', ''), ('ffmpeg', 'stand_in_media.py', ' ffmpeg'),
                                ('ffprobe', 'stand_in_media.py', ' ffprobe')):
        p = os.path.join(b, name)
        with open(p, 'w') as fh:
            fh.write(f'#!/bin/sh\nexec "{sys.executable}" "{os.path.join(HERE, script)}"{extra} "$@"\n')
        os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR)
    return b


def film(specs=(), cuts=None, overlay_s=6.0):
    """(film folder, env with the stand-ins first on PATH). specs: made-up specs, written to specs-round-<n>/<id>.json."""
    root = tempfile.mkdtemp(prefix='fc-preview-')
    f = os.path.join(root, 'made-up-film')
    opt = os.path.join(f, 'cuts', CHAPTER)
    os.makedirs(opt)
    with open(os.path.join(opt, 'base-graded-copy.fcproj'), 'w') as fh:
        json.dump(base_project(1201.2, cuts), fh)
    for spec in specs:
        n = int(spec['id'].split('-')[1][1:])
        d = os.path.join(opt, f'specs-round-{n}')
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, spec['id'] + '.json'), 'w') as fh:
            json.dump(spec, fh)
        if spec['edit'].get('overlay'):
            out = os.path.join(opt, f'out-round-{n}', spec['id'])
            os.makedirs(out, exist_ok=True)
            for name in ('overlay.mov', 'sound.wav'):
                with open(os.path.join(out, name), 'w') as fh:
                    json.dump({'duration': overlay_s, 'made_up': name}, fh)
    env = dict(os.environ, PATH=bin_folder(root) + os.pathsep + os.environ['PATH'])
    env.pop('FILMCRAFT_CLI', None)
    env.pop('FILM_RENDER_LOCK_HELD', None)
    return f, env


def run(script, request, env, extra_env=None):
    """Run do-work/<script> with the request on standard input: (exit code, the last line parsed, the whole output)."""
    done = subprocess.run([sys.executable, os.path.join(DO, script)], input=json.dumps(request), capture_output=True, text=True,
                          env=dict(env, **(extra_env or {})))
    last = (done.stdout.strip().splitlines() or ['{}'])[-1]
    return done.returncode, json.loads(last), done


def log_rows(path):
    return [json.loads(line) for line in open(path)] if os.path.exists(path) else []

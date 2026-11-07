"""Where an option's files live. The round is part of the option id (m02-r4-1 -> round 4), so one set of tools serves every
round: the settings' layout names each kind of folder with {round} in it (specs, out, projects, previews, work, watch).

The option folder is the request's `options_folder`, or the folder of the chapter the option belongs to (settings
`chapters`: {name: {options_folder, option_ids}}, relative to the request's `film`): the same tools then read and write
the same tools then read and write that lane's rounds. Renders across all lanes take one lock (render_lock).
The lock is the settings' `lock`: {file (relative to the film), wait_while?: {file, says, poll_s, max_s}}.

Also the one road to filmcraft-cli and to ffmpeg/ffprobe (run_program), and the request every command of this folder
reads: one JSON object, in the file named as the first argument or on standard input; the settings are, weakest first,
DEFAULTS, the film's row of list:settings (`settings_record`: the record, its value, a file of it, or its id, read through
the person's records door, `trillion op @own-records`), then the request's own `settings`. With `plan` true, nothing
that writes is run: every command is recorded instead (planning(), plan_steps())."""
import contextlib, fcntl, os, re, shutil, subprocess, sys, tempfile, json
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(1, str(HERE.parents[1] / 'settings' / 'read-data'))  # tools/settings, packed at /opt/settings

FOLDER = 'put-picked-options-into-a-filmcraft-project'
TOOLS = ('tool:put-a-picked-option-into-a-filmcraft-project', 'tool:build-a-filmcraft-option-preview',
         'tool:publish-a-checked-filmcraft-preview', 'tool:make-a-working-preview-of-a-stitched-opening',
         'tool:make-a-fresh-viewer-review-pack-of-a-preview')
TRILLION = os.environ.get('TRILLION_BIN', 'trillion')
DEFAULTS = {
    'filmcraft_cli': 'filmcraft-cli',
    'preview': {
        'chapters': {},
        'round_pattern': None,  # a regular expression whose first group is the round; none: the second part of the id after its first letter
        'layout': {},  # kind -> folder name with {round}; a kind not named is <kind>-round-<n> (and the watch folder 'ROUND <n> - watch these')
        'base_project': 'base-graded-copy.fcproj',
        'lock': None,
        'export': {'format': 'h264', 'scale': 0.5, 'quality': 70},
        'loudness': {'I': -15, 'TP': -1.5, 'LRA': 11},
        'still_qscale': 3,
        'frame': [1920, 1080],
        'duration_tolerance_s': 0.1,
        'require_content_gate': True,
        'content_gate': None,
        'review_pack': {'every_s': 1, 'per_sheet': 12, 'width': 640, 'model': 'mlx-community/whisper-large-v3-turbo',
                        'language': 'en'},
    },
}

OPT = None
PREVIEW = {}
RENDER_LOCK = None
LOCK_HELD_ENV = 'FILM_RENDER_LOCK_HELD'
PLAN = None       # the recorded steps while a plan is made, else None
PLAN_COPIES = {}  # a project path of the plan -> its scratch copy, where FilmCraft's own commands run


@contextlib.contextmanager
def render_lock():
    """One render at a time on this computer, across every chapter: an exclusive flock on the settings' lock.file.

    Reentrant across processes: whoever holds it sets FILM_RENDER_LOCK_HELD to the lock's path, and a child that sees it
    runs without taking it again (a parent wrapper plus this lock used to deadlock every lane)."""
    # Film renders yield the computer to the person's other work: lowest CPU priority, inherited by every child (filmcraft-cli, ffmpeg).
    try:
        os.setpriority(os.PRIO_PROCESS, 0, 20)
    except OSError:
        pass
    if not RENDER_LOCK or PLAN is not None:  # no lock named, or a plan (which renders nothing)
        yield
        return
    if os.path.realpath(os.environ.get(LOCK_HELD_ENV) or '/nonexistent') == os.path.realpath(RENDER_LOCK):
        yield
        return
    with open(RENDER_LOCK, 'a') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        _wait_while_urgent(**URGENT_WAIT)
        os.environ[LOCK_HELD_ENV] = os.path.realpath(RENDER_LOCK)
        os.environ['OVERLAY_RENDER_LOCK_HELD'] = os.path.realpath(RENDER_LOCK)  # the overlay tool, run under this hold, takes no second flock
        try:
            yield
        finally:
            os.environ.pop(LOCK_HELD_ENV, None)
            os.environ.pop('OVERLAY_RENDER_LOCK_HELD', None)
            fcntl.flock(f, fcntl.LOCK_UN)


# The build is the one this computer reports (FILMCRAFT_CLI), else `filmcraft-cli` on its PATH; no checkout under a home folder is assumed.
# (Then the settings' filmcraft_cli.)
FILMCRAFT_CLI = os.environ.get('FILMCRAFT_CLI') or 'filmcraft-cli'
NICE = 10


def filmcraft_cli(project, *args, save=False):
    """Run one filmcraft-cli command on a project and return its output. An export (args[0] == 'export') is a render: it runs
    inside render_lock, so every export in every lane, however it is called, waits its turn."""
    if args and args[0] == 'export':
        with render_lock():
            return _filmcraft(project, args, save)
    return _filmcraft(project, args, save)


def filmcraft_export(project, out, start, end, scale=0.5, quality=70, fmt='h264'):
    """Export start..end seconds of the project's sequence to out (the one shared export entry point; locked)."""
    return filmcraft_cli(project, 'export', out, '--format', fmt, '--start', str(start), '--end', str(end),
                         '--scale', str(scale), '--quality', str(quality))


def _filmcraft(project, args, save):
    cmd = [FILMCRAFT_CLI, '--project', project, '--compact'] + (['--save'] if save else []) + list(args)
    if PLAN is not None:
        step = {'argv': cmd, 'nice': NICE}  # run as nice -n 10
        if args and args[0] == 'run':
            with open(args[1]) as fh:
                step['ops'] = [json.loads(line) for line in fh if line.strip()]
        PLAN.append(step)
        if args and args[0] == 'export':
            return ''
        cmd = [FILMCRAFT_CLI, '--project', PLAN_COPIES.get(project, project), '--compact'] + (['--save'] if save else []) + list(args)
    r = subprocess.run(['nice', '-n', '10'] + cmd, capture_output=True, text=True, cwd='/tmp')
    if r.returncode:
        raise SystemExit(f'filmcraft-cli failed: {" ".join(args)[:200]}\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}')
    return r.stdout


def run_program(argv, **kw):
    """ffmpeg, ffprobe or another program, run as subprocess.run(argv, **kw); in a plan, recorded and not run."""
    if PLAN is not None:
        PLAN.append({'argv': list(argv)})
        return subprocess.CompletedProcess(argv, 0, '', '')
    return subprocess.run(argv, **kw)


def planning():
    return PLAN is not None


def plan_steps():
    return PLAN


def plan_note(**step):
    """A step a plan names without running it (copy, mkdir, move, link, remove)."""
    if PLAN is not None:
        PLAN.append(step)


def copy_project(base, proj):
    """The option's own copy of the base project. In a plan, a scratch copy stands in for it (FilmCraft's commands run there)."""
    if PLAN is not None:
        plan_note(copy=[base, proj])
        scratch = os.path.join(tempfile.mkdtemp(prefix='fc-plan-'), os.path.basename(proj))
        shutil.copyfile(base, scratch)
        PLAN_COPIES[proj] = scratch
        return
    os.makedirs(os.path.dirname(proj), exist_ok=True)
    shutil.copyfile(base, proj)


def makedirs(path):
    if PLAN is not None:
        plan_note(mkdir=path)
        return
    os.makedirs(path, exist_ok=True)


URGENT_FLAG = None  # settings lock.wait_while.file: while it says lock.wait_while.says, a render waits
URGENT_WORD = 'urgent'
URGENT_WAIT = {}


def _wait_while_urgent(poll_s=15, max_s=1800):
    """Before a render starts, wait while the flag file says so (for example while urgent work lands), so no gate trips on load.
    Gives up after max_s and renders anyway, saying so, in case the flag was left behind."""
    import time
    if not URGENT_FLAG:
        return
    waited = 0
    while waited < max_s:
        try:
            with open(URGENT_FLAG) as fh:
                if fh.read().strip() != URGENT_WORD:
                    return
        except OSError:
            return
        if waited == 0:
            print(f'render_lock: {URGENT_FLAG} says {URGENT_WORD}; waiting before this render', file=sys.stderr, flush=True)
        time.sleep(poll_s)
        waited += poll_s
    print(f'render_lock: {URGENT_FLAG} still says {URGENT_WORD} after {max_s} s; rendering anyway', file=sys.stderr, flush=True)


def round_of(oid):
    pattern = PREVIEW.get('round_pattern')
    try:
        if not pattern:
            return int(oid.split('-')[1][1:])
        return int(re.match(pattern, oid).group(1))
    except (IndexError, ValueError, AttributeError):
        raise SystemExit(f'{oid}: no round in this option id (m02-r4-1 is round 4; settings round_pattern names another form)') from None


def rdir(kind, oid, *parts):
    """kind: specs, out, projects, previews or work."""
    if kind in PREVIEW.get('layout', {}):
        return os.path.join(OPT, PREVIEW['layout'][kind].format(round=round_of(oid)), *parts)
    return os.path.join(OPT, f'{kind}-round-{round_of(oid)}', *parts)


def watch_dir(oid):
    if 'watch' in PREVIEW.get('layout', {}):
        return os.path.join(OPT, PREVIEW['layout']['watch'].format(round=round_of(oid)))
    return os.path.join(OPT, f'ROUND {round_of(oid)} - watch these')


def odir(oid, *parts):
    """The option's own render folder: out-round-<n>/<id>/ (overlay.mov, sound.wav, timeline.json, its scratch)."""
    return rdir('out', oid, oid, *parts)


# --- the request, its settings and the option's folders ---

def door_read(record_id):
    """One record of the person's own list:settings, read through their records door (the trillion command)."""
    try:
        done = subprocess.run([TRILLION, 'op', '@own-records', 'records:read', json.dumps({'id': record_id, 'type': 'record:setting'})],
                              capture_output=True, text=True)
    except OSError as problem:
        done = subprocess.CompletedProcess([], 127, '', str(problem))
    if done.returncode:
        raise SystemExit(f'could not read {record_id} through `{TRILLION}`: {(done.stderr or done.stdout).strip()[:300]}. '
                         'Give settings_record as the record itself, or settings.')
    record = json.loads(done.stdout)
    if record.get('value') is None:
        raise SystemExit(f'no {record_id} in the person\'s list:settings: write the film\'s settings row first, or give settings')
    return {**record, 'id': record_id}


def read_settings(req):
    import settings as reader  # tools/settings/read-data/settings.py
    given = req.get('settings_record')
    if isinstance(given, str) and given.startswith(reader.ID_PREFIX):
        given = door_read(given)
    if given is not None:
        try:
            found = reader.chosen(given, FOLDER)
        except reader.SettingError as problem:
            raise SystemExit(str(problem))
        if found is None:
            raise SystemExit(f'settings_record holds no row of {FOLDER}')
        tool = (found.get('value') if isinstance(found.get('value'), dict) else found).get('tool')
        if tool and tool not in TOOLS:
            raise SystemExit(f'settings_record holds settings for {tool}, not for this folder\'s tools ({", ".join(TOOLS)})')
        given = found
    try:
        return reader.request_settings({**req, 'settings_record': given}, DEFAULTS, folder=FOLDER)
    except reader.SettingError as problem:
        raise SystemExit(str(problem))


def under(root, path):
    return path if path is None or os.path.isabs(os.path.expanduser(path)) else os.path.join(root, path)


def configure(req):
    """Read the request's settings and point every path of this module at the option's chapter. Returns the settings."""
    global OPT, RENDER_LOCK, FILMCRAFT_CLI, NICE, URGENT_FLAG, URGENT_WORD, URGENT_WAIT, PLAN
    cfg = read_settings(req)
    pv = cfg['preview']
    film = req.get('film')
    oid = req.get('option')
    if not oid or not isinstance(oid, str):
        raise SystemExit('the request names no option: give option, the option id (its round is part of it, e.g. m02-r4-1)')
    chapter = req.get('chapter')
    folder = req.get('options_folder')
    if folder is None:
        chapters = pv.get('chapters') or {}
        if chapter is None:
            chapter = next((name for name, ch in chapters.items() if re.match(ch.get('option_ids', '$^'), oid)), None)
        if chapter not in chapters:
            raise SystemExit(f'{oid}: no chapter of the settings holds it ({", ".join(chapters) or "none"}); give chapter, '
                             'or options_folder, or add the chapter to settings preview.chapters')
        if not film:
            raise SystemExit('give film, the film\'s folder (the chapters\' folders are named relative to it)')
        folder = under(film, chapters[chapter]['options_folder'])
        pv = {**pv, **{k: v for k, v in chapters[chapter].items() if k not in ('options_folder', 'option_ids')}}
    OPT = os.path.abspath(os.path.expanduser(folder))
    film = os.path.abspath(os.path.expanduser(film)) if film else os.path.normpath(os.path.join(OPT, '..', '..'))
    PREVIEW.clear()
    PREVIEW.update(pv, film=film, chapter=chapter, request=req)
    PREVIEW['layout'] = dict(pv.get('layout') or {})
    lock = pv.get('lock') or req.get('lock')
    RENDER_LOCK = os.path.expanduser(under(film, lock['file'])) if lock else None
    ww = (lock or {}).get('wait_while') or {}
    URGENT_FLAG, URGENT_WORD = (os.path.expanduser(ww['file']) if ww.get('file') else None), ww.get('says', 'urgent')
    URGENT_WAIT = {k: ww[k] for k in ('poll_s', 'max_s') if k in ww}
    FILMCRAFT_CLI = os.environ.get('FILMCRAFT_CLI') or cfg.get('filmcraft_cli') or 'filmcraft-cli'
    PLAN = [] if req.get('plan') else None
    PLAN_COPIES.clear()
    return cfg


def base_project():
    return os.path.expanduser(under(OPT, PREVIEW['base_project']))


def spec_of(oid):
    """The option's spec: the request's own `spec`, else specs-round-<n>/<id>.json in the option folder. A relative picture
    in edit.hold_picture is read against the film's folder."""
    spec = PREVIEW['request'].get('spec')
    if spec is None:
        path = rdir('specs', oid, oid + '.json')
        if not os.path.exists(path):
            raise SystemExit(f'{oid}: no spec at {path}; give spec, or check the option id and the chapter')
        with open(path) as fh:
            spec = json.load(fh)
    if 'edit' not in spec:
        raise SystemExit(f'{oid}: the spec has no edit block (what FilmCraft builds: preview, and any of prepend, cuts, hold, overlay, ...)')
    hp = spec['edit'].get('hold_picture')
    if hp:
        for one in hp if isinstance(hp, list) else [hp]:
            one['image'] = under(PREVIEW['film'], one['image'])
    return spec


def read_request(argv):
    """The request: the JSON file named as the first argument, else standard input."""
    text = open(argv[1]).read() if len(argv) > 1 else sys.stdin.read()
    try:
        req = json.loads(text or '{}')
    except json.JSONDecodeError as err:
        raise SystemExit(f'the request is not JSON ({err}); send one JSON object')
    if not isinstance(req, dict):
        raise SystemExit('the request must be one JSON object')
    return req


def answer(fn, argv=None):
    """Run fn(request) and print its answer as the last line: {"result": ...}, or {"error": ...} and exit 1."""
    try:
        req = read_request(argv if argv is not None else sys.argv)
        result = fn(req)
    except SystemExit as stop:
        if stop.code in (None, 0):
            raise
        print(json.dumps({'error': str(stop.code)}))
        raise SystemExit(1)
    print(json.dumps({'result': result}))

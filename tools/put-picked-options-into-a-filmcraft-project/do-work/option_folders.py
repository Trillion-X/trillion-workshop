"""Where an option's files live. The round is part of the option id (m02-r4-1 -> round 4), so one set of tools serves every
round: specs-round-<n>/, out-round-<n>/, projects-round-<n>/, previews-round-<n>/, work-round-<n>/, "ROUND <n> - watch these".

The option folder is options-ch1 (where these tools live) unless FILMCRAFT_OPT names another lane's folder (options-ch2, ...):
the same tools then read and write that lane's rounds. Renders across all lanes take one lock (render_lock)."""
import contextlib, fcntl, os, subprocess

TOOLS_OPT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OPT = os.path.abspath(os.environ.get('FILMCRAFT_OPT') or TOOLS_OPT)
RENDER_LOCK = os.path.join(os.path.dirname(TOOLS_OPT), 'full-film', '.render.lock')
LOCK_HELD_ENV = 'FILM_RENDER_LOCK_HELD'


@contextlib.contextmanager
def render_lock():
    """One render at a time on this Mac, across every lane: an exclusive flock on filmcraft/full-film/.render.lock.

    Reentrant across processes: whoever holds it sets FILM_RENDER_LOCK_HELD to the lock's path, and a child that sees it
    runs without taking it again (a parent wrapper plus this lock used to deadlock every lane)."""
    # Film renders yield the Mac to live-account work: lowest CPU priority, inherited by every child (filmcraft-cli, ffmpeg, Blender).
    try:
        os.setpriority(os.PRIO_PROCESS, 0, 20)
    except OSError:
        pass
    if os.path.realpath(os.environ.get(LOCK_HELD_ENV) or '/nonexistent') == os.path.realpath(RENDER_LOCK):
        yield
        return
    with open(RENDER_LOCK, 'a') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        _wait_while_urgent()
        os.environ[LOCK_HELD_ENV] = os.path.realpath(RENDER_LOCK)
        try:
            yield
        finally:
            os.environ.pop(LOCK_HELD_ENV, None)
            fcntl.flock(f, fcntl.LOCK_UN)


# A build that reads project schema v16. The old default under /tmp/pf/pkgapp-3 was wiped by a reboot (found 2026-10-28);
# this is the Oct 19 release build the installed app came from, and it reads base-graded-copy.fcproj.
# The build is the one this place reports (FILMCRAFT_CLI), else `filmcraft-cli` on its PATH; no checkout under a home folder is assumed.
FILMCRAFT_CLI = os.environ.get('FILMCRAFT_CLI') or 'filmcraft-cli'


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
    r = subprocess.run(['nice', '-n', '10'] + cmd, capture_output=True, text=True, cwd='/tmp')
    if r.returncode:
        raise SystemExit(f'filmcraft-cli failed: {" ".join(args)[:200]}\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}')
    return r.stdout


URGENT_FLAG = '/tmp/deploy-gate-lock/class'  # the Mac test queue writes "urgent" here while a live-account fix lands


def _wait_while_urgent(poll_s=15, max_s=1800):
    """Before a render starts, wait while a live-account fix is landing (about 5-10 min), so no gate trips on load.
    Gives up after max_s and renders anyway, saying so, in case the flag was left behind."""
    import time
    waited = 0
    while waited < max_s:
        try:
            with open(URGENT_FLAG) as fh:
                if fh.read().strip() != 'urgent':
                    return
        except OSError:
            return
        if waited == 0:
            print('render_lock: a live-account fix is landing (urgent); waiting before this render', flush=True)
        time.sleep(poll_s)
        waited += poll_s
    print(f'render_lock: urgent flag still set after {max_s} s; rendering anyway', flush=True)


def round_of(oid):
    return int(oid.split('-')[1][1:])


def rdir(kind, oid, *parts):
    """kind: specs, out, projects, previews or work."""
    return os.path.join(OPT, f'{kind}-round-{round_of(oid)}', *parts)


def watch_dir(oid):
    return os.path.join(OPT, f'ROUND {round_of(oid)} - watch these')


def odir(oid, *parts):
    """The option's own render folder: out-round-<n>/<id>/ (overlay.mov, sound.wav, timeline.json, its scratch)."""
    return rdir('out', oid, oid, *parts)

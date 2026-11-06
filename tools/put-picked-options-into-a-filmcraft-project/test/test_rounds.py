#!/usr/bin/env python3
"""The shared render lock and export road (option_folders.py, filmcraft_preview.py):
  - render_lock is reentrant for its own children and nested calls, still excludes a stranger, lowers the process to the lowest
    priority (nice 20 where the system allows it, 19 on Linux), and waits while the wait flag says so (gives up after max_s);
  - every filmcraft-cli export runs inside the lock (option_folders.filmcraft_cli / filmcraft_export, and filmcraft_preview.cli), other
    commands do not take it;
  - filmcraft_preview.main() takes the lock when imported and called (not only under __main__), and two ids never share an
    export scratch.
Ported from the film repository's test_rounds.py; its 14 checks unchanged but for the priority on Linux and the module names.
Run: python3 test_rounds.py (temporary lock, flag and fake filmcraft-cli only; never a real lock or the real CLI)."""
import fcntl, os, stat, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
DO = os.path.join(HERE, '..', 'do-work')
sys.path.insert(0, DO)
import option_folders as rounds  # noqa: E402

CHILD = '''
import sys
sys.path.insert(0, {here!r})
import option_folders as rounds
rounds.RENDER_LOCK, rounds.URGENT_FLAG = {lock!r}, {flag!r}
with rounds.render_lock():
    print('rendered')
'''

STRANGER = '''
import fcntl, sys
f = open({lock!r}, 'a')
try:
    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print('got it')
except BlockingIOError:
    print('excluded')
'''

# A stand-in filmcraft-cli: reports whether it ran inside the lock (the env mark, and the flock really held by someone).
FAKE_CLI = '''#!/usr/bin/env python3
import fcntl, os, sys
lock = os.environ['TEST_LOCK']
f = open(lock, 'a')
try:
    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    held = False
except BlockingIOError:
    held = True
print(('locked' if held and os.environ.get('FILM_RENDER_LOCK_HELD') else 'unlocked') + ' ' + ' '.join(sys.argv[4:5]))
'''


def run(code, env):
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False) as fh:
        fh.write(code)
    try:
        return subprocess.run([sys.executable, fh.name], env=env, capture_output=True, text=True, timeout=20).stdout.strip()
    finally:
        os.remove(fh.name)


def main():
    n = 0
    os.environ.pop(rounds.LOCK_HELD_ENV, None)
    with tempfile.TemporaryDirectory() as d:
        lock, flag = os.path.join(d, '.render.lock'), os.path.join(d, 'class')
        rounds.RENDER_LOCK, rounds.URGENT_FLAG = lock, flag
        assert rounds.LOCK_HELD_ENV not in os.environ

        with rounds.render_lock():
            held = os.environ.get(rounds.LOCK_HELD_ENV)
            assert held == os.path.realpath(lock), held; n += 1
            assert os.getpriority(os.PRIO_PROCESS, 0) >= 19, 'render_lock lowers the process to the lowest priority'; n += 1
            with rounds.render_lock():  # nested in the same process: no second flock, no deadlock
                pass
            assert os.environ.get(rounds.LOCK_HELD_ENV) == held, 'the inner exit must not release the outer hold'; n += 1
            assert run(CHILD.format(here=DO, lock=lock, flag=flag), dict(os.environ)) == 'rendered', 'child of the holder must run'; n += 1
            stranger_env = {k: v for k, v in os.environ.items() if k != rounds.LOCK_HELD_ENV}
            assert run(STRANGER.format(lock=lock), stranger_env) == 'excluded', 'a process outside the holder must wait'; n += 1
        assert rounds.LOCK_HELD_ENV not in os.environ
        f = open(lock, 'a')
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)  # released on exit
        f.close(); n += 1

        # urgent flag: no file or another word -> no wait; "urgent" -> waits, and gives up after max_s
        t = time.monotonic(); rounds._wait_while_urgent(poll_s=0.05, max_s=0.3)
        assert time.monotonic() - t < 0.1, 'no flag file: no wait'; n += 1
        open(flag, 'w').write('normal\n')
        t = time.monotonic(); rounds._wait_while_urgent(poll_s=0.05, max_s=0.3)
        assert time.monotonic() - t < 0.1, 'flag not urgent: no wait'; n += 1
        open(flag, 'w').write('urgent\n')
        t = time.monotonic(); rounds._wait_while_urgent(poll_s=0.05, max_s=0.3)
        assert time.monotonic() - t >= 0.3, 'urgent: waits until max_s'; n += 1
        os.remove(flag)

        # exports run inside the lock, other commands do not take it
        cli = os.path.join(d, 'filmcraft-cli')
        open(cli, 'w').write(FAKE_CLI)
        os.chmod(cli, os.stat(cli).st_mode | stat.S_IXUSR)
        rounds.FILMCRAFT_CLI = cli
        os.environ['TEST_LOCK'] = lock
        assert rounds.filmcraft_export('p.fcproj', 'out.mp4', 1, 2).strip() == 'locked export', 'filmcraft_export runs locked'; n += 1
        assert rounds.filmcraft_cli('p.fcproj', 'inspect', 'project').strip() == 'unlocked inspect', 'other commands do not lock'; n += 1
        import filmcraft_preview
        assert filmcraft_preview.cli('p.fcproj', 'export', 'o.mp4').strip() == 'locked export', 'filmcraft_preview.cli export runs locked'; n += 1

        # filmcraft_preview.main() imported and called holds the lock; two ids never share a scratch
        seen = []
        real = filmcraft_preview._main
        filmcraft_preview._main = lambda oid=None: seen.append(os.environ.get(rounds.LOCK_HELD_ENV))
        try:
            filmcraft_preview.main()
        finally:
            filmcraft_preview._main = real
        assert seen == [os.path.realpath(lock)], 'main() takes the lock when imported and called'; n += 1
        rounds.OPT = d
        rounds.PLACE.clear()
        rounds.PLACE.update(layout={})
        a, b = filmcraft_preview.export_paths('m09-r7-1'), filmcraft_preview.export_paths('m09-r7-2')
        assert a[0] != b[0] and a[0].endswith('_export-m09-r7-1.mp4'), 'two ids never share an export scratch'; n += 1
        del os.environ['TEST_LOCK']
    print(f'test_rounds: {n} checks pass')


if __name__ == '__main__':
    main()

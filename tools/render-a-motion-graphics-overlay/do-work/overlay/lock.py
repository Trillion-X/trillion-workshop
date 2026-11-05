"""One render at a time on this computer: the render lock and the wait while a flag file says so. Needs no settings."""
import contextlib
import fcntl
import os
import time


@contextlib.contextmanager
def render_lock(lock):
    """One render at a time on this computer, when the request names a lock: an exclusive flock on lock.file, taken once per
    process tree (a child that sees OVERLAY_RENDER_LOCK_HELD set to the same file runs without taking it again). A render
    runs at the lowest CPU priority, so it yields to the person's other work. lock.wait_while {file, says, poll_s, max_s}:
    before rendering, wait while that file holds those words (for example while urgent work lands), up to max_s, then
    render anyway and say so."""
    try:
        os.setpriority(os.PRIO_PROCESS, 0, 20)
    except OSError:
        pass
    if not lock:
        yield
        return
    path = os.path.realpath(lock['file'])
    if os.path.realpath(os.environ.get('OVERLAY_RENDER_LOCK_HELD') or '/nonexistent') == path:
        yield
        return
    with open(path, 'a') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        if lock.get('wait_while'):
            wait_while(**lock['wait_while'])
        os.environ['OVERLAY_RENDER_LOCK_HELD'] = path
        try:
            yield
        finally:
            os.environ.pop('OVERLAY_RENDER_LOCK_HELD', None)
            fcntl.flock(f, fcntl.LOCK_UN)


def wait_while(file, says, poll_s=15, max_s=1800):
    waited = 0
    while waited < max_s:
        try:
            with open(file) as fh:
                if fh.read().strip() != says:
                    return
        except OSError:
            return
        if waited == 0:
            print(f'render_lock: {file} says {says}; waiting before this render', flush=True)
        time.sleep(poll_s)
        waited += poll_s
    print(f'render_lock: {file} still says {says} after {max_s} s; rendering anyway', flush=True)

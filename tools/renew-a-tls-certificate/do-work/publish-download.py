"""Compare actual incoming download bytes before changing its public pointer."""
import fcntl
import os
from pathlib import Path
import stat
import sys
import tempfile


def same_bytes(left, right):
    with left.open('rb') as a, right.open('rb') as b:
        while True:
            chunk = a.read(1024 * 1024)
            if chunk != b.read(1024 * 1024):
                return False
            if not chunk:
                return True


def publish(folder, kept, name, expected, source):
    folder = Path(folder)
    folder.mkdir(mode=0o755, parents=True, exist_ok=True)
    # Serialize publications by this owner. Staging stays hidden from nginx.
    with (folder / '.publish-download.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix='.publish-', dir=folder) as staging:
            staging = Path(staging)
            incoming = staging / 'incoming'
            count = 0
            with incoming.open('wb') as target:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > expected:
                        raise ValueError('The incoming download has a different size.')
                    target.write(chunk)
                target.flush()
                os.fsync(target.fileno())
            if count != expected:
                raise ValueError('The incoming download has a different size.')
            incoming.chmod(0o644)
            published = folder / name
            if published.is_symlink():
                previous = os.readlink(published)
            elif published.exists():
                raise ValueError('A public pointer cannot replace a retained file.')
            else:
                previous = None
            retained = folder / kept
            try:
                # Never replace an existing retained name, including a symlink.
                os.link(incoming, retained)
            except FileExistsError:
                if not stat.S_ISREG(retained.lstat().st_mode) or not same_bytes(incoming, retained):
                    raise ValueError('The retained download has different bytes.')
            pointer = staging / 'pointer'
            pointer.symlink_to(kept)
            default = staging / 'default'
            default.write_text(f'return 302 /download/{name};\n', encoding='utf8')
            default.chmod(0o644)
            os.replace(pointer, published)
            try:
                os.replace(default, folder / '.default-download.conf')
            except OSError:
                try:
                    if previous is None:
                        published.unlink()
                    else:
                        pointer.symlink_to(previous)
                        os.replace(pointer, published)
                except OSError as recovery_error:
                    raise RuntimeError('The download publication outcome is unknown: pointer recovery failed.') from recovery_error
                raise
            return count


if __name__ == '__main__':
    try:
        print(publish(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.stdin.buffer))
    except RuntimeError as error:
        sys.stderr.write(f'{error}\n')
        sys.exit(1)
    except ValueError:
        # No file contents or raw process buffers leave this owner on failure.
        sys.stderr.write('The download was not published: size or retained bytes were refused.\n')
        sys.exit(1)
    except OSError:
        sys.stderr.write('The download publication did not complete; retained bytes may exist.\n')
        sys.exit(1)

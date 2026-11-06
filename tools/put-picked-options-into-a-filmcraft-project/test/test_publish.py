#!/usr/bin/env python3
"""publish_preview.link_into never leaves its temporary link behind.
Ported from the film repository's test_publish.py; its five cases unchanged.
Run: python3 test_publish.py (temporary folders only)."""
import os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'do-work'))
from publish_preview import link_into  # noqa: E402

TMP = '.x-r1-1.linking'


def leftovers(folder):
    return [n for n in os.listdir(folder) if n.endswith('.linking')]


def make(path, text):
    with open(path, 'w') as f:
        f.write(text)


def main():
    with tempfile.TemporaryDirectory() as d:
        src, folder = os.path.join(d, 'x-r1-1.mp4'), os.path.join(d, 'watch')
        os.makedirs(folder)
        make(src, 'new')
        final = os.path.join(folder, 'A.mp4')

        link_into(src, folder, 'A.mp4', TMP)  # a new name
        assert os.path.samefile(src, final) and not leftovers(folder)

        link_into(src, folder, 'A.mp4', TMP)  # the final name already is this file: rename(2) would be a no-op
        assert os.path.samefile(src, final) and not leftovers(folder)

        os.unlink(final)
        make(final, 'old')  # a different file under the final name is replaced
        link_into(src, folder, 'A.mp4', TMP)
        assert os.path.samefile(src, final) and not leftovers(folder)

        os.unlink(final)
        make(os.path.join(folder, TMP), 'stale')  # a stale temporary link from an interrupted run
        link_into(src, folder, 'A.mp4', TMP)
        assert os.path.samefile(src, final) and not leftovers(folder)

        os.makedirs(os.path.join(folder, 'B.mp4', 'inside'))  # the rename fails: the final name is a non-empty folder
        try:
            link_into(src, folder, 'B.mp4', TMP)
            raise AssertionError('rename onto a folder should fail')
        except OSError:
            pass
        assert not leftovers(folder), leftovers(folder)
    print('test_publish: 5 cases pass')


if __name__ == '__main__':
    main()

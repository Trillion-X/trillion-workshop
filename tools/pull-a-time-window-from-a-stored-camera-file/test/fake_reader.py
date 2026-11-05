#!/usr/bin/env python3
"""A stand-in for the person's reader command: serves one byte range of a local file as the stored file.

usage: fake_reader.py <store> <account> one <identity> <out> <offset> <length>

<store> is the path of the local file standing for the stored one. Every range served is appended to the file named by
FAKE_READER_LOG as "offset length", so a test can see exactly which bytes were asked for. FAKE_READER_FAIL_FIRST=n makes
the first n calls fail, to test the retry. Nothing is read from any network or any real store.
"""
import os
import sys
from pathlib import Path

store, account, mode, identity, out, offset, length = sys.argv[1:8]
if mode != 'one' or not account or not identity:
    print('refused')
    sys.exit(2)
counter = Path(os.environ['FAKE_READER_LOG'] + '.calls')
calls = int(counter.read_text()) if counter.exists() else 0
counter.write_text(str(calls + 1))
if calls < int(os.environ.get('FAKE_READER_FAIL_FIRST', '0')):
    print('busy')
    sys.exit(1)
with open(store, 'rb') as f:
    f.seek(int(offset))
    data = f.read(int(length))
Path(out).write_bytes(data)
with open(os.environ['FAKE_READER_LOG'], 'a') as log:
    log.write(f'{offset} {len(data)}\n')
print('ok-range')

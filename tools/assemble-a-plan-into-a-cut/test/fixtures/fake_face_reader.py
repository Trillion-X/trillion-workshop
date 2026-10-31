"""A stand-in face reader for the tests: one line per picture file, the same made-up face on each.

usage: python3 fake_face_reader.py <face x> <picture> ...

Prints `<name> eyes 0.400 (L 0.400 R 0.400) mouth 0.100 box <face x> 60 120 140` for each file, the line a real face reader prints.
"""
import os
import sys

x = sys.argv[1]
for path in sys.argv[2:]:
    print(f'{os.path.basename(path)} eyes 0.400 (L 0.400 R 0.400) mouth 0.100 box {x} 60 120 140')

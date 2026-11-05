#!/usr/bin/env python3
"""Sorted eye openness (min of the two eyes) of frames from vision_landmarks.py JSON: eye_table.py <json>"""
import json
import sys

d = json.load(open(sys.argv[1]))
rows = sorted((min(e for e in f['eye_open'] if e is not None), p[-8:-4], round(f['mouth_open'] or 0, 2)) for p, fs in d.items() for f in fs[:1] if any(e is not None for e in f['eye_open']))
print(len(rows), 'frames with a face of', len(d))
print([(round(a, 3), b, m) for a, b, m in rows[:14]])
print('median', round(rows[len(rows) // 2][0], 3), 'p10', round(rows[len(rows) // 10][0], 3))

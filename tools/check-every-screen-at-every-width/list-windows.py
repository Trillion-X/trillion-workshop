# tools/check-every-screen-at-every-width/list-windows.py
#
# Purpose: the windows one owner has on this Mac, as JSON (id, name, layer, width, height, onscreen), read from the window server
# (CGWindowListCopyWindowInfo). It reads only: it clicks, types and moves no focus, so a window the person is using is not touched.
#
# Non-Negotiable Invariants:
#   1. Read-only. No window is raised, resized, clicked or given focus.
#   2. Prints one JSON line on stdout and nothing else on success.
#
# Usage: python3 -I list-windows.py OWNER_NAME
import json
import sys

import Quartz

owner = sys.argv[1]
rows = []
for window in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID):
    if window.get('kCGWindowOwnerName') != owner:
        continue
    bounds = window.get('kCGWindowBounds', {})
    rows.append({
        'id': int(window['kCGWindowNumber']),
        'name': str(window.get('kCGWindowName', '')),
        'layer': int(window.get('kCGWindowLayer', 0)),
        'width': int(bounds.get('Width', 0)),
        'height': int(bounds.get('Height', 0)),
        'onscreen': bool(window.get('kCGWindowIsOnscreen', False)),
    })
print(json.dumps(rows))

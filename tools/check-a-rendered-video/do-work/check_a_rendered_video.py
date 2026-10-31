#!/usr/bin/env python3
"""check-a-rendered-video check <video.mp4> [--spec <spec.json>] | check-a-rendered-video batch <videos-dir> [--specs <specs-dir>]

Run from anywhere: python3 tools/check-a-rendered-video/do-work/check_a_rendered_video.py check my-video.mp4 --spec my-video.json
Python puts this file's folder first on its search path, so the rendercheck package beside it is found."""
import sys

from rendercheck.cli import main

if __name__ == '__main__':
    sys.exit(main())

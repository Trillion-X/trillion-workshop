"""Colocated test for build_preview_sheet in embed-video-frames-clip.py.

The PRODUCER half of the media-search sprite-sheet fix: tile every kept frame
into ONE JPEG and return one self-describing region per frame. The grid's
CSS-sprite crop (mount-media-search.tsx) depends on this geometry being exact
(x/y offsets, per-tile width/height, and sheet_width/sheet_height on every
region). Uses tiny synthetic PIL images -- zero model/video/GPU dependency.

Run: python3 test_build_preview_sheet.py   (also pytest-discoverable)
"""

import importlib.util
import sys
import tempfile
from pathlib import Path

from PIL import Image

MODULE_PATH = Path(__file__).resolve().parent.parent / "do-work" / "embed-video-frames-clip.py"
_spec = importlib.util.spec_from_file_location("evfc_sheet", MODULE_PATH)
mod = importlib.util.module_from_spec(_spec)
sys.modules["evfc_sheet"] = mod
_spec.loader.exec_module(mod)

_TILE_W = 240


def _img(w, h, color=(10, 20, 30)):
    return Image.new("RGB", (w, h), color)


def _sheet_path():
    d = tempfile.mkdtemp(prefix="sprite-test-")
    return str(Path(d) / "preview-sheet.jpg")


def test_empty_returns_no_regions():
    assert mod.build_preview_sheet([], _sheet_path()) == []


def test_single_column_vertical_stack():
    # 3 frames already at tile width, huge max_dimension -> 1 column, 3 rows.
    frames = [_img(_TILE_W, 135) for _ in range(3)]
    regions = mod.build_preview_sheet(frames, _sheet_path(), tile_width=_TILE_W)
    assert len(regions) == 3, len(regions)
    assert [(r["x"], r["y"]) for r in regions] == [(0, 0), (0, 135), (0, 270)]
    for r in regions:
        assert r["width"] == _TILE_W and r["height"] == 135
        assert r["sheet_width"] == _TILE_W and r["sheet_height"] == 405  # 3 rows * 135


def test_wider_frame_resized_preserving_aspect():
    # 480x270 -> resized to 240x135 (half); region reflects the resized tile.
    regions = mod.build_preview_sheet([_img(480, 270)], _sheet_path(), tile_width=_TILE_W)
    assert len(regions) == 1
    assert regions[0]["width"] == _TILE_W and regions[0]["height"] == 135


def test_column_wrapping_respects_max_dimension():
    # tile_height=135, max_dimension=300 -> max_rows = 300//135 = 2.
    # 4 frames -> columns=ceil(4/2)=2, rows=ceil(4/2)=2 (row-major fill).
    frames = [_img(_TILE_W, 135) for _ in range(4)]
    regions = mod.build_preview_sheet(frames, _sheet_path(), tile_width=_TILE_W, max_dimension=300)
    assert [(r["x"], r["y"]) for r in regions] == [(0, 0), (240, 0), (0, 135), (240, 135)]
    for r in regions:
        assert r["sheet_width"] == 480 and r["sheet_height"] == 270  # 2 cols, 2 rows


def test_saved_sheet_is_valid_jpeg_matching_region_dims():
    path = _sheet_path()
    frames = [_img(_TILE_W, 135) for _ in range(3)]
    regions = mod.build_preview_sheet(frames, path, tile_width=_TILE_W)
    assert Path(path).is_file(), "sheet JPEG not written"
    with Image.open(path) as im:
        assert im.format == "JPEG"
        # the actual sheet dimensions must equal what the regions advertise
        assert im.size == (regions[0]["sheet_width"], regions[0]["sheet_height"]), im.size


def _checks():
    yield "empty -> []", test_empty_returns_no_regions
    yield "single-column vertical stack geometry", test_single_column_vertical_stack
    yield "wider frame resized preserving aspect", test_wider_frame_resized_preserving_aspect
    yield "column wrapping respects max_dimension", test_column_wrapping_respects_max_dimension
    yield "saved sheet is valid JPEG matching region dims", test_saved_sheet_is_valid_jpeg_matching_region_dims


def main() -> int:
    failed = 0
    for name, fn in _checks():
        try:
            fn()
            print(f"PASS  {name}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {name}\n      {e}")
    print(f"\n{'ALL PASS' if failed == 0 else str(failed) + ' FAILED'} ({sum(1 for _ in _checks())} checks)")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

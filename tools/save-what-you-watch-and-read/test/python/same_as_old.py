"""Comparing two decoders on what a person keeps from a decoded export, and making the fixtures that hold the new
reader to what the decoders it replaced gave.

`projection` reduces a decoded export to each thread's id and title, each atom's native id, kind, words, time and
speaker, and how many things were rejected.

`make_fixtures(old_packages_folder)` is run once, by a person who has the old decoder packages on disk (see
test_same_as_old.py): it loads each old decoder with its own mapper (read-only), decodes each made-up export below,
and returns the export and the old answer for fixtures/old_outputs.json."""
import importlib.util
import json
import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
OBSERVATION = {"source_ref": "source:proof", "batch_ref": "batch:proof", "observed_at": "2026-01-01T00:00:00Z"}

BOOKMARKS = {"user_id": "12345", "bookmarks": [
    {"id": "9001", "text": "Rye needs a long rise", "created_at": "2026-01-02T08:00:00Z", "author_id": "baker"},
    {"id": "9002", "text": "Mine too", "created_at": "2026-01-02T09:00:00Z", "author_id": "12345"}]}


def projection(result):
    threads = sorted((str(t.get("session_id") or t.get("native_ref")), t.get("title")) for t in result["threads"])
    atoms = sorted(
        (str(a.get("native_ref")), str(a.get("kind")), (a.get("content") or {}).get("text") or "",
         str(a.get("at")), json.dumps(a.get("speaker_ref"), sort_keys=True))
        for a in result["atoms"])
    return {"threads": [list(t) for t in threads], "atoms": [list(a) for a in atoms],
            "rejections": len(result["rejections"])}


def _module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_fixtures(old_packages):
    """[{source, snapshot, old}] for each made-up export, from the old decoders in `old_packages` (a folder)."""
    old_packages = pathlib.Path(old_packages)
    cases = [
        ("x-bookmarks", "x-bookmarks-decoder", "decode_x_bookmarks.py", BOOKMARKS),
        ("pinterest-saved", "pinterest-pins-decoder", "decode-pinterest-pins.py",
         _module("t_pinterest", HERE / "test_source_pinterest_saved.py").PINS_AND_BOARDS),
    ]
    fixtures = []
    mapper = str(old_packages / "transcript-mapper/do-work/process-scripts")
    sys.path.insert(0, mapper)
    try:
        for source_id, package, script, snapshot in cases:
            sys.modules.pop("transcript_mapper", None)
            scripts = old_packages / package / "do-work/process-scripts"
            sys.path.insert(0, str(scripts))
            try:
                old = _module("old_" + source_id.replace("-", "_"), scripts / script)
            finally:
                sys.path.remove(str(scripts))
            with tempfile.TemporaryDirectory() as folder:
                path = pathlib.Path(folder) / "input.json"
                path.write_text(json.dumps(snapshot), encoding="utf-8")
                answer = old.decode({**OBSERVATION, "native_ref": str(path)}, {})
            fixtures.append({"source": source_id, "snapshot": snapshot, "old": projection(answer)})
    finally:
        sys.path.remove(mapper)
        sys.modules.pop("transcript_mapper", None)
    return fixtures

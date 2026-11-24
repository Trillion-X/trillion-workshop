"""Exclusive extraction directory and content-bound resumes. No model or server operations."""
from contextlib import contextmanager
import json
import os
import stat
import tempfile
from pathlib import Path

from model_replies import strict_json


def report_path(destination):
    """Use the resolved parent we validate, preserving atomic replacement of the named leaf."""
    destination = Path(destination)
    return destination.parent.resolve() / destination.name


def refuse_alias(destination, protected, directories=()):
    if not destination:
        return
    destination = report_path(destination)
    for parent in (destination.parent, *destination.parent.parents):
        if parent.is_dir():
            name_limit = os.pathconf(parent, 'PC_NAME_MAX')
            if name_limit > 0 and len(os.fsencode(destination.name)) > name_limit:
                raise ValueError("Coverage destination name exceeds the filesystem component limit.")
            break
    if destination.is_dir():
        raise ValueError("Coverage destination must be a report file, not a directory.")
    directories = tuple(directories)
    directory_paths = [Path(path).resolve() for path in directories]
    directory_names = {str(path).casefold() for path in directory_paths}
    if (str(destination.parent).casefold() in directory_names
            and destination.name.casefold().endswith(('.jsonl', '.nxn.json'))):
        raise ValueError("Coverage destination uses a retained-data suffix in the extraction directory; use a report name such as coverage.json.")
    if not destination.parent.is_dir() and not any(destination.resolve().parent == path or destination.resolve().parent in path.parents
                                                    for path in directory_paths):
        raise ValueError("Coverage destination parent directory must exist or be created by extraction output setup.")
    protected = list(protected)
    for folder in directories:
        if not Path(folder).is_dir():
            continue
        with os.scandir(folder) as entries:
            for entry in entries:
                if entry.name.casefold().endswith('.jsonl'):
                    protected.extend((entry.path, os.path.splitext(entry.path)[0] + '.nxn.json'))
                elif entry.name.casefold().endswith('.nxn.json'):
                    protected.append(entry.path)
    for original in protected:
        if original is None:
            continue
        original = Path(original)
        destination_path, original_path = destination.resolve(), original.resolve()
        same = destination_path == original_path or destination_path in original_path.parents
        if str(original_path).casefold() not in directory_names:
            same = same or str(original_path).casefold() in {str(path).casefold() for path in destination_path.parents}
        if not same and destination.exists() and original.exists():
            same = os.path.samefile(destination, original)
        if not same and (not destination.exists() or not original.exists()):
            same = str(destination_path).casefold() in {str(path).casefold() for path in (original_path, *original_path.parents)}
        if same:
            raise ValueError("Coverage destination aliases or case-collides with protected input or extraction state.")


def write_report(destination, value, protected=(), directories=()):
    destination = report_path(destination)
    descriptor, temporary = tempfile.mkstemp(dir=destination.parent, prefix=".coverage.", suffix=".part")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=1, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        refuse_alias(destination, protected, directories)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def identity(value):
    try:
        from blake3 import blake3
    except ImportError as error:
        raise ValueError("Extraction phase identity requires the blake3 Python dependency.") from error
    digest = blake3()
    encoder = json.JSONEncoder(sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    for part in encoder.iterencode(value):
        digest.update(part.encode("utf-8"))
    return "blake3:" + digest.hexdigest()


def validate_targets(targets, inputs):
    """State is private regular files: no symlinks, shared inodes or aliases to loaded inputs."""
    input_paths = [Path(path) for path in inputs if path is not None]
    seen = set()
    for path in targets:
        path = Path(path)
        if any(path.resolve() == original.resolve() for original in input_paths):
            raise ValueError("Extraction state target aliases a loaded input.")
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue
        identity = (info.st_dev, info.st_ino)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or identity in seen:
            raise ValueError("Extraction state target must be a private regular file, without symlinks or shared inodes.")
        if any(original.exists() and os.path.samefile(path, original) for original in input_paths):
            raise ValueError("Extraction state target aliases a loaded input.")
        seen.add(identity)


@contextmanager
def run(folder, profile, asks, corpus, selection, legacy_unbound_http=False, append_targets=(), inputs=()):
    import fcntl
    target = Path(folder)
    target.mkdir(parents=True, exist_ok=True)
    # Directory locking leaves no new file on a refused resume and releases on process exit.
    descriptor = os.open(target, os.O_RDONLY)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("Another extractor owns this output directory; preserve that worker.") from error
        validate_targets([target / "extraction-phase.json", *append_targets], inputs)
        asks_binding = {"asks": asks, "drop_when_order": list((asks.get("drop_when") or {}).keys())}
        semantics = {"guest_rendering": "sorted-nested-keys-python-text-v1", "content_identity": "typed-json-decimal-number-value-v1"}
        binding = {"profile": identity(profile), "asks": identity(asks_binding),
                   "corpus": identity(corpus), "selection": identity(selection), "semantics": identity(semantics)}
        expected = {"version": 2, "phase_id": identity(binding), "binding": binding}
        manifest = target / "extraction-phase.json"
        if manifest.exists():
            if strict_json(manifest.read_bytes()) != expected:
                raise ValueError("Extraction phase differs; use a separate output directory.")
            yield expected["phase_id"]
        elif any(path.stat().st_size for path in target.iterdir() if path.name.casefold().endswith((".jsonl", ".nxn.json"))):
            if profile.get("transport", "http") != "http" or not legacy_unbound_http:
                raise ValueError("Unbound extraction data cannot be adopted silently; use a separate output directory.")
            # Explicit legacy HTTP continuation never fabricates a binding for old rows.
            yield None
        else:
            with manifest.open("x", encoding="utf-8") as handle:
                handle.write(json.dumps(expected, sort_keys=True, indent=2) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            yield expected["phase_id"]
    finally:
        os.close(descriptor)

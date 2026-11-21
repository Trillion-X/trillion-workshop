"""The person's Files, from a script on their computer: fetch a file by identity, keep a local file under a name.

Both go through tool:your-files (the run's own Files right), never around it:
- fetch: share_file for a few minutes, read it whole with curl, stop_share at once (any size, ranged).
- keep: write_file_start, one raw piece (the engine command's --upload, at most 32 MiB), write_file_finish; the answer's
  identity is compared with the local file's BLAKE3 before it is trusted.
`call` is the caller's command that runs one engine operation up to its method, given in the job (for example the
engine's command line with the computer that holds the Files right); this file names no command of its own.
"""
import json, os, secrets, subprocess, time

MAX_PIECE = 33554432


def _op(call, name, arguments, upload=None, timeout=900):
    cmd = list(call) + ["tools:run", json.dumps({"tool": "tool:your-files", "call": {"name": name, "arguments": arguments}})]
    if upload:
        cmd += ["--upload", upload]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    try:
        return json.loads(out)["result"]["structuredContent"]
    except Exception:
        return {"code": "no_answer", "detail": out[:300]}


def blake3_identity(path):
    return "1f:" + subprocess.run(["b3sum", "--no-names", path], capture_output=True, text=True).stdout.strip()


def fetch(call, identity, dest, seconds=1800):
    if os.path.exists(dest) and blake3_identity(dest) == identity:
        return dest
    share = _op(call, "share_file", {"name_or_identity": identity, "seconds": seconds})
    if "url" not in share:
        raise RuntimeError(f"share refused: {json.dumps(share)[:200]}")
    try:
        subprocess.run(["curl", "-sS", "--fail", "-o", dest, share["url"]], check=True, timeout=seconds)
    finally:
        _op(call, "stop_share", {"id": share["share"]})
    if blake3_identity(dest) != identity:
        raise RuntimeError(f"fetched bytes of {identity} do not match")
    return dest


def keep(call, path, name, media_type, tries=4):
    size = os.path.getsize(path)
    if size > MAX_PIECE:
        raise RuntimeError(f"{path} is {size} bytes; one piece holds at most {MAX_PIECE}")
    want = blake3_identity(path)
    for t in range(tries):
        if t:
            time.sleep(15 * t)
        u = secrets.token_hex(16)
        s = _op(call, "write_file_start", {"app": "tool:track-and-compare-movement", "byte_length": size,
                                     "media_type": media_type, "name": name, "upload_id": u})
        if s.get("state") != "open":
            continue
        p = _op(call, "write_file_piece", {"name": name, "upload_id": u, "offset": 0}, upload=path)
        if p.get("next_offset") != size:
            continue
        f = _op(call, "write_file_finish", {"name": name, "upload_id": u})
        if f.get("identity") == want:
            return want
    return None

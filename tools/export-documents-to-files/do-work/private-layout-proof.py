#!/usr/bin/env python3
"""Render an explicitly admitted private layout proof, never a final document.

The source policy retains final-delivery qualification. This control-plane
adapter adds only its independent layout-inspection purpose and delegates byte
rendering to the existing structured-file-output owner.
"""
import argparse
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[3]
PACKAGES = REPO.parent / "bitfield-packages" / "packages"
RENDERER = PACKAGES / "structured-file-output/do-work/process-scripts/render-structured-file-export.py"
HASH_HELPER = PACKAGES / "meaning-search/do-work/process-scripts"


def snapshot_owner():
    spec = importlib.util.spec_from_file_location(
        "private_layout_snapshot_owner", REPO / ".claude/hooks/copy-judge-every-write.py")
    owner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(owner)
    return owner


def relative(path, root):
    value = Path(path)
    if not value.is_absolute() or any(part in {".", ".."} for part in str(path).split("/")):
        raise ValueError("An exact absolute path inside the source owner is required")
    return value.relative_to(root).as_posix()


def private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Layout proof directories must be private and user owned")


def write_private(path, data):
    with open(path, "x", encoding="utf-8", opener=lambda p, flags: os.open(p, flags, 0o600)) as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())


def output_owner(book, relative_path):
    if (not isinstance(relative_path, str) or Path(relative_path).is_absolute()
            or any(part in {"", ".", ".."} for part in relative_path.split("/"))
            or "deliverables" in Path(relative_path).parts):
        raise ValueError("Private proof output must remain outside deliverables inside the policy owner")
    private_directory(book)
    current = book
    for part in relative_path.split("/"):
        current = current / part
        try:
            current.mkdir(mode=0o700)
        except FileExistsError:
            pass
        private_directory(current)
    return current


def proof_rule(policy, document_key, purpose):
    if policy.get("schema") != "book-writing-policy-v1" or policy.get("unknown_documents") != "deny":
        raise ValueError("A default-deny document policy is required")
    if purpose != "private_layout_proof":
        raise ValueError("This route cannot admit final delivery or another export purpose")
    rule = policy.get("export_purposes", {}).get(purpose)
    if (not isinstance(rule, dict) or rule.get("delivery_eligible") is not False
            or rule.get("requires_voice_qualification") is not False):
        raise ValueError("Private layout inspection must be explicitly admitted by policy")
    entry = policy.get("documents", {}).get(document_key)
    selected = rule.get("documents", {}).get(document_key)
    if not isinstance(entry, dict) or entry.get("role") != "current_prose" or not isinstance(selected, dict):
        raise ValueError("The current document is not admitted for private layout inspection")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", selected.get("file_stem", "")):
        raise ValueError("A plain policy-owned file stem is required")
    return rule, entry, selected


def inspect_inputs(policy, key, purpose, job, projection, source_identity, gate, identities):
    rule, entry, selected = proof_rule(policy, key, purpose)
    expected = "blake3:" + entry.get("source_blake3", "")
    current = "1f:" + source_identity.removeprefix("blake3:")
    if source_identity != expected or job.get("source", {}).get("candidate_content_identity") != current:
        raise ValueError("Current source identity does not match the policy and job")
    if (projection.get("schema") != "documents-structured-file-projection-v1"
            or projection.get("source_identity") != current or projection.get("tree") != job.get("tree")):
        raise ValueError("The job does not use the exact admitted Documents projection")
    if job.get("descriptor", {}).get("format_id") not in {"pdf", "docx"}:
        raise ValueError("Only private PDF and Word layout proofs are admitted")
    for name in ("projection", "mechanical_gate", "rules"):
        if identities[name] != "blake3:" + selected.get(name + "_blake3", ""):
            raise ValueError("An admitted layout input identity changed")
    if gate.get("passed") is not True or gate.get("gate_id") != selected.get("mechanical_gate_id"):
        raise ValueError("The pinned scoped mechanical gate did not pass")
    if (not isinstance(rule.get("title"), str) or not rule["title"].strip()
            or not rule.get("output_root")):
        raise ValueError("The policy must name the private proof and its output owner")
    return rule, selected


def export_proof(policy_path, job_path, rules_path, purpose):
    owner = snapshot_owner()
    policy_path, job_path, rules_path = map(Path, (policy_path, job_path, rules_path))
    policy_relative = relative(policy_path, REPO)
    book = policy_path.parent
    with ExitStack() as stack:
        held_policy = stack.enter_context(owner.held_source_snapshot(
            str(REPO), policy_relative, private_owner_only=True))
        policy = json.loads(held_policy.content)
        held_job = stack.enter_context(owner.held_source_snapshot(
            str(REPO), relative(job_path, REPO), private_owner_only=True))
        job = json.loads(held_job.content)
        source_path = Path(job.get("source", {}).get("candidate_path", ""))
        key = relative(source_path, book)
        rule, entry, selected = proof_rule(policy, key, purpose)
        projection_path = Path(selected["projection"])
        gate_path = book / entry["native_gate_result"]
        if str(rules_path) != selected.get("rules"):
            raise ValueError("The rules path is not admitted by policy")
        paths = {"source": source_path, "projection": projection_path,
                 "mechanical_gate": gate_path, "rules": rules_path}
        held = stack.enter_context(owner.held_source_snapshots(
            str(REPO), [relative(path, REPO) for path in paths.values()], private_owner_only=True))
        captures = {name: held[relative(path, REPO)] for name, path in paths.items()}
        rule, selected = inspect_inputs(policy, key, purpose, job,
            json.loads(captures["projection"].content), captures["source"].identity,
            json.loads(captures["mechanical_gate"].content),
            {name: item.identity for name, item in captures.items()})
        output_root = output_owner(book, rule["output_root"])
        output = Path(tempfile.mkdtemp(prefix="proof-", dir=output_root))
        private_directory(output)
        job["title"] = rule["title"]
        job["descriptor"].update(destination_dir=str(output), file_stem=selected["file_stem"])
        job["source"].update(export_purpose=purpose, delivery_eligible=False,
                            voice_qualification="not_established")
        prepared = output / "job.json"
        prepared_rules = output / "rules.json"
        write_private(prepared, job)
        write_private(prepared_rules, json.loads(captures["rules"].content))
        for item in [held_policy, held_job, *captures.values()]:
            item.validate()
        env = os.environ.copy()
        env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(HASH_HELPER), env.get("PYTHONPATH")]))
        execution = subprocess.run([sys.executable, str(RENDERER), "--job-file", str(prepared),
            "--rules-rows-file", str(prepared_rules), "--result-path", str(output / "renderer-result.json")],
            check=False, capture_output=True, timeout=180, env=env, cwd=RENDERER.parents[4])
        write_private(output / "renderer-log.json", {"exit_code": execution.returncode,
            "stdout": execution.stdout.decode("utf-8", errors="replace"),
            "stderr": execution.stderr.decode("utf-8", errors="replace")})
        execution.check_returncode()
        result = json.loads((output / "renderer-result.json").read_text(encoding="utf-8"))
        target = output / (selected["file_stem"] + "." + job["descriptor"]["format_id"])
        if result.get("path") != str(target):
            raise ValueError("The renderer returned an unexpected destination")
        with owner.held_source_snapshot(str(REPO), relative(target, REPO),
                private_owner_only=True) as artifact:
            if (result.get("byte_length") != len(artifact.content)
                    or result.get("payload_hash") != "1f:" + artifact.identity.removeprefix("blake3:")):
                raise ValueError("The rendered artifact identity does not match its saved bytes")
        for item in [held_policy, held_job, *captures.values()]:
            item.validate()
        receipt = {"schema": "private-layout-proof-result-v1", "purpose": purpose,
            "delivery_eligible": False, "voice_qualification": "not_established",
            "source_identity": captures["source"].identity, "policy_identity": held_policy.identity,
            "projection_identity": captures["projection"].identity, "artifact": result,
            "scope": "Private layout inspection only. No author voice approval, final delivery or page review claimed."}
        write_private(output / "proof-result.json", receipt)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--job-file", required=True)
    parser.add_argument("--rules-file", required=True)
    parser.add_argument("--purpose", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    result = export_proof(args.policy, args.job_file, args.rules_file, args.purpose)
    print(json.dumps(result))


if __name__ == "__main__":
    main()

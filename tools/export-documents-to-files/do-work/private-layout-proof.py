#!/usr/bin/env python3
"""Render an explicitly admitted private layout proof, never a final document.

The source policy retains final-delivery qualification. This retained-purpose
core adds only its independent layout-inspection purpose and delegates byte
rendering to the existing structured-file-output owner.
"""
import argparse
from contextlib import ExitStack, contextmanager
import json
import os
from pathlib import Path
import re
import runpy
import stat
import subprocess
import sys
import tempfile

RENDERER = Path(__file__).with_name("render-structured-file-export.py")


def snapshot_owner():
    """Adapt the original snapshot interface to the maintained private reader."""
    from writing_gate import _PrivateInput
    from types import SimpleNamespace
    import resource
    class Owner:
        def __init__(self):
            soft, _ = resource.getrlimit(resource.RLIMIT_NOFILE)
            self.descriptor_budget = 512 if soft == resource.RLIM_INFINITY else min(512, max(0, int(soft) - 64))
            self.descriptors = 0
            self.peak_descriptors = 0

        @contextmanager
        def held_source_snapshot(self, owner_root, relative_path, *, private_owner_only=True):
            if private_owner_only is not True:
                raise ValueError("Private layout snapshots must stay private")
            path = Path(owner_root) / relative_path
            if self.descriptors + len(path.parts) > self.descriptor_budget:
                raise ValueError("Private layout snapshot descriptor budget exceeded")
            with _PrivateInput(path, Path(owner_root), max_bytes=8 * 1024 * 1024) as held:
                count = len(held.opened) + 1
                self.descriptors += count
                self.peak_descriptors = max(self.peak_descriptors, self.descriptors)
                try:
                    yield SimpleNamespace(content=held.content, identity="blake3:" + held.identity,
                                          validate=held.validate)
                finally:
                    self.descriptors -= count

        @contextmanager
        def held_source_snapshots(self, owner_root, relative_paths, *, private_owner_only=True):
            with ExitStack() as stack:
                yield {path: stack.enter_context(self.held_source_snapshot(
                    owner_root, path, private_owner_only=private_owner_only)) for path in relative_paths}
    return Owner()


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
            or any(part.casefold() == "deliverables" for part in Path(relative_path).parts)):
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
    if not isinstance(selected.get("mechanical_gate_id"), str) or not selected["mechanical_gate_id"].strip():
        raise ValueError("An explicit scoped mechanical gate identity is required")
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


@contextmanager
def private_layout_admission(source, settings, job_path):
    """Keep explicit settings admission around the original purpose validators."""
    from writing_gate import _exact_absolute
    if not isinstance(settings, dict) or settings.get("role") != "current_prose":
        raise ValueError("Private layout inspection keeps the current_prose role")
    purposes = settings.get("export_purposes")
    admission = purposes.get("private_layout_proof") if isinstance(purposes, dict) else None
    if not isinstance(admission, dict):
        raise ValueError("The settings row does not admit private_layout_proof")
    REPO = _exact_absolute(admission.get("input_root"), "input_root")
    policy_path = _exact_absolute(admission.get("policy"), "policy")
    source = _exact_absolute(str(source), "source")
    job_path = _exact_absolute(str(job_path), "job_file")
    purpose = "private_layout_proof"
    owner = snapshot_owner()
    policy_relative = relative(policy_path, REPO)
    book = policy_path.parent
    with ExitStack() as stack:
        held_policy = stack.enter_context(owner.held_source_snapshot(
            str(REPO), policy_relative, private_owner_only=True))
        policy = json.loads(held_policy.content)
        if held_policy.identity != "blake3:" + str(admission.get("policy_blake3", "")):
            raise ValueError("Private layout policy changed after settings admission")
        if (not isinstance(policy, dict) or not isinstance(policy.get("documents"), dict)
                or not isinstance(policy.get("export_purposes"), dict)):
            raise ValueError("Invalid private layout default-deny policy")
        purpose_rule = policy["export_purposes"].get(purpose)
        if not isinstance(purpose_rule, dict) or not isinstance(purpose_rule.get("documents"), dict):
            raise ValueError("Private layout purpose has no exact document admission")
        held_job = stack.enter_context(owner.held_source_snapshot(
            str(REPO), relative(job_path, REPO), private_owner_only=True))
        job = json.loads(held_job.content)
        if (not isinstance(job, dict) or not isinstance(job.get("source"), dict)
                or not isinstance(job.get("descriptor"), dict)):
            raise ValueError("Invalid source-bound private layout job")
        source_path = Path(job.get("source", {}).get("candidate_path", ""))
        if str(source_path) != str(source):
            raise ValueError("The private layout job does not bind the exact current source")
        key = relative(source_path, book)
        rule, entry, selected = proof_rule(policy, key, purpose)
        projection_path = Path(selected["projection"])
        gate_path = book / entry["native_gate_result"]
        rules_path = Path(selected["rules"])
        paths = {"source": source_path, "projection": projection_path,
                 "mechanical_gate": gate_path, "rules": rules_path}
        held = stack.enter_context(owner.held_source_snapshots(
            str(REPO), [relative(path, REPO) for path in paths.values()], private_owner_only=True))
        captures = {name: held[relative(path, REPO)] for name, path in paths.items()}
        projection = json.loads(captures["projection"].content)
        gate = json.loads(captures["mechanical_gate"].content)
        if not isinstance(projection, dict) or not isinstance(gate, dict):
            raise ValueError("Invalid pinned private layout projection or mechanical gate")
        rule, selected = inspect_inputs(policy, key, purpose, job,
            projection, captures["source"].identity, gate,
            {name: item.identity for name, item in captures.items()})
        if captures["source"].identity != "blake3:" + str(settings.get("source_blake3", "")):
            raise ValueError("Private layout source changed after exact document admission")
        if "private layout proof" not in rule["title"].casefold() or "unfinished" not in rule["title"].casefold():
            raise ValueError("Private layout proof needs a visible private, unfinished title")
        rules = json.loads(captures["rules"].content)
        pick_rules = runpy.run_path(str(RENDERER))["pick_rules"]
        selected_rules = pick_rules(rules, job.get("rules_id", job["descriptor"].get("rules_id", "default")))
        format_id = job["descriptor"]["format_id"]
        fmt = (selected_rules.get("formats") or {}).get(format_id) if selected_rules else None
        if not isinstance(fmt, dict) or fmt.get("extension") != format_id or fmt.get("renderer") != format_id:
            raise ValueError("Private proof rules must select the native Word or PDF renderer and extension")
        def validate():
            for item in [held_policy, held_job, *captures.values()]:
                item.validate()
        validate()
        yield {"owner": owner, "input_root": REPO, "policy_owner": book, "rule": rule,
               "title": rule["title"], "output_root": book / rule["output_root"],
               "selected": selected, "job": job, "rules": rules, "validate": validate,
               "held_policy": held_policy, "held_job": held_job, "captures": captures}
        validate()


def export_proof(source, settings, job_path):
    with private_layout_admission(source, settings, job_path) as admission, ExitStack() as stack:
        owner, REPO, book = admission["owner"], admission["input_root"], admission["policy_owner"]
        rule, selected, job = admission["rule"], admission["selected"], admission["job"]
        held_policy, held_job, captures = admission["held_policy"], admission["held_job"], admission["captures"]
        purpose = "private_layout_proof"
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
        prepared_inputs = [stack.enter_context(owner.held_source_snapshot(str(REPO), relative(path, REPO),
                           private_owner_only=True)) for path in (prepared, prepared_rules)]
        for item in [held_policy, held_job, *captures.values()]:
            item.validate()
        old_umask = os.umask(0o077)
        try:
            with open(output / "renderer-stdout.log", "xb") as stdout, open(output / "renderer-stderr.log", "xb") as stderr:
                execution = subprocess.run([sys.executable, str(RENDERER), "--job-file", str(prepared),
                    "--rules-rows-file", str(prepared_rules), "--result-path", str(output / "renderer-result.json"),
                    "--content-identity"], check=False, stdout=stdout, stderr=stderr, timeout=180)
        finally:
            os.umask(old_umask)
        for item in [held_policy, held_job, *captures.values(), *prepared_inputs]:
            item.validate()
        write_private(output / "renderer-log.json", {"exit_code": execution.returncode,
            "stdout": str(output / "renderer-stdout.log"), "stderr": str(output / "renderer-stderr.log")})
        if execution.returncode != 0:
            raise ValueError(f"The private layout renderer failed; retained diagnostic files are in {output}")
        for item in prepared_inputs:
            item.validate()
        result_snapshot = stack.enter_context(owner.held_source_snapshot(str(REPO),
            relative(output / "renderer-result.json", REPO), private_owner_only=True))
        result = json.loads(result_snapshot.content)
        if (result.get("literal_layout") and result.get("literal_layout_source_identity")
                != job["source"]["candidate_content_identity"]):
            raise ValueError("The literal layout map is not bound to the current private proof source")
        target = output / (selected["file_stem"] + "." + job["descriptor"]["format_id"])
        if result.get("path") != str(target) or result.get("format_id") != job["descriptor"]["format_id"]:
            raise ValueError("The renderer returned an unexpected destination")
        artifact = stack.enter_context(owner.held_source_snapshot(str(REPO), relative(target, REPO),
                private_owner_only=True))
        if (result.get("byte_length") != len(artifact.content)
                or result.get("payload_hash") != "1f:" + artifact.identity.removeprefix("blake3:")):
            raise ValueError("The rendered artifact identity does not match its saved bytes")
        if job["descriptor"]["format_id"] == "docx":
            from docx import Document
            visible = " ".join(p.text for p in Document(str(target)).paragraphs)
        else:
            from pypdf import PdfReader
            reader = PdfReader(str(target))
            visible = reader.pages[0].extract_text() if reader.pages else ""
        collapse = lambda value: re.sub(r"\s+", " ", value or "").strip()
        if collapse(rule["title"]) not in collapse(visible):
            raise ValueError("The private unfinished proof label did not survive artifact readback")
        result["content_identity"] = "1f:" + artifact.identity.removeprefix("blake3:")
        for item in [held_policy, held_job, *captures.values(), *prepared_inputs, result_snapshot, artifact]:
            item.validate()
        receipt = {"schema": "private-layout-proof-result-v1", "purpose": purpose,
            "delivery_eligible": False, "voice_qualification": "not_established",
            "source_identity": captures["source"].identity, "policy_identity": held_policy.identity,
            "projection_identity": captures["projection"].identity, "artifact": result,
            "mechanical_gate_identity": captures["mechanical_gate"].identity,
            "rules_identity": captures["rules"].identity, "unfinished_label_readback": True,
            "snapshot_descriptor_peak": owner.peak_descriptors,
            "snapshot_descriptor_budget": owner.descriptor_budget,
            "scope": "Private layout inspection only. No author voice approval, final delivery or page review claimed."}
        write_private(output / "proof-result.json", receipt)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--settings", required=True)
    parser.add_argument("--job-file", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    result = export_proof(Path(args.source), json.loads(Path(args.settings).read_text()), Path(args.job_file))
    print(json.dumps(result))


if __name__ == "__main__":
    main()

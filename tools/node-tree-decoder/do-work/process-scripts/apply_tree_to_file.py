#!/usr/bin/env python3
# packages/node-tree-decoder/do-work/process-scripts/apply_tree_to_file.py
#
# PURPOSE
# Install a rebuilt tree over the file it came from, without ever leaving that
# file in a state its owning application cannot read.
#
# NON-NEGOTIABLE INVARIANTS
#   P1. THE CANDIDATE IS PROVEN READABLE FIRST. It must decode, with zero
#       rejections, before it is allowed anywhere near the target. Installing a
#       tree nobody has decoded is how an application opens to an empty window.
#   P2. THE PREVIOUS BYTES SURVIVE. A timestamped copy of the exact current
#       target is written BEFORE the replace, and the replace is refused if that
#       copy cannot be written. No backup, no write.
#   P3. THE REPLACE IS ATOMIC. Write a temp file in the SAME directory, then
#       os.replace. A partial write is never observable, so the owning
#       application can never read half a tree, even if this process dies.
#   P4. MEMBERSHIP IS COMPARED ACROSS THE SWAP. Leaf counts before and after
#       must match, or the run reports failure loudly with the backup path.
#   P5. THE RACE IS NAMED, AND THE CHECK OUTLASTS IT. A running owner
#       application holds this tree in memory and rewrites the file from its own
#       state on its own schedule, silently reverting this. That cannot be
#       prevented from here, so it is DETECTED.
#
#       An IMMEDIATE readback is not enough, and this was proven the expensive
#       way on 2026-09-04: the swap verified clean, and the owning application
#       overwrote it about twelve seconds later. The first version of this file
#       reported success for a change that no longer existed. A verification that
#       passes and then becomes false is not a verification, it is a delay.
#
#       So the readback SETTLES: it re-reads over a window and requires the
#       change to still be there at the end. Success means "still true after the
#       owner had a chance to fight back," which is the only claim worth making.
#
# SECURITY
# Touches exactly two paths: the caller-named target and the caller-named backup
# directory. No network, no process control, no shell.
#
#   usage: apply_tree_to_file.py <descriptor.json> <candidate.json> <target> <backup_dir>

import datetime
import json
import os
import shutil
import sys
import tempfile
import time

_HERE = __file__.rsplit("/", 1)[0]
sys.path.insert(0, _HERE)

from decode_node_tree import decode_tree  # noqa: E402

ROLE_LEAF = "leaf"


def census(records):
    counts = {}
    for record in records:
        counts[record["role"]] = counts.get(record["role"], 0) + 1
    return counts


def main(argv):
    if len(argv) < 5:
        sys.stderr.write(
            "usage: apply_tree_to_file.py <descriptor.json> <candidate.json> "
            "<target> <backup_dir>\n"
        )
        return 2

    descriptor_path, candidate_path, target, backup_dir = argv[1:5]

    with open(descriptor_path, encoding="utf-8") as handle:
        descriptor = json.load(handle)

    # P1. The candidate must be readable BEFORE it is allowed near the target.
    with open(candidate_path, encoding="utf-8") as handle:
        candidate = json.load(handle)
    candidate_result = decode_tree(candidate, descriptor)
    if candidate_result["rejections"]:
        sys.stderr.write("REFUSED: the candidate does not decode\n")
        sys.stderr.write(json.dumps(candidate_result["rejections"][:3], indent=2) + "\n")
        return 1
    candidate_census = census(candidate_result["records"])
    print("candidate decodes      : %d records %s"
          % (len(candidate_result["records"]), candidate_census))

    with open(target, encoding="utf-8") as handle:
        before = json.load(handle)
    before_result = decode_tree(before, descriptor)
    before_census = census(before_result["records"])
    print("current target decodes : %d records %s"
          % (len(before_result["records"]), before_census))

    # P4, checked before the swap so a bad candidate never gets installed.
    if candidate_census.get(ROLE_LEAF, 0) != before_census.get(ROLE_LEAF, 0):
        sys.stderr.write(
            "REFUSED: leaf count would change, %d -> %d\n"
            % (before_census.get(ROLE_LEAF, 0), candidate_census.get(ROLE_LEAF, 0))
        )
        return 1

    # P2. Previous bytes survive, or nothing happens.
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = os.path.join(
        backup_dir, "%s.before-%s.json" % (os.path.basename(target), stamp)
    )
    shutil.copyfile(target, backup_path)
    if not os.path.exists(backup_path) or os.path.getsize(backup_path) == 0:
        sys.stderr.write("REFUSED: the pre-change copy did not land\n")
        return 1
    print("pre-change copy        : %s (%d bytes)"
          % (backup_path, os.path.getsize(backup_path)))

    # P3. Atomic replace through the SAME directory, so it is one rename.
    target_dir = os.path.dirname(os.path.abspath(target))
    handle_fd, staged = tempfile.mkstemp(dir=target_dir, suffix=".staged")
    try:
        with os.fdopen(handle_fd, "w", encoding="utf-8") as staged_handle:
            json.dump(candidate, staged_handle, ensure_ascii=False)
        shutil.copymode(target, staged)
        os.replace(staged, target)
    except BaseException:
        if os.path.exists(staged):
            os.unlink(staged)
        raise
    print("replaced atomically    : %s" % target)

    # P5. Settle, then read back. An immediate check is not a check.
    wanted = {r["node_id"]: r["parent_id"] for r in candidate_result["records"]}
    settle_seconds = int(os.environ.get("SETTLE_SECONDS", "20"))
    disagreeing = []
    for elapsed in range(0, settle_seconds + 1, 5):
        if elapsed:
            time.sleep(5)
        with open(target, encoding="utf-8") as handle:
            after = json.load(handle)
        after_result = decode_tree(after, descriptor)
        landed = {r["node_id"]: r["parent_id"] for r in after_result["records"]}
        disagreeing = [k for k, v in wanted.items() if landed.get(k, "<absent>") != v]
        print("readback at +%-3ds     : %d records, %d edges disagree"
              % (elapsed, len(after_result["records"]), len(disagreeing)))
        if disagreeing:
            break

    print("")
    if not disagreeing:
        print("VERDICT: applied, and still true %ds later" % settle_seconds)
        print("  recover with: %s" % backup_path)
        return 0

    print("VERDICT: REVERTED or partially applied, %d edges disagree" % len(disagreeing))
    print("  The owning application is almost certainly running and rewrote the")
    print("  file from its own memory. Quit it, then run this again.")
    print("  previous bytes: %s" % backup_path)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

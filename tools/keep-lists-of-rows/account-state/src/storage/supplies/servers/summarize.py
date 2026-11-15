#!/usr/bin/env python3
"""Turn the logs written by run-servers.sh into the tables of the results note.

usage: summarize.py <results dir>
Prints three markdown tables: conformance (one row per case, one column per server), the differential outcome per
server, and the measured network round trips per operation.
"""
import json
import pathlib
import re
import sys

CASES = [
    "versions_compare_and_set_and_deletes_hide_records",
    "retries_return_the_first_change_and_refuse_changed_input",
    "crash_before_commit_leaves_nothing_and_crash_after_commit_answers_the_retry",
    "list_pages_walk_live_records_in_id_order_with_explicit_continuation",
    "the_change_feed_brings_a_follower_to_the_current_state",
    "as_of_reads_one_row_whatever_the_history_size",
    "rows_written_per_change_are_one_plus_orders_on_create_and_two_plus_orders_on_update",
    "erase_is_unreachable_at_once_restorable_in_the_window_and_gone_after_it",
    "replaced_versions_and_tombstones_leave_when_the_undo_window_ends",
    "search_segments_are_exact_cheap_to_write_bounded_to_restart_and_erased_with_the_record",
    "the_byte_budget_refuses_a_change_that_would_exceed_it",
    "each_host_keeps_its_own_limits",
    "ordered_pages_follow_the_declared_field_at_one_scan_plus_one_get_per_record",
]
TRIPS = ["create", "update", "current_read", "as_of_read", "list_page_100", "ordered_page_100"]


def read(path):
    return path.read_text(errors="replace") if path.exists() else ""


def main(folder):
    root = pathlib.Path(folder)
    labels = sorted({p.name.split(".")[0] for p in root.glob("*.log")})
    results = {}
    for label in labels:
        text = read(root / f"{label}.conformance.log")
        results[label] = dict(re.findall(r"^test (\w+) \.\.\. (ok|FAILED)", text, re.M))
    print("| case | " + " | ".join(labels) + " |")
    print("| --- | " + " | ".join("---" for _ in labels) + " |")
    for case in CASES:
        marks = [{"ok": "pass", "FAILED": "FAIL"}.get(results[label].get(case, ""), "-") for label in labels]
        print(f"| {case} | " + " | ".join(marks) + " |")
    print()
    print("| server | differential (random operations against the SQLite supply) |")
    print("| --- | --- |")
    for label in labels:
        text = read(root / f"{label}.differential.log")
        campaigns = re.findall(r"^differential (\w+): (\d+) seeds x (\d+) steps, (\d+) with a difference", text, re.M)
        summary = "; ".join(f"{name}: {seeds} seeds x {steps} steps, {bad} differ" for name, seeds, steps, bad in campaigns)
        if not summary:
            summary = "did not run" if not text else "did not finish"
        print(f"| {label} | {summary} |")
    print()
    print("| server | " + " | ".join(TRIPS) + " |")
    print("| --- | " + " | ".join("---" for _ in TRIPS) + " |")
    for label in labels:
        trips = re.search(r"^ROUNDTRIPS (\{.*\})$", read(root / f"{label}.roundtrips.log"), re.M)
        if trips:
            data = json.loads(trips.group(1))
            print(f"| {label} | " + " | ".join(str(data[key]) for key in TRIPS) + " |")
        else:
            print(f"| {label} | " + " | ".join("-" for _ in TRIPS) + " |")


if __name__ == "__main__":
    main(sys.argv[1])

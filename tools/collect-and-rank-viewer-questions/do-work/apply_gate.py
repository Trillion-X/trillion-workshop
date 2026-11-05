"""Runs every asker_line through the copy gate and writes the verdict back into questions.json.

usage: apply_gate.py <questions.json> <lines.txt> <check.mjs>
Writes one asker_line per line to <lines.txt>, runs `node check.mjs lines.txt --kind narrator --no-model`
(no-model: the local decider rows are unqualified and would only log escalations), parses each
"FAIL|UNCERTAIN [narrator] file:LINE" block, and sets asker_line_gate to {verdict, rules}.
A line with no block passed. Exit code 1 when any line FAILs, so the caller sees it.
"""
import json
import re
import subprocess
import sys

questions_path, lines_path, check = sys.argv[1:4]
document = json.load(open(questions_path))
entries = document["questions"]
open(lines_path, "w").write("\n".join(e["asker_line"] for e in entries) + "\n")
result = subprocess.run(["node", check, lines_path, "--kind", "narrator", "--no-model"], capture_output=True, text=True)
blocks = re.split(r"\n(?=(?:FAIL|UNCERTAIN|WAIVED) \[)", result.stdout)
verdicts = {}
for block in blocks:
    head = re.match(r"(FAIL|UNCERTAIN|WAIVED) \[[^\]]*\] .*:(\d+)\n", block)
    if head:
        rules = re.findall(r"^\s+([\w-]+): ", block, re.M)
        verdicts[int(head.group(2))] = {"verdict": head.group(1).lower(), "rules": rules}
for number, entry in enumerate(entries, 1):
    entry["asker_line_gate"] = verdicts.get(number, {"verdict": "pass", "rules": []})
json.dump(document, open(questions_path, "w"), indent=1, ensure_ascii=False)
summary = {}
for entry in entries:
    summary[entry["asker_line_gate"]["verdict"]] = summary.get(entry["asker_line_gate"]["verdict"], 0) + 1
print(summary, file=sys.stderr)
for number, entry in enumerate(entries, 1):
    if entry["asker_line_gate"]["verdict"] == "fail":
        print(entry["id"], entry["asker_line"], entry["asker_line_gate"]["rules"])
sys.exit(1 if summary.get("fail") else 0)

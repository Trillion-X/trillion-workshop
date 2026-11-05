"""Runs every asker_line through the copy gate and writes the verdict back into questions.json.

usage: apply_gate.py <questions.json> <check-request.json> [kind]
   or: apply_gate.py <questions.json> <lines.txt> <check.mjs>   (a gate program of the older command line)
The copy gate is tool:check-copy (tools/check-against-a-persons-rules-and-verdicts/do-work/check-copy-words.mjs, in the
same clone). <check-request.json> is a check-copy request holding the person's rules (and anything else check-copy
takes); every asker_line goes in as one of its texts, of kind narrator unless [kind] names another. It parses each
"FAIL|UNCERTAIN|WAIVED [narrator] texts.N" block of check-copy's lines (a block may name several texts.N when the same
words came twice), and sets asker_line_gate to {verdict, rules}.
With a gate program of the older command line, it writes one asker_line per line to <lines.txt>, runs
`node check.mjs lines.txt --kind narrator --no-model` and parses each "FAIL|UNCERTAIN [narrator] file:LINE" block
of what it prints the same way.
A line with no block passed. Exit code 1 when any line FAILs, so the caller sees it.
The last line printed is {"result": {verdicts, failing}}, or {"error": ...} when check-copy refused the request.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CHECK = os.path.join(HERE, "..", "..", "check-against-a-persons-rules-and-verdicts", "do-work", "check-copy-words.mjs")

older = len(sys.argv) > 3 and sys.argv[3].endswith((".mjs", ".js"))
document = json.load(open(sys.argv[1]))
entries = document["questions"]
verdicts = {}
if older:
    questions_path, lines_path, check = sys.argv[1:4]
    open(lines_path, "w").write("\n".join(e["asker_line"] for e in entries) + "\n")
    result = subprocess.run(["node", check, lines_path, "--kind", "narrator", "--no-model"], capture_output=True, text=True)
    blocks = re.split(r"\n(?=(?:FAIL|UNCERTAIN|WAIVED) \[)", result.stdout)
    for block in blocks:
        head = re.match(r"(FAIL|UNCERTAIN|WAIVED) \[[^\]]*\] .*:(\d+)\n", block)
        if head:
            rules = re.findall(r"^\s+([\w-]+): ", block, re.M)
            verdicts[int(head.group(2))] = {"verdict": head.group(1).lower(), "rules": rules}
else:
    questions_path, request_path = sys.argv[1:3]
    kind = sys.argv[3] if len(sys.argv) > 3 else "narrator"
    request = dict(json.load(open(request_path)), texts=[e["asker_line"] for e in entries], kind=kind)
    result = subprocess.run(["node", CHECK], input=json.dumps(request), capture_output=True, text=True)
    said = json.loads((result.stdout.strip().splitlines() or ["{}"])[-1])
    if "result" not in said:
        print(json.dumps({"error": f"tool:check-copy refused the asker lines: {said.get('error') or result.stderr.strip()[-400:]}"}))
        sys.exit(2)
    blocks = re.split(r"\n(?=(?:FAIL|UNCERTAIN|WAIVED) \[)", "\n".join(said["result"]["lines"]) + "\n")
    for block in blocks:
        head = re.match(r"(FAIL|UNCERTAIN|WAIVED) \[[^\]]*\] (.*)\n", block)
        if head:
            rules = re.findall(r"^\s+([\w-]+): ", block, re.M)
            for number in re.findall(r"texts\.(\d+)", head.group(2)):
                verdicts[int(number) + 1] = {"verdict": head.group(1).lower(), "rules": rules}
for number, entry in enumerate(entries, 1):
    entry["asker_line_gate"] = verdicts.get(number, {"verdict": "pass", "rules": []})
json.dump(document, open(questions_path, "w"), indent=1, ensure_ascii=False)
summary = {}
for entry in entries:
    summary[entry["asker_line_gate"]["verdict"]] = summary.get(entry["asker_line_gate"]["verdict"], 0) + 1
print(summary, file=sys.stderr)
failing = []
for number, entry in enumerate(entries, 1):
    if entry["asker_line_gate"]["verdict"] == "fail":
        print(entry["id"], entry["asker_line"], entry["asker_line_gate"]["rules"])
        failing.append({"id": entry["id"], "asker_line": entry["asker_line"], "rules": entry["asker_line_gate"]["rules"]})
print(json.dumps({"result": {"verdicts": summary, "failing": failing}}))
sys.exit(1 if summary.get("fail") else 0)

"""Search the preserved 1000x architecture reference as individual patterns."""

import json
import os
import re
import sys
from pathlib import Path


REFERENCE = Path(os.environ.get("ARCHITECTURE_REFERENCE_PATH", Path(__file__).with_name("reference.md")))
HEADING = re.compile(r"^### Pattern (\d+): (.+)$", re.MULTILINE)
INDEX_ROW = re.compile(r"^\|\s*(\d+)\s*\|\s*\[.+?\]\(.+?\)\s*\|\s*(.*?)\s*\|$", re.MULTILINE)


def plain(value):
    value = re.sub(r"`([^`]*)`", r"\1", value)
    value = re.sub(r"\*\*([^*]*)\*\*", r"\1", value)
    value = re.sub(r"\[[^]]+\]\(([^)]+)\)", r"\1", value)
    return " ".join(value.split())


def paragraph(body, label):
    match = re.search(r"^\*\*" + re.escape(label) + r":\*\*\s*(.*?)(?=\n\s*\n|\n\*\*|\Z)", body, re.MULTILINE | re.DOTALL)
    return plain(match.group(1)) if match else ""


def catalog(source):
    index = {int(number): plain(summary) for number, summary in INDEX_ROW.findall(source)}
    headings = list(HEADING.finditer(source))
    patterns = []
    for i, heading in enumerate(headings):
        number = int(heading.group(1))
        end = headings[i + 1].start() if i + 1 < len(headings) else len(source)
        section_end = re.search(r"^## [^#]", source[heading.end():end], re.MULTILINE)
        if section_end:
            end = heading.end() + section_end.start()
        original = source[heading.start():end].strip()
        body = source[heading.end():end]
        problem = (paragraph(body, "What it solves") or paragraph(body, "Problem")
                   or paragraph(body, "L055 Deepest Root") or paragraph(body, "L055 chain"))
        principle = (paragraph(body, "Why this specific shape") or paragraph(body, "L055 Deepest Root")
                     or paragraph(body, "L055 chain") or paragraph(body, "Generalization")
                     or paragraph(body, "Generality"))
        summary = index.get(number) or problem.split(". ")[0].strip()
        problem = problem or summary
        principle = principle or summary
        patterns.append({
            "number": number,
            "title": heading.group(2).strip(),
            "summary": summary,
            "problem": problem,
            "principle": principle,
            "source": paragraph(body, "Source"),
            "original": original,
        })
    return patterns


def compact(pattern):
    return {key: pattern[key] for key in ("number", "title", "summary", "problem", "principle", "source")}


def search(patterns, query):
    lowered = query.strip().lower()
    if lowered in ("index", "all", "list"):
        return [compact(pattern) for pattern in patterns]
    exact = re.fullmatch(r"(?:#|pattern\s+)(\d{1,3})", lowered)
    if exact:
        return [pattern for pattern in patterns if pattern["number"] == int(exact.group(1))]
    words = re.findall(r"[a-z0-9]+", lowered)
    if not words:
        return []
    ranked = []
    for pattern in patterns:
        title = pattern["title"].lower()
        summary = pattern["summary"].lower()
        problem = pattern["problem"].lower()
        principle = pattern["principle"].lower()
        score = sum(8 * (word in title) + 4 * (word in summary) + 2 * (word in problem) + (word in principle) for word in words)
        if score:
            ranked.append((score, pattern["number"], pattern))
    ranked.sort(key=lambda item: (-item[0], item[1]))
    return [compact(item[2]) for item in ranked[:8]]


def main():
    query = sys.argv[1] if len(sys.argv) > 1 else "index"
    source = REFERENCE.read_text(encoding="utf-8")
    patterns = catalog(source)
    numbers = [pattern["number"] for pattern in patterns]
    if numbers != list(range(1, 106)):
        raise ValueError("The preserved reference must contain patterns 1 through 105 exactly once")
    print(json.dumps({
        "query": query,
        "total": len(patterns),
        "patterns": search(patterns, query),
        "usage": "Search by a task phrase, use 'index' for all titles, or '#N' for the complete original pattern. Rust code and numerical thresholds are historical examples; adapt the invariant to the current language and verify it on the real system.",
    }))


if __name__ == "__main__":
    main()

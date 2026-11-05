"""Candidate pool of sourced phrases: the catalog listing, gettrillion.ai copy (trillion-site src JSON, read only)
and git log facts from the Trillion and trillion-site checkouts the place reports (TRILLION_CHECKOUT, TRILLION_SITE). Every phrase keeps a checkable source."""
import json, re, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"lib")); import place
TRILLION, SITE_REPO = place.reported("TRILLION_CHECKOUT"), place.reported("TRILLION_SITE"); TLV = Path(__file__).resolve().parents[3]   # this repository, wherever this place keeps it
LISTING = TLV/"library/fills/_catalog/listings/workflow-listing.json"
SITE = SITE_REPO/"src"
pool = []
def add(text, src, origin):
    t = re.sub(r"\*\*", "", text).strip().strip(".").strip()
    if 1 <= len(t.split()) <= 14 and t not in {p["text"] for p in pool}:
        pool.append({"text": t, "source": src, "origin": origin})
def clauses(s):
    s = re.sub(r"\*\*", "", s)
    for sent in re.split(r"(?<=[.!?])\s+", s):
        yield sent
        for c in re.split(r"[,:;()]| then | and | so ", sent):
            if len(c.split()) >= 2: yield c
L = json.loads(LISTING.read_text())
ls = f"{LISTING.relative_to(TLV)}:1"
add(L["title"], ls, "listing")
for st in L["steps"]: add(st, ls, "listing")
for c in clauses(L["job"]): add(c, ls, "listing")
for fn in ["pages.json", "marketplace.json", "for-you.json"]:
    lines = (SITE/fn).read_text().splitlines()
    for n, line in enumerate(lines, 1):
        for s in re.findall(r'"(?:heading|lead|text|title|label|description|job|paragraphs|summary)"\s*:\s*"([^"]{8,400})"', line) + \
                 ([line.strip().strip(",").strip('"')] if re.match(r'^\s*"[A-Z][^"]{20,400}",?$', line) else []):
            for c in clauses(s): add(c, f"trillion-site:src/{fn}:{n}", "site")
for repo in [TRILLION, SITE_REPO]:
    out = subprocess.run(["git", "-C", str(repo), "log", "--format=%h\t%ad\t%s", "--date=short"], capture_output=True, text=True).stdout
    rows = [r.split("\t") for r in out.splitlines() if r.count("\t") == 2]
    for h, d, s in rows: add(s, f"git:{repo.name}@{h}", "git")
    if rows:  # dated facts from the history itself
        first, last = rows[-1], rows[0]
        add(f"{len(rows)} commits since {first[1]}", f"git:{repo.name}@{first[0]}", "git-fact")
json.dump(pool, open(Path(__file__).parent/"pool.json", "w"), indent=1)
from collections import Counter; print(len(pool), Counter(p["origin"] for p in pool))

# Typed candidates (no model): number+noun spans, product names, dated spans from git history.
NUM = r"\b(\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|hundreds|thousands)\s+([a-zA-Z][a-zA-Z'-]+(?:\s[a-zA-Z][a-zA-Z'-]+)?)"
for p in list(pool):
    for m in re.finditer(NUM, p["text"]):
        add(f"{m.group(1)} {m.group(2)}", p["source"], p["origin"] + "-number")
for fn in ["pages.json", "marketplace.json"]:
    for n, line in enumerate((SITE/fn).read_text().splitlines(), 1):
        if '"Trillion' in line or " Trillion" in line:
            add("Trillion", f"trillion-site:src/{fn}:{n}", "site-name"); break
import datetime
for repo in [SITE_REPO, TRILLION]:
    out = subprocess.run(["git", "-C", str(repo), "log", "--reverse", "--format=%h\t%ad", "--date=short"], capture_output=True, text=True).stdout.splitlines()
    if out:
        h, d = out[0].split("\t"); days = (datetime.date(2026, 10, 17) - datetime.date.fromisoformat(d)).days
        add(f"{days} days", f"git:{repo.name}@{h}", "git-fact"); add(f"{round(days/7)} weeks", f"git:{repo.name}@{h}", "git-fact")
json.dump(pool, open(Path(__file__).parent/"pool.json", "w"), indent=1)
print("with typed:", len(pool), Counter(p["origin"] for p in pool))

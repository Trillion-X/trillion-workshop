"""Candidate pool of sourced phrases: the catalog listing, gettrillion.ai copy (trillion-site src JSON, read only)
and git log facts from the Trillion and trillion-site checkouts the computer reports (TRILLION_CHECKOUT, TRILLION_SITE). Every phrase keeps a checkable source.
(As first run. Here every one of those is the request's: a listing, a site's JSON files, git histories, a product name.)

  python3 -I tools/benchmark-small-local-models/do-work/make_candidate_pool.py <request.json>   (or stdin)

Request: listing (a catalog listing JSON { title, steps, job }), listing_root (the folder its source is said from),
site (a folder of JSON files), site_label (how a site line's source starts, <site_label>:src/<file>:<line>),
site_files ([file]: every string of the keys below, 8 to 400 characters, and every line that is only a capitalised
string, split into clauses), name and name_files (the product name, sourced to the first line of those files that holds
it), repos ([git checkout]: every commit subject, then "<n> commits since <first date>"), age_repos ([git checkout]:
"<d> days" and "<w> weeks" from its first commit to as_of), as_of (YYYY-MM-DD), most_words, write_to.
Answer: { result: { pool: [{ text, source, origin }], by_origin } }. Needs git."""
import json, re, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"read-data")); import computer
R = computer.request(); MOST = computer.need(R, "most_words")
REPOS, AGE_REPOS = [Path(r) for r in computer.need(R, "repos")], [Path(r) for r in computer.need(R, "age_repos")]
TLV = Path(computer.need(R, "listing_root"))
LISTING = Path(computer.need(R, "listing"))
SITE = Path(computer.need(R, "site")); SITE_LABEL = computer.need(R, "site_label")
pool = []
def add(text, src, origin):
    t = re.sub(r"\*\*", "", text).strip().strip(".").strip()
    if 1 <= len(t.split()) <= MOST and t not in {p["text"] for p in pool}:
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
for fn in computer.need(R, "site_files"):
    lines = (SITE/fn).read_text().splitlines()
    for n, line in enumerate(lines, 1):
        for s in re.findall(r'"(?:heading|lead|text|title|label|description|job|paragraphs|summary)"\s*:\s*"([^"]{8,400})"', line) + \
                 ([line.strip().strip(",").strip('"')] if re.match(r'^\s*"[A-Z][^"]{20,400}",?$', line) else []):
            for c in clauses(s): add(c, f"{SITE_LABEL}:src/{fn}:{n}", "site")
def git(*argv):
    try: return subprocess.run(argv, capture_output=True, text=True).stdout
    except FileNotFoundError: computer.refuse("git is not on PATH: install it")
for repo in REPOS:
    out = git("git", "-C", str(repo), "log", "--format=%h\t%ad\t%s", "--date=short")
    rows = [r.split("\t") for r in out.splitlines() if r.count("\t") == 2]
    for h, d, s in rows: add(s, f"git:{repo.name}@{h}", "git")
    if rows:  # dated facts from the history itself
        first, last = rows[-1], rows[0]
        add(f"{len(rows)} commits since {first[1]}", f"git:{repo.name}@{first[0]}", "git-fact")
from collections import Counter; print(len(pool), Counter(p["origin"] for p in pool))

# Typed candidates (no model): number+noun spans, product names, dated spans from git history.
NUM = r"\b(\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|hundreds|thousands)\s+([a-zA-Z][a-zA-Z'-]+(?:\s[a-zA-Z][a-zA-Z'-]+)?)"
for p in list(pool):
    for m in re.finditer(NUM, p["text"]):
        add(f"{m.group(1)} {m.group(2)}", p["source"], p["origin"] + "-number")
NAME = computer.need(R, "name")
for fn in computer.need(R, "name_files"):
    for n, line in enumerate((SITE/fn).read_text().splitlines(), 1):
        if f'"{NAME}' in line or f" {NAME}" in line:
            add(NAME, f"{SITE_LABEL}:src/{fn}:{n}", "site-name"); break
import datetime
AS_OF = datetime.date.fromisoformat(computer.need(R, "as_of"))
for repo in AGE_REPOS:
    out = git("git", "-C", str(repo), "log", "--reverse", "--format=%h\t%ad", "--date=short").splitlines()
    if out:
        h, d = out[0].split("\t"); days = (AS_OF - datetime.date.fromisoformat(d)).days
        add(f"{days} days", f"git:{repo.name}@{h}", "git-fact"); add(f"{round(days/7)} weeks", f"git:{repo.name}@{h}", "git-fact")
print("with typed:", len(pool), Counter(p["origin"] for p in pool))
computer.answer({"pool": pool, "by_origin": dict(Counter(p["origin"] for p in pool))})

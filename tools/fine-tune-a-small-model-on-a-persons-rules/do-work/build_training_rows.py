def norm(t):
    return re.sub(r"\s+", " ", t.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')).strip()


def sentences(text):
    return [s.strip() for s in re.findall(r"[^.!?]+(?:[.!?]+[\"'”)]*|$)", text) if s.strip()] or [text]


def side(key, test_share=0.5):
    """Deterministic train/test side for a group key."""
    return "test" if int(hashlib.blake2b(key.encode(), digest_size=8).hexdigest(), 16) % 1000 < test_share * 1000 else "train"


def laws():
    out = json.load(open(DATA / "target-laws.json"))
    for lid, q in EXTRA_QUESTIONS.items():
        out[lid]["question"] = q
    for law in out.values():
        law["options"] = ["no", "yes"]
        law["fail"] = "no" if law["question"].startswith("Would a person say this line out loud") else "yes"
    return out


def skill_group(text, docs):
    key = norm(text)[:40]
    for f, d in docs.items():
        k = d.find(key)
        if k >= 0:
            head = [m.group(0) for m in re.finditer(r"(?m)^(?:#+ |\d+[a-z]?\. |\*\*[^*\n]+\*\*).*$", d[:k])]
            return f"{Path(f).relative_to(SKILLS)}::{head[-1] if head else ''}"
    return None



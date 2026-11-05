LIVE = 9223372036854775807
ACCOUNT_SQL = "select distinct account from versions limit 3"

TRANSCRIPT = re.compile(r"transcript|_raw\.|_cleaned_up|_clean\.|_rag\.|\.srt$|\.vtt$", re.I)


def kind_of(name, display):
    low = (display or name).lower()
    if low.endswith((".srt", ".vtt")):
        return "srt"
    if "_raw." in low:
        return "raw"
    if "_cleaned_up" in low or "_clean." in low:
        return "cleaned"
    if "_rag." in low:
        return "rag"
    return "transcript-named"


def main():
    os.makedirs(OUT, exist_ok=True)
    db = sqlite3.connect(STORE, uri=True)
    alias = {i[3:]: json.loads(b)["identity"] for i, b in db.execute(
        "select id, body from versions where resource='@namespace/aliases' and valid_to=? and deleted=0", (LIVE,))}
    files = {i: json.loads(b) for i, b in db.execute(
        "select id, body from versions where resource='@namespace/files' and valid_to=? and deleted=0", (LIVE,))}
    rows, stats = [], collections.Counter()
    for line in open(ASSETS):
        r = json.loads(line)
        if r["root"] != args.root or r["ext"] not in ("srt", "vtt", "json", "txt"):
            continue
        name, display = r["name"], r.get("display_path") or ""
        if not (TRANSCRIPT.search(name) or "transcript" in display.lower()):
            continue
        k = kind_of(name, display)
        ident = alias.get(r["sha256"]) or (f"1f:{r['sha256']}" if f"1f:{r['sha256']}" in files else None)
        f = files.get(ident) if ident else None
        origin = f["origin"] if f else "missing"
        stats[(k, origin)] += 1
        rows.append((k, r["ext"], origin, ident or "", f["byte_length"] if f else "", r["sha256"], display or name))
    with open(OUT + "/namespace-match.tsv", "w") as out:
        out.write("kind\text\torigin\tidentity\tbytes\tsha256\tdisplay_path\n")
        for row in rows:
            out.write("\t".join(str(c) for c in row) + "\n")
    print(len(rows), "transcript-like files")
    for (k, o), n in sorted(stats.items()):
        print(k, o, n)


main()

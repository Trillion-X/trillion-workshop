import json, os, subprocess, sys, time, uuid

RECIPE = "workflow:run-the-tests-of-what-landed"
CURSOR = "post-land tests cursor"
SINCE, COMMIT = (sys.argv[1] if len(sys.argv) > 1 else ""), (sys.argv[2] if len(sys.argv) > 2 else "")
# Run on the person's computer as `run_the_tests.py SINCE COMMIT CLI DATABASE`; the module map is read-data/module-map.json.


def sql(statement, params=()):
    call = json.dumps({"database": DATABASE, "sql": statement, "params": list(params),
                       "statement_timeout_ms": 20000})
    seen = []
    for _ in range(5):
        out = subprocess.run([CLI_PATH, "call", "tool:run-sql-in-my-database", call, "--timeout", "90"],
                             capture_output=True, text=True, timeout=400)
        try:
            return json.loads(out.stdout)["result"]["rows"]
        except (ValueError, KeyError, TypeError):
            seen.append((out.stdout + out.stderr)[:200])
            time.sleep(10)
    raise SystemExit("post-land: run-sql gave no rows; last answers: " + " | ".join(seen[-2:]))


def git(*args, check=True):
    return subprocess.run(["git", "-C", REPO, *args], capture_output=True, text=True, check=check).stdout


MAP = json.load(open(os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "read-data", "module-map.json")))
CLI_PATH = os.path.expanduser(sys.argv[3])  # the calling site names its command and database; this shared tool names neither
DATABASE = sys.argv[4]
JOB = MAP["job"]
REPO = os.path.expanduser(MAP["repo"])
git("fetch", "-q", "origin")
if not COMMIT:
    COMMIT = git("rev-parse", "origin/main").strip()
if not SINCE:
    SINCE = sql("select coalesce((select summary from calendar_tasks where job = $1 and title = $2 "
                "order by made_at desc limit 1), '') as s", [JOB, CURSOR])[0]["s"]
if not SINCE:
    SINCE = git("rev-parse", COMMIT + "^").strip()
if SINCE == COMMIT:
    print(json.dumps({"status": "nothing-new", "commit": COMMIT[:9]}))
    raise SystemExit(0)

changed = [p for p in git("diff", "--name-only", SINCE, COMMIT, "--", "*.rs").splitlines() if p]
keys, unmapped = [], []
for path in changed:
    if path in MAP["skip_paths"]:
        unmapped.append(path)
        continue
    if path.startswith(MAP["source_root"]) and path.endswith(".rs"):
        segments = path[len(MAP["source_root"]):-3].split("/")
        if segments[-1] in MAP["drop_last_segments"]:
            segments = segments[:-1]
        if not segments:
            unmapped.append(path)
            continue
        key = "::".join(segments)
    elif path.startswith(MAP["test_root"]) and path.count("/") == 1:
        key = "test:" + path[len(MAP["test_root"]):-3]
    else:
        unmapped.append(path)
        continue
    if key not in keys:
        keys.append(key)

lane = next((line[6:] for line in git("log", "-1", "--format=%B", COMMIT).splitlines() if line.startswith("Lane: ")), "")
results = []
export = None
if keys:
    export = os.path.expanduser(f"{MAP['export_folder']}/{COMMIT[:9]}-{int(time.time())}")
    os.makedirs(export)
    archive = subprocess.run(["git", "-C", REPO, "archive", COMMIT], capture_output=True, check=True).stdout
    subprocess.run(["tar", "-x", "-C", export], input=archive, check=True)
    env = {**os.environ, "CARGO_TARGET_DIR": os.path.expanduser(MAP["cargo_target"])}
    for key in keys:
        args = ["--test", key[5:]] if key.startswith("test:") else ["--lib", key]
        started = time.monotonic()
        run = subprocess.run(["timeout", "-k", "10", str(MAP["cap_seconds"]), "cargo", "test", "-j", str(MAP["jobs"]), *args],
                             cwd=export, env=env, capture_output=True, text=True)
        seconds = round(time.monotonic() - started)
        text = run.stdout + run.stderr
        if run.returncode in (124, 137):
            status = "unknown"
        elif run.returncode == 0:
            status = "pass"
        else:
            status = "fail"
        failed = [line.split(" ... ")[0][5:] for line in text.splitlines() if line.startswith("test ") and line.endswith("FAILED")]
        results.append({"key": key, "status": status, "seconds": seconds, "failed": failed})

statuses = {r["status"] for r in results}
overall = "fail" if "fail" in statuses else "unknown" if "unknown" in statuses else "pass" if results else "not-mapped"
now = time.strftime("%Y-%m-%d %H:%M:%S%z")
short = COMMIT[:9]

if overall == "fail":
    for r in [r for r in results if r["status"] == "fail"]:
        open_rows = sql("select id from calendar_tasks where job = $1 and status = 'To do' and summary = $2", [JOB, r["key"]])
        if not open_rows:
            owner = sql("select started_by from wf_runs where lane = $1 order by started_at desc nulls last limit 1", [lane])
            session = owner[0]["started_by"] if owner and lane else ""
            live = False
            if session:
                who = json.loads(subprocess.run([CLI_PATH, "who", "--all", "--json"], capture_output=True, text=True, timeout=120).stdout or "{}")
                live = any(chat.get("id") == "ai:" + session and chat.get("ready")
                           for group in who.get("groups", []) for ai in group.get("ais", []) for chat in ai.get("chats", []))
            assignees = ["ai:" + session] if live else ([lane] if lane else [])
            sql("insert into calendar_tasks (id, title, description, priority, status, job, summary, made_at, changed_at, labels, details, assignees) "
                "values ($1, $2, $3, 'high', 'To do', $4, $5, now(), now(), $6::jsonb, $7::jsonb, $8::jsonb)",
                [str(uuid.uuid4()), f"Post-land tests red: {short} {r['key']}",
                 f"Commit {COMMIT} (lane {lane or 'none'}) fails `cargo test {' '.join(['--lib', r['key']] if not r['key'].startswith('test:') else ['--test', r['key'][5:]])}` "
                 f"at {now}. Failing tests: {', '.join(r['failed']) or 'see the export log'}. Export: {export}.",
                 JOB, r["key"], json.dumps(["post-land-test"]),
                 json.dumps({"failed": r["failed"], "lane": lane, "lane_session": session,
                             "delivery": "to the live ai: record of the lane session" if live else "assigned to the lane name; the lead relays it, and the daily audit sweeps unpicked findings older than 1 h to the coordinator"}),
                 json.dumps(assignees)])
elif overall == "pass":
    # A finding closes when its key passed, or when every test it names is inside a filter that passed here.
    passed = [r["key"] for r in results]
    for row in sql("select id, summary, details from calendar_tasks where job = $1 and status = 'To do'", [JOB]):
        names = ((row["details"] or {}).get("failed")) or []
        covered = row["summary"] in passed or any(
            names and all(name == key or name.startswith(key + "::") for name in names) for key in passed)
        if covered:
            sql("update calendar_tasks set status = 'Done', finished_at = $1, outcome = $2, changed_at = now() where id = $3",
                [now, f"tests pass again at {short} ({', '.join(passed)})", row["id"]])
elif overall == "unknown":
    for r in [r for r in results if r["status"] == "unknown"]:
        sql("insert into calendar_tasks (id, title, description, priority, status, job, summary, made_at, changed_at) "
            "values ($1, $2, $3, 'medium', 'To do', $4, $5, now(), now())",
            [str(uuid.uuid4()), f"Post-land tests unknown (cap {MAP['cap_seconds']} s): {short} {r['key']}",
             f"Commit {COMMIT} did not finish inside {MAP['cap_seconds']} s; this is not a pass.", JOB, r["key"]])

sql("update calendar_tasks set summary = $1, changed_at = now() where job = $2 and title = $3", [COMMIT, JOB, CURSOR])
sql("insert into calendar_tasks (id, title, status, job, summary, made_at, changed_at) select $1, $2, 'Done', $3, $4, now(), now() "
    "where not exists (select 1 from calendar_tasks where job = $3 and title = $2)", [str(uuid.uuid4()), CURSOR, JOB, COMMIT])

print(json.dumps({"status": overall, "commit": short, "since": SINCE[:9], "unmapped": unmapped[:10],
                  "results": results}))

"""What workflow:make-matched-movement-clips measures about a recording, measured once and kept as rows keyed by the
recording's content identity (1f:...), so no later run, work folder or computer works it out again.

One row per fact, in a table of the pursuit's own database (job.facts.table; the person's AI made it):
  identity     the recording's content identity
  fact         perception    the pose track and descriptor kept in Files (their identities), the window count and the
                             length, or the refusal of a recording perception could not read
               swing         one swing window (part = its index): times, heading trajectory, camera angle class, the
                             stroke reading (forehand side, stroke, why unclear), contact time and its source, people, date
               recording     the recording's summary: people, date, playing hand, the forehand side its swings agree on
               contact-mark  a person's mark of a contact (part = the seconds)
               verdict       a person's verdict
  part         '' | the window index | the marked seconds | the verdict's own key
  fingerprint  the BLAKE3 identity of the canonical JSON of the settings it was measured with; '' for a person's fact
  value        the fact (JSON)
  measured_by  {"tool", "commit"} or {"person"}
A row is written once: a second measurement under the same fingerprint is never made, so a conflict keeps the first.

The rows are read and written through the command the job gives (job.facts.sql: an engine command that runs one SQL
statement from {"database", "sql", "params"} on stdin), never around it. Without job.facts nothing is read or kept.
"""
import json
import re
import subprocess

COLUMNS = ("identity", "fact", "part", "fingerprint", "value", "measured_by")
TABLE = re.compile(r"^[a-z_][a-z0-9_]*$")
CHUNK = 200


def fingerprint(settings):
    """The BLAKE3 content identity of the settings' canonical JSON (sorted keys, no spaces)."""
    text = json.dumps(settings, sort_keys=True, separators=(",", ":"))
    out = subprocess.run(["b3sum", "--no-names", "-"], input=text, capture_output=True, text=True, check=True).stdout
    return "1f:" + out.strip()


def _table(facts):
    if not TABLE.match(facts.get("table") or ""):
        raise ValueError(f"job.facts.table must be a plain table name, got {facts.get('table')!r}")
    return facts["table"]


def run_sql(facts, sql, params):
    """One statement through job.facts.sql; its rows, or RuntimeError with the store's reason."""
    r = subprocess.run(list(facts["sql"]), input=json.dumps({"database": facts["database"], "sql": sql, "params": params}),
                       capture_output=True, text=True)
    try:
        answer = json.loads(r.stdout)
    except ValueError:
        raise RuntimeError(f"facts store: no answer ({(r.stderr.strip().splitlines() or ['empty'])[-1][:200]})")
    if answer.get("exit_code") != 0 or "result" not in answer:
        raise RuntimeError(f"facts store: {str(answer.get('error') or answer)[:300]}")
    return answer["result"].get("rows") or []


def read_rows(facts, identities):
    """Every kept row about these recordings."""
    if not facts or not identities:
        return []
    return run_sql(facts, f"select identity, fact, part, fingerprint, value, measured_by from {_table(facts)} "
                          "where identity in (select jsonb_array_elements_text($1::jsonb))",
                   [json.dumps(sorted(set(identities)))])


def write_rows(facts, rows):
    """Keep new rows; a row already kept under the same identity, fact, part and fingerprint stays as it was.
    Answers how many were written."""
    if not facts or not rows:
        return 0
    written = 0
    for i in range(0, len(rows), CHUNK):
        got = run_sql(facts, f"insert into {_table(facts)} (identity, fact, part, fingerprint, value, measured_by) "
                             "select r->>'identity', r->>'fact', r->>'part', r->>'fingerprint', r->'value', r->'measured_by' "
                             "from jsonb_array_elements($1::jsonb) r on conflict (identity, fact, part, fingerprint) do nothing "
                             "returning identity",
                      [json.dumps([{c: row[c] for c in COLUMNS} for row in rows[i:i + CHUNK]])])
        written += len(got)
    return written


def index_rows(rows):
    """{(identity, fact, part, fingerprint): value}."""
    return {(r["identity"], r["fact"], r["part"], r["fingerprint"]): r["value"] for r in rows}


def marks_of(rows):
    """{identity: [seconds, ...]} from the contact-mark rows (a person's marks)."""
    marks = {}
    for r in rows:
        if r["fact"] == "contact-mark":
            marks.setdefault(r["identity"], []).append(float(r["value"]["seconds"]))
    return {k: sorted(v) for k, v in marks.items()}

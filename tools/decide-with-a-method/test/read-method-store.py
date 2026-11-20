# tools/decide-with-a-method/test/read-method-store.py
#
# Reads one method of the old decision store for test/method-store-records.test.mjs, by plain SQL, and prints it as JSON:
# { "method": old_store.method row, "checklist": the checklist rows that hold a check of one of the method's steps }.
# The database is opened only through held_database.connect (the vault's reader; the connection string never leaves that module).
# Usage: read-method-store.py <held_database lib dir> <held connection name> <method row id>
# Exit 3 when the held connection is unavailable, so the test can say why it skipped.
import json
import sys

sys.path.insert(0, sys.argv[1])
from held_database import HeldDatabaseError, connect  # noqa: E402

METHOD_SQL = "select id, name, steps from old_store.method where id = %s"
CHECKLIST_SQL = """
with steps as (
  select jsonb_array_elements(m.steps::jsonb) ->> 'id' as step from old_store.method m where m.id = %s
)
select c.id, c.checks from old_store.w_decision_step_checklist c
where exists (select 1 from jsonb_array_elements(c.checks::jsonb) x where x ->> 'step' in (select step from steps))
order by c.id
"""

try:
    conn = connect(sys.argv[2])
except HeldDatabaseError as error:
    print(str(error), file=sys.stderr)
    sys.exit(3)

cur = conn.cursor()
cur.execute(METHOD_SQL, (sys.argv[3],))
found = cur.fetchone()
if found is None:
    sys.exit(f"no method row {sys.argv[3]}")
method = dict(zip(["id", "name", "steps"], found))
cur.execute(CHECKLIST_SQL, (sys.argv[3],))
checklist = [dict(zip(["id", "checks"], row)) for row in cur.fetchall()]
conn.close()
json.dump({"method": method, "checklist": checklist}, sys.stdout)

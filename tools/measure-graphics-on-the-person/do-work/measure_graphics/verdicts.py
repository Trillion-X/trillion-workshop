"""Writes one clip_quality_verdicts row per (files_identity, check_id) through the held database reader.

The connection string never leaves the held_database process (see its docstring); this module passes SQL on standard input
and reads back the rows it wrote. Dollar quoting carries the JSON text, and the tag is checked not to occur inside it.
"""
import json
import os
import subprocess

# The held reader lives in the control-plane checkout; HELD_DATABASE_READER overrides where it is found.
HELD_DATABASE = os.environ.get('HELD_DATABASE_READER') or os.path.join(
    os.path.expanduser('~'), 'dev', 'ai-command-center', '.claude', 'hooks', 'lib', 'held_database.py')
TABLE = 'clip_quality_verdicts'


def _literal(value):
    if value is None:
        return 'NULL'
    text = json.dumps(value) if isinstance(value, (dict, list)) else str(value)
    tag = 'q'
    while f'${tag}$' in text:
        tag += 'q'
    return f'${tag}${text}${tag}$'


def upsert_sql(row):
    columns = ['files_identity', 'format_id', 'check_id', 'verdict', 'measured', 'bar', 'reason', 'evidence_ref', 'run']
    values = [row['files_identity'], row['format_id'], row['check_id'], row['verdict'], row['measured'], row['bar'],
              row['reason'], row['evidence_ref'], row['run']]
    literals = ', '.join(_literal(v) for v in values)
    assignments = ', '.join(f'{c} = EXCLUDED.{c}' for c in columns[3:]) + ', kept_at = now()'
    return (f"INSERT INTO public.{TABLE} ({', '.join(columns)}) VALUES ({literals}) "
            f"ON CONFLICT (files_identity, check_id) DO UPDATE SET {assignments};\n")


def write_rows(connection, rows):
    sql = "SET statement_timeout = '60s';\n" + ''.join(upsert_sql(r) for r in rows)
    done = subprocess.run(['python3', HELD_DATABASE, connection], input=sql, capture_output=True, text=True, timeout=180)
    if done.returncode != 0:
        raise RuntimeError(f'verdict rows were not written: {done.stderr.strip()[:400]}')
    return len(rows)


def read_rows(connection, sql):
    done = subprocess.run(['python3', HELD_DATABASE, connection], input=sql, capture_output=True, text=True, timeout=180)
    if done.returncode != 0:
        raise RuntimeError(f'query failed: {done.stderr.strip()[:400]}')
    return [json.loads(line) for line in done.stdout.splitlines() if line.strip().startswith('{')]


def fetch_rows(connection, table, ids):
    quoted = ', '.join("'" + i.replace("'", "''") + "'" for i in ids)
    where = f" WHERE id IN ({quoted})" if ids else ''
    return read_rows(connection, f"SET statement_timeout = '60s';\nSELECT * FROM public.{table}{where};\n")

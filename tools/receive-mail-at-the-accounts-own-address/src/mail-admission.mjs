// Durable admission before the mail binding is called. Pending and unknown deliveries keep their allowance;
// only a documented refusal releases it. Policy remains in mail-settings DATA, shared by every sending route.
import settings from '../../shared-code/src/mail-settings.json' with { type: 'json' };

export function mailAdmissionTables(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS mail_recipient_seeds (recipient TEXT PRIMARY KEY)');
  sql.exec('CREATE TABLE IF NOT EXISTS mail_day_allowance (day TEXT PRIMARY KEY, used INTEGER NOT NULL)');
  sql.exec(`CREATE TABLE IF NOT EXISTS mail_admissions (id TEXT NOT NULL, recipient TEXT NOT NULL, day TEXT NOT NULL,
    at_ms INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT, proof INTEGER NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY (id, recipient))`);
  sql.exec('CREATE INDEX IF NOT EXISTS mail_admissions_recipient_time ON mail_admissions (recipient, at_ms)');
}
const covers = (limit, kind) => limit.kinds ? limit.kinds.includes(kind) : !(limit.all_kinds_except ?? []).includes(kind);
const seedRecipient = (sql, recipient, rows) => {
  if (sql.exec('SELECT recipient FROM mail_recipient_seeds WHERE recipient = ? LIMIT 1', recipient).toArray().length) return;
  sql.exec('INSERT INTO mail_recipient_seeds (recipient) VALUES (?)', recipient);
  for (const [index, row] of (rows ?? []).entries()) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || typeof row.kind !== 'string') continue;
    sql.exec(`INSERT OR IGNORE INTO mail_admissions (id, recipient, day, at_ms, kind, subject, proof, state)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'sent')`, `legacy:${index}`, recipient, new Date(at).toISOString().slice(0, 10), at, row.kind,
      settings.sent_log.subject_kept_out_for.includes(row.kind) ? null : row.subject ?? null);
  }
};

export function reserveMail(storage, sql, { id, recipients, kind, subject, proof, now, legacy, legacyDay }) {
  return storage.transactionSync(() => {
    const day = new Date(now).toISOString().slice(0, 10);
    if (!proof) sql.exec('INSERT OR IGNORE INTO mail_day_allowance (day, used) VALUES (?, ?)', day, Math.max(0, Number(legacyDay) || 0));
    for (const recipient of recipients) {
      seedRecipient(sql, recipient, legacy?.[recipient]);
      const over = settings.per_person.limits.find(limit => {
        if (!covers(limit, kind)) return false;
        const kinds = limit.kinds ?? limit.all_kinds_except ?? [];
        const clause = kinds.length ? `AND kind ${limit.kinds ? 'IN' : 'NOT IN'} (${kinds.map(() => '?').join(',')})` : '';
        // reads-ok: scalar COUNT over one recipient's indexed time range; never materializes delivery rows.
        const count = sql.exec(`SELECT COUNT(*) AS n FROM mail_admissions WHERE recipient = ? AND at_ms > ? AND state != 'released' ${clause} LIMIT 1`,
          recipient, now - limit.window_minutes * 60000, ...kinds).toArray()[0].n;
        return count >= limit.most;
      });
      if (over) return { allowed: false, error: over.says };
    }
    const used = proof ? 0 : sql.exec('SELECT used FROM mail_day_allowance WHERE day = ? LIMIT 1', day).toArray()[0].used;
    const cap = settings.daily.most - (settings.daily.kept_for.includes(kind) ? 0 : settings.daily.keep_back);
    if (!proof && used >= cap) return { allowed: false, error: settings.daily.says };
    for (const recipient of recipients) sql.exec(`INSERT INTO mail_admissions (id, recipient, day, at_ms, kind, subject, proof, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved')`, id, recipient, day, now, kind,
      settings.sent_log.subject_kept_out_for.includes(kind) ? null : subject ?? null, proof ? 1 : 0);
    if (!proof) sql.exec('UPDATE mail_day_allowance SET used = used + 1 WHERE day = ?', day);
    // Bounded retirement only; a request never reads or deletes the whole sending history.
    sql.exec('DELETE FROM mail_admissions WHERE rowid IN (SELECT rowid FROM mail_admissions WHERE at_ms < ? LIMIT 500)', now - settings.sent_log.days * 86400000);
    return { allowed: true, id };
  });
}

export function settleMail(storage, sql, id, state, providerFull = false) {
  if (!['sent', 'unknown', 'released'].includes(state)) throw new Error('The email result is invalid.');
  return storage.transactionSync(() => {
    const [row] = sql.exec('SELECT day, proof, state FROM mail_admissions WHERE id = ? LIMIT 1', id).toArray();
    if (!row) return;
    if (providerFull) sql.exec('UPDATE mail_day_allowance SET used = MAX(used, ?) WHERE day = ?', settings.daily.most, row.day);
    if (row.state !== 'reserved') return;
    sql.exec('UPDATE mail_admissions SET state = ? WHERE id = ?', state, id);
    if (state === 'released' && !row.proof && !providerFull) sql.exec('UPDATE mail_day_allowance SET used = MAX(0, used - 1) WHERE day = ?', row.day);
  });
}

export function mailSentTo(storage, sql, recipient, now, legacy) {
  return storage.transactionSync(() => {
    seedRecipient(sql, recipient, legacy);
    const rows = [];
    let before = null;
    do {
      const page = sql.exec(`SELECT rowid AS cursor, at_ms, kind, subject FROM mail_admissions
        WHERE recipient = ? AND at_ms > ? AND state = 'sent' AND (? IS NULL OR rowid > ?) ORDER BY rowid LIMIT 200`,
        recipient, now - settings.sent_log.days * 86400000, before, before).toArray();
      for (const row of page) rows.push({ at: new Date(row.at_ms).toISOString(), kind: row.kind,
        ...(row.subject === null ? {} : { subject: row.subject }) });
      if (page.length < 200) break;
      before = page.at(-1).cursor;
    } while (true);
    return rows.sort((a, b) => a.at.localeCompare(b.at));
  });
}

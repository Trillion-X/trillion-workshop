// src/calendar-task-messages.mjs
//
// PURPOSE
//   Decides which built-in list (smart_list on a Calendar task) a mail message becomes a todo in. Pure: it reads the message's
//   facts and the rows of calendar-tasks.json `email_split`, and writes nothing. A new rule is a new row, never new code.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The first row whose test matches wins; a row with no test is the default.
//   2. A message fact that is missing never matches a test (the row is skipped), it does not throw.
//   3. A pattern that is not a valid expression never matches.
import data from './calendar-tasks.json' with { type: 'json' };

const textOf = value => (typeof value === 'string' ? value : '');

function facts(message) {
  return {
    subject: textOf(message.subject),
    from: textOf(message.from),
    labels: Array.isArray(message.labels) ? message.labels.filter(label => typeof label === 'string') : [],
    list_unsubscribe: message.list_unsubscribe === true,
    has_invite: message.has_invite === true,
  };
}

function hit(row, known) {
  if (!row.field) return true;
  const value = known[row.field];
  if (value === undefined) return false;
  const values = Array.isArray(value) ? value : [value];
  if (Object.hasOwn(row, 'is')) {
    const wanted = Array.isArray(row.is) ? row.is : [row.is];
    return values.some(item => wanted.includes(item));
  }
  if (Object.hasOwn(row, 'contains')) return values.some(item => typeof item === 'string' && item.toLowerCase().includes(String(row.contains).toLowerCase()));
  if (Object.hasOwn(row, 'matches')) {
    let pattern;
    try { pattern = new RegExp(row.matches, 'i'); } catch { return false; }
    return values.some(item => typeof item === 'string' && pattern.test(item));
  }
  return false;
}

/** The smart list ('calendar', 'email' or 'other', whatever the rows name) a message becomes a todo in. */
export function classifyMessage(message, rows = data.email_split.rows) {
  const known = facts(message && typeof message === 'object' ? message : {});
  return rows.find(row => hit(row, known))?.to ?? null;
}

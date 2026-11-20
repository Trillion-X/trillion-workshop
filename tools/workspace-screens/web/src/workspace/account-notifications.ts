// src/workspace/account-notifications.ts
//
// PURPOSE
//   The person's notices for the bell (person-notifications.ts) on a page served from files: GET /work/api/notifications
//   answers the newest rows of the person's notices, and POST /work/api/notifications/read marks them read or unread, in
//   the statements the notice workflows give (account-notices.json), run in the person's own database through the
//   statement runner the page was given (the SQL tool, with the person's own rights).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every row is one the database answered; a notice keeps its own id, time, words and read state. No table yet is
//      no notices.
//   2. Nothing here offers an action a notice does not carry: a notice row holds words and a time, so it offers none.
//   3. A mark names only the person's own notices by their numbers; any other id is refused before a statement runs.

import type { PageAnswer } from './api';
import type { RunStatement } from './sql-records';
import notices from './account-notices.json' with { type: 'json' };

const LIST = '/work/api/notifications', READ = '/work/api/notifications/read';
const NO_TABLE = /relation .* does not exist|42P01/;

export function notificationsAnswers(run: RunStatement) {
  return async (path: string, init: RequestInit): Promise<PageAnswer | null> => {
    const at = new URL(path, location.origin).pathname, method = (init.method ?? 'GET').toUpperCase();
    if (at === LIST && method === 'GET') {
      const rows = await run(notices.list, [notices.most]).catch(error => {
        if (NO_TABLE.test(String(error?.message ?? error))) return [];
        throw error;
      });
      return { status: 200, body: { items: rows.map(row => ({
        id: `${notices.id_prefix}${row.id}`, kind: String(row.kind ?? 'notice'), at: new Date(String(row.made_at)).toISOString(),
        title: String(row.title ?? ''), detail: row.body ? String(row.body) : null, actions: [],
        read: row.read_at !== null && row.read_at !== undefined, waiting: false, running: false, about: null,
      })) } };
    }
    if (at === READ && method === 'POST') {
      const asked = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { read?: boolean; ids?: unknown[] };
      const numbers = (asked.ids ?? []).map(id => String(id)).map(id => id.startsWith(notices.id_prefix) ? id.slice(notices.id_prefix.length) : '');
      if (!numbers.length || numbers.some(number => !/^\d+$/.test(number))) return { status: 400, body: { error: 'Mark only your own notices, by their ids.' } };
      await run(asked.read === false ? notices.mark_unread : notices.mark_read, [numbers]);
      return { status: 200, body: { marked: numbers.length } };
    }
    return null;
  };
}

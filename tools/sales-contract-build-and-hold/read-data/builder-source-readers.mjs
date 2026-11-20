// The readers the account hands to the sales contract builder's source reads: the lists reader and the rule for a tool
// run's answer. Port of dealResources' readers in the old native commercial owner (src/native-commercial-domain.mjs at
// 3b7063d6f3). Storage-free: the caller passes the lists and a way to read one list's rows.
import data from './builder-source-readers.json' with { type: 'json' };

/**
 * lists: every list ({ id, row_type, label, fields }); readList(id) → { rows: [{ id, title?, values }] }.
 * → { rows: [{ id: "list:row", title, email, list }] } for the lists whose row type or id is asked for.
 */
export function listsReaderAnswer({ lists, readList, row_types = [], list_ids = [] }) {
  return {
    rows: lists.filter(list => row_types.includes(list.row_type) || list_ids.includes(list.id)).flatMap(list => {
      const { rows } = readList(list.id);
      const emailField = (list.fields ?? []).find(field => field.kind === 'email')?.id;
      return rows.map(row => ({
        id: `${list.id}:${row.id}`,
        title: row.title ?? row.id,
        email: emailField ? row.values?.[emailField] : undefined,
        list: list.label,
      }));
    }),
  };
}

/** A tool run's output; only a completed run answers, anything else says why it did not. */
export function toolReaderAnswer(task) {
  if (task.state !== 'completed') throw new Error(task.error ?? data.messages.too_long);
  return task.output;
}

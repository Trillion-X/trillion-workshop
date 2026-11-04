// tools/plan-tasks-and-todo-lists/sort-mail-into-task-lists.mjs
//
// Which built-in to-do list (calendar, email or other) each mail message would become a task in, by the email_split rows
// of calendar-tasks.json (calendar-task-messages.mjs: the first row whose test matches wins; the last row is the default).
// Pure: it reads only the messages it is given and the rows, and writes, sends and keeps nothing.
//
// Input:  { messages: [{ subject?, from?, labels?: [text], list_unsubscribe?: boolean, has_invite?: boolean }] }
//         (at most email_split.most_messages messages)
// Answer: { messages: [{ index, subject, smart_list }], counts: { <smart_list>: n } }
// Refuses: no messages, more than the most, or a message that is not an object.
import data from './calendar-tasks.json' with { type: 'json' };
import { classifyMessage } from './calendar-task-messages.mjs';

export function sortMailIntoTaskLists({ messages } = {}) {
  const most = data.email_split.most_messages;
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('Give messages: a list of { subject, from, labels, list_unsubscribe, has_invite }.');
  if (messages.length > most) throw new Error(`Give at most ${most} messages in one run; send the rest in another run.`);
  const counts = {};
  const sorted = messages.map((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error(`Message ${index} is not an object; give { subject, from, labels, ... }.`);
    const smart_list = classifyMessage(message);
    counts[smart_list] = (counts[smart_list] ?? 0) + 1;
    return { index, subject: typeof message.subject === 'string' ? message.subject : '', smart_list };
  });
  return { messages: sorted, counts };
}

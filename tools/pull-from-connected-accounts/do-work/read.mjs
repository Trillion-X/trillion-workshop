// tools/pull-from-connected-accounts/do-work/read.mjs
//
// Read back what has been pulled for one source and account: a summary of its conversations and collections, or one
// conversation's messages. It changes nothing.
import { assemble, readParts } from '../read-data/snapshot.mjs';
import { sourceIds } from '../read-data/sources.mjs';

const MOST_MESSAGES = 500;

export async function readPulledSnapshot(input, { door }) {
  const ids = sourceIds();
  if (!ids.includes(input.source)) throw new Error(`source is one of ${ids.join(', ')}.`);
  const account = input.account === undefined ? 'default' : input.account;
  if (typeof account !== 'string' || !account.trim()) throw new Error('account is the name the account was pulled under (the default is "default").');
  const held = await readParts(door, input.source, account);
  const snapshot = assemble(input.source, account, held);
  const pulledAt = held.state?.pulled_at ?? null;
  if (!held.state) return { source: input.source, account, self_id: null, cursor: null, pulled_at: null, threads: [], collections: {}, said: `Nothing has been pulled from ${input.source} for the account ${account} yet.` };

  if (input.thread !== undefined) {
    const thread = snapshot.threads.find(candidate => String(candidate.id) === String(input.thread));
    if (!thread) throw new Error(`There is no conversation ${input.thread} for this account; read without thread to list them.`);
    const limit = input.limit === undefined ? 100 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > MOST_MESSAGES) throw new Error(`limit is a whole number from 1 to ${MOST_MESSAGES}.`);
    return { source: input.source, account, self_id: snapshot.self_id, cursor: snapshot.cursor, pulled_at: pulledAt, thread: { ...thread, total: thread.messages.length, messages: thread.messages.slice(-limit) }, said: `${thread.messages.length} messages in ${thread.title}; the last ${Math.min(limit, thread.messages.length)} are shown.` };
  }
  const threads = snapshot.threads.map(thread => ({ id: String(thread.id), title: thread.title, messages: thread.messages.length }));
  const collections = Object.fromEntries(Object.entries(snapshot.collections).map(([name, list]) => [name, list.length]));
  const totals = [`${threads.length} conversations`, ...Object.entries(collections).map(([name, count]) => `${count} ${name}`)].join(', ');
  return { source: input.source, account, self_id: snapshot.self_id, cursor: snapshot.cursor, pulled_at: pulledAt, threads, collections, said: `Pulled from ${input.source} (${account}): ${totals}.` };
}

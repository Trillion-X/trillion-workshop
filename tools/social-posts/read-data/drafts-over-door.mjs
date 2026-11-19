// tools/social-posts/read-data/drafts-over-door.mjs
//
// The two computations over records the caller hands in: tool:use-a-snippet and tool:read-a-thread-summary. Each record
// comes in as `records` ([{ id, type, value }]) from the store the person keeps it in, and nothing is read from a store
// or written by these runs. Saving, finding, removing and keeping are the store's own job (the recipes
// workflow:keep-the-persons-snippets and workflow:keep-conversation-summaries).
import { makeSnippets } from './snippets.mjs';
import { makeThreadSummaries } from './thread-summaries.mjs';

const eeafOver = records => {
  const held = new Map((Array.isArray(records) ? records : []).filter(record => record && typeof record.id === 'string' && record.value).map(record => [record.id, record.value]));
  return { read: id => structuredClone(held.get(id) ?? null) };
};

/** tool:use-a-snippet: its words with the blanks filled. The snippet comes in as `records`; nothing is read from a store or written. */
export const useASnippet = input => makeSnippets({ eeaf: eeafOver(input?.records) }).use(input ?? {});

// The newer count: the thread's messages, handed in as the times of its newest ones.
const newerOf = input => ({ after }) => (Array.isArray(input?.message_times) ? input.message_times : []).filter(time => Date.parse(time) > Date.parse(after)).length;

/** tool:read-a-thread-summary: the summary (handed in as `records`) and how many of `message_times` are newer than what it covers. Nothing is read from a store. */
export const readAThreadSummary = input => makeThreadSummaries({ eeaf: eeafOver(input?.records), newer: newerOf(input) }).read(input ?? {});

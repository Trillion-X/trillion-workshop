// src/workspace/conversation-navigation-rows.mjs
//
// The person's conversations as rows of the sidebar, so Messages uses the sidebar like every other screen (the owner
// 2026-09-29: "it's clearly not using the sidebar"): one row per conversation with their AIs, newest first, each
// opening the Messages screen on that conversation. The Messages screen then draws only the conversation.
//
// Non-negotiable invariants
//   1. A conversation's id is made here and only here (recordIdOf); src/workspace/chat-records.ts imports it, so a row
//      and the conversation it opens can never disagree.
//   2. The rows are the Messages screen's own row (its list, its look, its package entry) with the conversation as
//      its input, the way pursuit rows are the Progress screen's (pursuit-navigation-rows.mjs); the list they sit in is
//      the Messages screen's `sidebar_collection`, DATA in records/workshop-screen-tool-records.json.
//   3. "All your AIs" is always first: one message to every AI the person uses.

/** The one id a conversation has: a Space's, or an AI app's conversation. */
export const recordIdOf = context => (context.kind === 'space' ? `space:${context.space_id}`
  : `messages:${encodeURIComponent(context.app)}:${encodeURIComponent(context.conversation_id)}`);
/** Resolve an addressed conversation without depending on which preview rows are loaded. This only decodes its
 *  identity; the owner still authorizes the read and confirms whether the conversation exists. */
export function contextOfRecordId(recordId) {
  if (typeof recordId !== 'string') return null;
  if (recordId.startsWith('space:') && recordId.length > 'space:'.length) {
    return { kind: 'space', space_id: recordId.slice('space:'.length) };
  }
  const match = /^messages:([^:]+):([^:]+)$/.exec(recordId);
  if (!match) return null;
  try {
    const app = decodeURIComponent(match[1]);
    const conversation_id = decodeURIComponent(match[2]);
    return app.trim() && conversation_id.trim() ? { kind: 'ai', app, conversation_id } : null;
  } catch { return null; }
}
/** The conversation every AI the person uses reads. */
export const SHARED_CONVERSATION = { app: 'Trillion', conversation_id: 'trillion:shared' };
export const EVERYONE_LABEL = 'All your AIs';
const LABEL_CHARS = 32;

/** One sidebar row per conversation in `threads` (the /work/api/messages/threads answer), All your AIs first. */
export function conversationNavigationRows(threads, screens) {
  const messages = screens.find(row => row.opens_kinds?.includes('message'));
  if (!messages) return [];
  const { route_paths, route_query, opens_kinds, placement_order_key, actions, ...screen } = messages;
  const shared = thread => thread.app === SHARED_CONVERSATION.app && thread.conversation_id === SHARED_CONVERSATION.conversation_id;
  const own = (threads ?? []).filter(thread => !shared(thread) && typeof thread.app === 'string' && typeof thread.conversation_id === 'string');
  // An app with one conversation reads as the app; an app with several names each by the start of its latest words.
  const apps = own.reduce((count, thread) => count.set(thread.app, (count.get(thread.app) ?? 0) + 1), new Map());
  const start = words => { const line = String(words ?? '').replace(/\s+/g, ' ').trim(); return line.length > LABEL_CHARS ? `${line.slice(0, LABEL_CHARS - 1)}…` : line; };
  const rows = [{ ...SHARED_CONVERSATION, label: EVERYONE_LABEL, icon: 'Users' },
    ...own.map(thread => ({ app: thread.app, conversation_id: thread.conversation_id,
      label: apps.get(thread.app) > 1 && start(thread.latest?.text) ? `${thread.app}: ${start(thread.latest.text)}` : thread.app }))];
  return rows.map((row, index) => {
    const id = recordIdOf({ kind: 'ai', ...row });
    return {
      ...screen,
      id: `conversation:${id}`,
      surface_id: `conversation:${id}`,
      source: { kind: 'conversation-navigation' },
      // A conversation is not newly made work; it stays out of rule-filled New lists.
      sidebar_new_eligible: false,
      label: row.label,
      ...(row.icon ? { icon: row.icon } : {}),
      surface_input: { ...screen.surface_input, conversation: id },
      order: Number(screen.order ?? 0) + index + 1,
      placement_order_key: `${String(Number(screen.order ?? 0) + index + 1).padStart(9, '0')}:conversation:${id}`,
    };
  });
}

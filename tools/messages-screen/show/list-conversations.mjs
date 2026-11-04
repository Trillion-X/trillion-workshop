// tools/messages-screen/show/list-conversations.mjs
//
// The Messages screen's conversation list as one run: the conversations given are sorted newest first, kept when they
// match the words, participant and project asked for, and grouped Today, Yesterday, This Week and Older, by the same
// helpers the screen's sidebar uses (build-chat-conversation-list.ts). It reads no records and draws nothing: the
// caller hands in the conversation rows.
//
// Input:
//   conversations  [{ recordId, sessionId, participantRef, lastActivityAt, title?, projectSlug?, projectName?, ... }]
//                  one row per conversation (lastActivityAt: an ISO date); other fields are kept as given
//   search?        words matched, ignoring case, against title, sessionId, projectSlug and recordId
//   participant?   keep only conversations whose participantRef is this
//   project?       keep only conversations whose projectName is this
// Answers { groups: [{ label, conversations }], shown, total, participants, projects } (participants and projects are
// every one named across all the conversations given, sorted, for the screen's filters).
// Refused: conversations that is not a list, or a row missing recordId, sessionId, participantRef or a readable
// lastActivityAt.
import { extractUniqueParticipants, extractUniqueProjects, filterSessions, groupByDate, sortByActivity } from './build-chat-conversation-list.ts';

const NAMED = ['recordId', 'sessionId', 'participantRef'];

export function listConversations({ conversations, search = '', participant = null, project = null } = {}) {
  if (!Array.isArray(conversations)) throw new Error('Give conversations: a list of { recordId, sessionId, participantRef, lastActivityAt, title?, projectSlug?, projectName? }.');
  const rows = conversations.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Conversation ${index} is not an object; give { recordId, sessionId, participantRef, lastActivityAt }.`);
    for (const field of NAMED) if (typeof row[field] !== 'string' || !row[field]) throw new Error(`Conversation ${index} needs ${field}: a non-empty string.`);
    if (typeof row.lastActivityAt !== 'string' || Number.isNaN(new Date(row.lastActivityAt).getTime())) throw new Error(`Conversation ${index} needs lastActivityAt: an ISO date such as 2026-01-05T09:00:00Z.`);
    return { title: null, projectSlug: '', projectName: null, ...row };
  });
  if (typeof search !== 'string') throw new Error('search is words: a string.');
  const shown = filterSessions(sortByActivity(rows), { search, participantRef: participant || null, projectName: project || null });
  return {
    groups: groupByDate(shown).map(({ label, sessions }) => ({ label, conversations: sessions })),
    shown: shown.length,
    total: rows.length,
    participants: extractUniqueParticipants(rows),
    projects: extractUniqueProjects(rows),
  };
}

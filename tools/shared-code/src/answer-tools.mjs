// src/answer-tools.mjs
//
// PURPOSE
//   What the answer engine is fed and corrected with, as MCP tools over the person's lists (src/lists.mjs routes):
//   - content an app or a Marketplace tool sends in under a root a person made, keyed by (root, id): index_content puts
//     or replaces items, remove_indexed_content takes them out, read_indexed_content lists a root's items or the roots,
//     save_content_root / remove_content_root make and remove a root (with its items). Search answers from them through
//     the `indexed-content` lane (src/search.json), each answer citing the item with its url and when it last changed.
//   - an answer someone says was wrong or missing becomes an owned work card: report_answer files it, change_answer_report
//     assigns, rates, solves (with the corrected answer), dismisses or reopens it, comment_on_answer_report and
//     change_answer_comment keep the conversation about it, remove_answer_report deletes it, read_answer_reports reads
//     the queue or one report with its comments. A solved report's corrected answer is a source the next answer cites
//     (the `corrected-answers` lane), so the fix reaches the next person who asks.
//   The lists, their fields, views, statuses and words are DATA (src/answer-lists.json); these tools hold no store of their
//   own and every write goes through the list routes, so the lists owner checks rights, values, links and limits.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An item's row id is derived from (root, id) by BLAKE3, so sending the same item again changes the one row it has,
//      from any app, and removing it by (root, id) removes exactly that row.
//   2. Content goes only into a root that exists: the content list's root link requires its target (the lists owner
//      refuses otherwise); a root is removed only after its items, a page at a time, each call saying whether it finished.
//   3. A report moves into a status only with the fields that status requires (answer-lists.json `statuses`), given in
//      the same call or already held; the date a status stamps is written in the same row write, and leaving it clears it.
//   4. Lists are made once, on first use, by the lists owner's ensure (one point read once they exist); nothing here
//      writes a list definition again.
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import data from './answer-lists.json' with { type: 'json' };
import listData from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };

const { content, reports, words } = data;
const most = listData.limits.rows_per_write;
const textChars = listData.limits.text_chars;
const said = (key, values = {}) => Object.assign(new Error(words[key].replace(/\{(\w+)\}/g, (whole, name) => values[name] ?? whole)), { status: 400 });
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const path = (list, rest = '') => `/lists/${encodeURIComponent(list.id)}${rest}`;
const ensure = (call, list) => call(path(list, '/ensure'), list);
const ensureReports = async call => { await ensure(call, reports.assignees); return ensure(call, reports.list); };
const now = () => new Date().toISOString();
// A read never makes a list: one that was never made (nothing was ever sent or reported) answers as made: false with no
// rows, checked against the person's lists, so a failed read is never shown as an empty one.
const readOrNone = async (call, list, address) => {
  try { return await call(address); } catch (error) {
    const kept = await call('/lists');
    if ((kept.lists ?? []).some(one => one.id === list.id)) throw error;
    return { list_id: list.id, made: false, rows: [], page: { complete: true, next_cursor: null } };
  }
};

/** The row id an item keyed by (root, id) is kept under (invariant 1). */
export const contentRowId = (root, id) => `${content.row_id_prefix}${bytesToHex(blake3(utf8ToBytes(JSON.stringify([root, id])))).slice(0, content.row_id_hex)}`;

const rootOf = root => {
  if (!nonempty(root) || root.includes('/') || root.length > 200) throw said('no_root', { most });
  return root;
};
const itemValues = (root, item, index) => {
  if (!isObject(item) || !nonempty(item.id) || item.id.length > 200 || !nonempty(item.title) || (item.text !== undefined && item.text !== null && typeof item.text !== 'string')
    || String(item.text ?? '').length > textChars || (item.url !== undefined && item.url !== null && typeof item.url !== 'string')) throw said('bad_item', { index, chars: textChars });
  return {
    root: [root], item_id: item.id, title: item.title.trim(), text: item.text ?? null, url: item.url ?? null,
    // When the item last changed where it lives; when the sender does not say, when it was sent.
    updated_at: typeof item.updated_at === 'string' && Number.isFinite(Date.parse(item.updated_at)) ? new Date(Date.parse(item.updated_at)).toISOString() : now(),
  };
};

const statusOf = id => reports.statuses.find(status => status.id === id);
const reportRow = async (call, reportId) => {
  if (!nonempty(reportId)) throw said('no_report', { report_id: String(reportId) });
  const read = await readOrNone(call, reports.list, `${path(reports.list)}?row_ids=${encodeURIComponent(JSON.stringify([reportId]))}`);
  const found = read.rows?.find(row => row.id === reportId);
  if (!found) throw said('no_report', { report_id: reportId });
  return found;
};

/**
 * The values a report change writes: the given fields, and a status's stamp and clears (invariant 3). `held` is the
 * report's current values.
 */
export function reportChange(input, held = {}) {
  const values = {};
  for (const key of ['assignee', 'corrected_answer', 'question', 'answer_given']) if (Object.hasOwn(input, key)) values[key] = input[key];
  if (Object.hasOwn(input, 'rating')) {
    const { min, max } = reports.rating;
    if (input.rating !== null && !(Number.isInteger(input.rating) && input.rating >= min && input.rating <= max)) throw said('bad_rating', { min, max });
    values.rating = input.rating;
  }
  // Naming an assignee on an open report gives it to them.
  let statusId = input.status ?? (nonempty(input.assignee) && (held.status ?? 'open') === 'open' ? reports.assigned_status : undefined);
  if (statusId !== undefined) {
    const status = statusOf(statusId);
    if (!status) throw said('bad_status', { statuses: reports.statuses.map(row => row.id).join(', ') });
    const missing = (status.requires ?? []).filter(field => !nonempty(String(values[field] ?? (Object.hasOwn(values, field) ? '' : held[field] ?? ''))));
    if (missing.length) throw said('needs', { status: status.id, fields: missing.join(', ') });
    values.status = status.id;
    if (status.stamps && held.status !== status.id) values[status.stamps] = now();
    for (const field of status.clears ?? []) values[field] = null;
  }
  return values;
}

const page = (limit, cursor) => ({ ...(limit !== undefined ? { limit: String(limit) } : {}), ...(cursor !== undefined ? { cursor } : {}) });
const query = params => {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined);
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};

const string = { type: 'string' };
const pageInput = { limit: { type: 'integer', minimum: 1, description: 'Return a bounded page; the list owner caps it' }, cursor: { type: 'string', description: 'The page.next_cursor a previous read answered' } };

export const answerTools = call => [
  { name: 'save_content_root', description: 'Makes or renames a root: a place an app or a Marketplace tool sends content into so Trillion\'s answers can cite it (index_content). root is a short id of your choosing (no slash); title is its name; about says what it holds.', inputSchema: { type: 'object', required: ['root', 'title'], properties: { root: string, title: string, about: string } },
    run: async ({ root, title, about }) => {
      await ensure(call, content.roots);
      return call(path(content.roots, '/rows'), { rows: [{ id: rootOf(root), values: { title, ...(about === undefined ? {} : { about }) } }] });
    } },
  { name: 'index_content', description: `Sends content into a root (save_content_root) so search and Trillion's answers can find and cite it, like the person's own notes. Each item is { id (its id where it came from), title, text, url (where it lives), updated_at (when it last changed there) }; at most ${most} items. Sending an item with the same root and id again replaces it. Answers that cite it carry its url and at (when it last changed).`, inputSchema: { type: 'object', required: ['root', 'items'], properties: { root: string, items: { type: 'array', minItems: 1, maxItems: most, items: { type: 'object', required: ['id', 'title'], properties: { id: string, title: string, text: { type: ['string', 'null'] }, url: { type: ['string', 'null'] }, updated_at: string } } } } },
    run: async ({ root, items }) => {
      rootOf(root);
      if (!Array.isArray(items) || !items.length || items.length > most) throw said('no_root', { most });
      const rows = items.map((item, index) => ({ id: contentRowId(root, item?.id), values: itemValues(root, item, index) }));
      await ensure(call, content.list);
      const answer = await call(path(content.list, '/rows'), { rows });
      return { root, kept: items.map((item, index) => ({ id: item.id, row_id: rows[index].id })), ...(answer.settled ? { settled: answer.settled } : {}) };
    } },
  { name: 'remove_indexed_content', description: `Takes items out of a root by their ids (at most ${most}), so answers stop citing them.`, inputSchema: { type: 'object', required: ['root', 'ids'], properties: { root: string, ids: { type: 'array', minItems: 1, maxItems: most, items: string } } },
    run: async ({ root, ids }) => {
      rootOf(root);
      if (!Array.isArray(ids) || !ids.length || ids.length > most || !ids.every(nonempty)) throw said('no_root', { most });
      await ensure(call, content.list);
      const answer = await call(path(content.list, '/rows'), { remove: ids.map(id => contentRowId(root, id)) });
      return { root, removed: answer.removed ?? [] };
    } },
  { name: 'read_indexed_content', description: 'Without root, the roots content is sent into. With root, that root\'s items a page at a time (each with its id, title, url and when it last changed); continue with page.next_cursor until page.complete.', inputSchema: { type: 'object', properties: { root: string, ...pageInput } },
    run: async ({ root, limit, cursor } = {}) => {
      if (root === undefined) return readOrNone(call, content.roots, `${path(content.roots)}${query(page(limit, cursor))}`);
      return readOrNone(call, content.list, `${path(content.list, `/views/${content.list.views[0].id}`)}${query({ parameters: JSON.stringify({ root: rootOf(root) }), ...page(limit, cursor) })}`);
    } },
  { name: 'remove_content_root', description: 'Removes a root and every item sent into it. A root with many items is emptied a page at a time: while the answer says complete false, call again.', inputSchema: { type: 'object', required: ['root'], properties: { root: string } },
    run: async ({ root }) => {
      rootOf(root);
      await ensure(call, content.list);
      const items = await call(`${path(content.list, `/views/${content.list.views[0].id}`)}${query({ parameters: JSON.stringify({ root }), limit: String(most) })}`);
      const ids = (items.rows ?? []).map(row => row.id);
      if (ids.length) await call(path(content.list, '/rows'), { remove: ids });
      if (ids.length === most || items.page?.complete === false) return { root, removed_items: ids.length, complete: false };
      await ensure(call, content.roots);
      const answer = await call(path(content.roots, '/rows'), { remove: [root] });
      return { root, removed_items: ids.length, removed: answer.removed ?? [], complete: true };
    } },
  { name: 'report_answer', description: `Reports an answer from search or Trillion that was wrong or missing, so someone fixes it: it becomes a card on the "${reports.list.label}" list with an assignee, a rating and a status. Give the question, issue (${reports.list.fields.find(field => field.id === 'issue').choices.join(', ')}), and when you have them the answer given and the sources it cited. Once someone solves it with the corrected answer, later answers cite that.`, inputSchema: { type: 'object', required: ['question', 'issue'], properties: { question: string, issue: { type: 'string', enum: reports.list.fields.find(field => field.id === 'issue').choices }, answer_given: string, sources_cited: { type: 'array', items: string, maxItems: 20 }, assignee: string, rating: { type: 'integer' } } },
    run: async input => {
      const issues = reports.list.fields.find(field => field.id === 'issue').choices;
      if (!isObject(input) || !nonempty(input.question) || !issues.includes(input.issue)) throw said('bad_report', { issues: issues.join(', ') });
      const values = { question: input.question.trim(), issue: input.issue, reported_at: now(),
        ...(input.answer_given === undefined ? {} : { answer_given: input.answer_given }), ...(input.sources_cited === undefined ? {} : { sources_cited: input.sources_cited }),
        ...reportChange(input, { status: 'open' }) };
      await ensureReports(call);
      const answer = await call(path(reports.list, '/rows'), { rows: [{ values }] });
      return { report_id: answer.kept?.[0]?.id ?? null, report: answer.kept?.[0] ?? null };
    } },
  { name: 'change_answer_report', description: `Works on one answer report (report_id from read_answer_reports): assignee gives it to someone, rating says how bad it is (${reports.rating.min} to ${reports.rating.max}), status moves it (${reports.statuses.map(status => status.id).join(', ')}); solved needs corrected_answer, which later answers then cite. question and answer_given can be corrected too.`, inputSchema: { type: 'object', required: ['report_id'], properties: { report_id: string, assignee: { type: ['string', 'null'] }, rating: { type: ['integer', 'null'] }, status: { type: 'string', enum: reports.statuses.map(status => status.id) }, corrected_answer: { type: ['string', 'null'] }, question: string, answer_given: { type: ['string', 'null'] } } },
    run: async input => {
      await ensureReports(call);
      const held = await reportRow(call, input?.report_id);
      const values = reportChange(input, held.values ?? {});
      return call(path(reports.list, '/rows'), { rows: [{ id: held.id, values }] });
    } },
  { name: 'remove_answer_report', description: 'Deletes one answer report and its comments (to close one without deleting it, change_answer_report with status dismissed).', inputSchema: { type: 'object', required: ['report_id'], properties: { report_id: string } },
    run: async ({ report_id: reportId }) => {
      await ensureReports(call);
      const held = await reportRow(call, reportId);
      await ensure(call, reports.comments);
      const linked = await call(`${path(reports.list, '/backlinks')}${query({ row_id: held.id })}`);
      const comments = (linked.backlinks ?? []).filter(link => link.list_id === reports.comments.id).map(link => link.row_id);
      for (let at = 0; at < comments.length; at += most) await call(path(reports.comments, '/rows'), { remove: comments.slice(at, at + most) });
      const answer = await call(path(reports.list, '/rows'), { remove: [held.id] });
      return { removed: answer.removed ?? [], comments_removed: comments.length };
    } },
  { name: 'comment_on_answer_report', description: 'Adds a comment to one answer report.', inputSchema: { type: 'object', required: ['report_id', 'text'], properties: { report_id: string, text: string } },
    run: async ({ report_id: reportId, text } = {}) => {
      if (!nonempty(text)) throw said('bad_comment');
      await ensureReports(call);
      const held = await reportRow(call, reportId);
      await ensure(call, reports.comments);
      const answer = await call(path(reports.comments, '/rows'), { rows: [{ values: { report: [held.id], text, said_at: now() } }] });
      return { comment_id: answer.kept?.[0]?.id ?? null, comment: answer.kept?.[0] ?? null };
    } },
  { name: 'change_answer_comment', description: 'Changes the text of one comment on an answer report, or removes it with text null.', inputSchema: { type: 'object', required: ['comment_id', 'text'], properties: { comment_id: string, text: { type: ['string', 'null'] } } },
    run: async ({ comment_id: commentId, text }) => {
      if (!nonempty(commentId) || (text !== null && !nonempty(text))) throw said('bad_comment');
      await ensure(call, reports.comments);
      return call(path(reports.comments, '/rows'), text === null ? { remove: [commentId] } : { rows: [{ id: commentId, values: { text }, if_values: {} }] });
    } },
  { name: 'read_answer_reports', description: `The answers to fix. With report_id, that report with its comments. Otherwise view (${reports.list.views.map(view => view.id).join(', ')}, or all; open when left out), with assignee for assigned-to, a page at a time.`, inputSchema: { type: 'object', properties: { report_id: string, view: string, assignee: string, ...pageInput } },
    run: async ({ report_id: reportId, view = 'open', assignee, limit, cursor } = {}) => {
      if (reportId !== undefined) {
        const held = await reportRow(call, reportId);
        const linked = await call(`${path(reports.list, '/backlinks')}${query({ row_id: held.id })}`);
        const ids = (linked.backlinks ?? []).filter(link => link.list_id === reports.comments.id).map(link => link.row_id);
        const comments = ids.length ? (await readOrNone(call, reports.comments, `${path(reports.comments)}${query({ row_ids: JSON.stringify(ids) })}`)).rows : [];
        return { report: held, comments: comments.sort((a, b) => String(a.values?.said_at ?? '').localeCompare(String(b.values?.said_at ?? ''))), comments_complete: linked.complete !== false };
      }
      if (view === 'all') return readOrNone(call, reports.list, `${path(reports.list)}${query(page(limit, cursor))}`);
      return readOrNone(call, reports.list, `${path(reports.list, `/views/${encodeURIComponent(view)}`)}${query({ ...(assignee === undefined ? {} : { parameters: JSON.stringify({ assignee }) }), ...page(limit, cursor) })}`);
    } },
];

const writeHint = (title, more = {}) => ({ title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...more });
export const answerAnnotations = {
  save_content_root: writeHint('Make a place content is sent into', { idempotentHint: true }),
  index_content: writeHint('Send content in for answers', { idempotentHint: true }),
  remove_indexed_content: writeHint('Take sent content out', { destructiveHint: true, idempotentHint: true }),
  read_indexed_content: { title: 'Read content sent in for answers', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  remove_content_root: writeHint('Remove a place and its content', { destructiveHint: true, idempotentHint: true }),
  report_answer: writeHint('Report a wrong or missing answer'),
  change_answer_report: writeHint('Work on an answer to fix', { idempotentHint: true }),
  remove_answer_report: writeHint('Delete an answer to fix', { destructiveHint: true, idempotentHint: true }),
  comment_on_answer_report: writeHint('Comment on an answer to fix'),
  change_answer_comment: writeHint('Change or remove a comment', { destructiveHint: true, idempotentHint: true }),
  read_answer_reports: { title: 'Read answers to fix', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

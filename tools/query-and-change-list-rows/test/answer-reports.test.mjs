// Ported from old trillion test/answer-reports.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The reports are tools/shared-code/src/answer-tools.mjs over the list routes
// (tools/keep-lists-of-rows/lists.mjs) and the list tools here; test/answer-person-for-tests.mjs is the old person without
// search. The checks that the next search cites a solved report as a "Corrected answer" and drops it when reopened are left
// out: old src/search.mjs has no JavaScript home, and the engine's search (trillion-rust src/record_value/search.rs) names no
// lane per kind ("Lanes named in data per record type ... dropped"), so no running code answers that lane.
// Answers to fix (src/answer-tools.mjs over src/lists.mjs, read by src/search.mjs): a wrong or missing answer becomes a
// card with an assignee, a rating, comments and a status; solving it needs the corrected answer, which search then
// cites; dismissing or reopening it takes the fix back out; the queue reads through saved views; deleting a report
// deletes its comments. Runs against the real record store, list routes, rule evaluator and search.
import test from 'node:test';
import assert from 'node:assert/strict';
import { person } from './answer-person-for-tests.mjs';
import { reportChange } from '../../shared-code/src/answer-tools.mjs';

test('a reported answer is assigned, discussed, rated and solved', async () => {
  const { tools } = person();
  const { report_id: id } = await tools.report_answer({ question: 'What is our refund window?', issue: 'wrong', answer_given: 'Thirty days.', sources_cited: ['record:message:old-policy'] });
  assert.ok(id);
  const open = await tools.read_answer_reports({});
  assert.deepEqual(open.rows.map(row => [row.id, row.values.status]), [[id, 'open']], 'a new report waits in the open view');

  await tools.change_answer_report({ report_id: id, assignee: 'Ana' });
  const mine = await tools.read_answer_reports({ view: 'assigned-to', assignee: 'Ana' });
  assert.deepEqual(mine.rows.map(row => [row.id, row.values.status, row.values.assignee]), [[id, 'assigned', 'Ana']], 'naming an assignee gives it to them');
  const { comment_id: commentId } = await tools.comment_on_answer_report({ report_id: id, text: 'Policy changed in September.' });
  await tools.comment_on_answer_report({ report_id: id, text: 'Checking with finance.' });
  await tools.change_answer_comment({ comment_id: commentId, text: 'Policy changed on 2026-09-01.' });
  await tools.change_answer_report({ report_id: id, rating: 4 });
  await assert.rejects(tools.change_answer_report({ report_id: id, rating: 9 }), /whole number from 1 to 5/);
  await assert.rejects(tools.change_answer_report({ report_id: id, status: 'solved' }), /solved only with corrected_answer/, 'solving needs the corrected answer');

  await tools.change_answer_report({ report_id: id, status: 'solved', corrected_answer: 'Refunds are accepted within 14 days of delivery.' });
  const one = await tools.read_answer_reports({ report_id: id });
  assert.deepEqual([one.report.values.status, one.report.values.rating, one.report.values.assignee], ['solved', 4, 'Ana']);
  assert.match(one.report.values.solved_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(one.comments.map(comment => comment.values.text), ['Policy changed on 2026-09-01.', 'Checking with finance.']);
  assert.equal(one.report.values._stamps?.status?.by, 'Claude', 'who wrote each field is kept (list stamps)');

  assert.deepEqual((await tools.read_answer_reports({ view: 'solved' })).rows.map(row => row.id), [id]);

  // Reopening takes the fix out of answers until it is solved again, and clears the date it was solved.
  await tools.change_answer_report({ report_id: id, status: 'open' });
  assert.equal((await tools.read_answer_reports({ report_id: id })).report.values.solved_at, undefined);
});

test('a report can be dismissed or deleted with its comments; unknown reports and bad input are refused', async () => {
  const { tools, lists } = person();
  await assert.rejects(tools.report_answer({ question: 'Where?', issue: 'odd' }), /what was wrong with its answer/);
  const { report_id: id } = await tools.report_answer({ question: 'Who owns billing?', issue: 'missing' });
  await tools.change_answer_report({ report_id: id, status: 'dismissed' });
  assert.equal((await tools.read_answer_reports({})).rows.length, 0, 'a dismissed report leaves the open view');
  assert.deepEqual((await tools.read_answer_reports({ view: 'all' })).rows.map(row => row.values.status), ['dismissed']);
  await tools.comment_on_answer_report({ report_id: id, text: 'Not ours.' });
  const gone = await tools.remove_answer_report({ report_id: id });
  assert.deepEqual([gone.removed.length, gone.comments_removed], [1, 1]);
  assert.equal((await lists.read('answer-report-comments')).rows.length, 0);
  await assert.rejects(tools.change_answer_report({ report_id: id, rating: 2 }), /no answer report/);
  await assert.rejects(tools.comment_on_answer_report({ report_id: 'nope', text: 'x' }), /no answer report/);
});

test('status rules are DATA: requires, stamps and clears', () => {
  assert.throws(() => reportChange({ status: 'assigned' }, { status: 'open' }), /assigned only with assignee/);
  assert.deepEqual(Object.keys(reportChange({ status: 'solved' }, { status: 'assigned', corrected_answer: 'kept' })).sort(), ['solved_at', 'status']);
  assert.deepEqual(reportChange({ status: 'solved' }, { status: 'solved', corrected_answer: 'kept' }), { status: 'solved' }, 'an already solved report keeps its date');
  assert.deepEqual(reportChange({ status: 'dismissed' }, {}), { status: 'dismissed', solved_at: null });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { measureCitationCoverage } from '../read-data/citation-coverage.mjs';

const plan = {
  pages: [{ url: 'https://example.com/a', canonical_url: 'https://example.com/articles/a', verified_redirects: ['https://old.example.com/a'] }],
  questions: ['What is A?', 'How does A work?'],
  engines: ['engine-one', 'engine-two'],
};

test('reports each page × question × engine cell, with exact verified page citations and original context', () => {
  const measured = measureCitationCoverage({ ...plan, observations: [
    { page_url: plan.pages[0].url, question: plan.questions[0], engine: 'engine-one', status: 'observed', observed_at: '2026-10-31T18:00:00-06:00', locale: 'en-US', mode: 'web', source: 'browser-read', answer: 'A is useful.', citations: ['https://example.com/articles/a#details'] },
    { page_url: plan.pages[0].url, question: plan.questions[0], engine: 'engine-two', status: 'observed', observed_at: '2026-10-31T18:01:00-06:00', locale: 'en-US', mode: 'web', source: 'browser-read', answer: 'No link cited.', citations: ['https://example.com/another-page'] },
    { page_url: plan.pages[0].url, question: plan.questions[1], engine: 'engine-one', status: 'unavailable', reason: 'Sign-in required', locale: 'en-US', mode: 'web', source: 'browser-read' },
  ] });
  assert.deepEqual(measured.planned, { pages: 1, questions: 2, engines: 2, cells: 4 });
  assert.equal(measured.measured, 2);
  assert.equal(measured.cited, 1);
  assert.equal(measured.not_cited, 1);
  assert.equal(measured.unknown, 2);
  assert.equal(measured.citation_rate, 0.5);
  assert.equal(measured.cells[0].citations[0], 'https://example.com/articles/a#details');
  assert.equal(measured.cells[0].cell_id, JSON.stringify([plan.pages[0].url, plan.questions[0], 'engine-one']));
  assert.equal(measured.cells[0].observed_at, '2026-10-31T18:00:00-06:00');
  assert.equal(measured.cells[2].citation, null);
  assert.equal(measured.cells[2].status, 'unavailable');
  assert.equal(measured.cells[3].status, 'not-run');
});

test('does not mistake a string prefix or a different path for an exact page citation', () => {
  const measured = measureCitationCoverage({ pages: [{ url: 'https://example.com/a' }], questions: ['Q'], engines: ['E'], observations: [
    { page_url: 'https://example.com/a', question: 'Q', engine: 'E', status: 'observed', observed_at: '2026-10-31', answer: 'A', citations: ['https://example.com/another-a', 'https://example.com/a/child'] },
  ] });
  assert.equal(measured.cells[0].citation, false);
});

test('accepts only checked canonical and redirect identities while preserving query strings', () => {
  const base = { pages: plan.pages, questions: ['Q'], engines: ['E'] };
  const observe = citation => measureCitationCoverage({ ...base, observations: [
    { page_url: plan.pages[0].url, question: 'Q', engine: 'E', status: 'observed', observed_at: '2026-10-31', answer: 'A', citations: [citation] },
  ] }).cells[0].citation;
  assert.equal(observe('https://old.example.com/a#fragment'), true);
  assert.equal(observe('https://example.com/articles/a?ref=x'), false);
});

test('supports each page’s own planned questions without inventing cross-page cells', () => {
  const measured = measureCitationCoverage({
    pages: [{ url: 'https://example.com/a', questions: ['A?'] }, { url: 'https://example.com/b', questions: ['B?'] }],
    engines: ['E'],
  });
  assert.equal(measured.planned.cells, 2);
  assert.equal(measured.planned.questions, 2);
  assert.deepEqual(measured.cells.map(cell => [cell.page_url, cell.question]), [['https://example.com/a', 'A?'], ['https://example.com/b', 'B?']]);
});

test('unavailable and missing answers remain unknown rather than zero citations', () => {
  const measured = measureCitationCoverage({ pages: [{ url: 'https://example.com/' }], questions: ['Q'], engines: ['E'], observations: [
    { page_url: 'https://example.com/', question: 'Q', engine: 'E', status: 'unavailable', reason: 'timeout' },
  ] });
  assert.equal(measured.citation_rate, null);
  assert.equal(measured.unknown, 1);
});

test('rejects duplicate and out-of-plan observations rather than inflating coverage', () => {
  const observation = { page_url: plan.pages[0].url, question: plan.questions[0], engine: 'engine-one', status: 'not-run' };
  assert.throws(() => measureCitationCoverage({ ...plan, observations: [observation, observation] }), /Duplicate observation/);
  assert.throws(() => measureCitationCoverage({ ...plan, observations: [{ ...observation, engine: 'unplanned' }] }), /outside the planned matrix/);
  assert.throws(() => measureCitationCoverage({ pages: [plan.pages[0], { url: 'https://old.example.com/a' }], questions: ['Q'], engines: ['E'] }), /belongs to more than one planned page/);
});

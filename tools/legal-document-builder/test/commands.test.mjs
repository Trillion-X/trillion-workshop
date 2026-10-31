// tools/legal-document-builder: the two commands the rows run, over made-up facts and a made-up contract. The package
// had no test of write-legal-documents.mjs's own refusals or of its answer's shape; these are new.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeLegalDocuments } from '../do-work/write-legal-documents.mjs';
import { makeSalesContract } from '../do-work/make-a-sales-contract.mjs';

const command = name => fileURLToPath(new URL(`../do-work/${name}`, import.meta.url));
// write-legal-documents takes its input as the one argument; make-a-sales-contract takes it on standard input.
const run = (name, input, how = 'stdin') => {
  const done = how === 'argv'
    ? spawnSync('node', [command(name), JSON.stringify(input)], { encoding: 'utf8' })
    : spawnSync('node', [command(name)], { input: JSON.stringify(input), encoding: 'utf8' });
  return { status: done.status, answer: JSON.parse(done.stdout.trim().split('\n').at(-1)) };
};
const stderrOf = (name, input) => spawnSync('node', [command(name), JSON.stringify(input)], { encoding: 'utf8' });

const facts = {
  business_legal_name: 'Harbor Coaching LLC', service_name: 'Harbor Coaching', site_url: 'https://harbor.example',
  contact_email: 'help@harbor.example', service_description: 'One-to-one swim coaching sessions booked online.',
  has_accounts: true, has_paid_offers: true,
};
const contract = {
  id: 'contract-9', name: 'Swim Coaching Agreement', currency: 'usd', total_amount: 48000, rules: [{ type: 'Commitment', amount: 48000, recurrence: 'one_time' }],
};

test('write-legal-documents gives each asked document its text, BLAKE3 identity, clauses, readiness and what it still needs', () => {
  const answer = writeLegalDocuments({ documents: ['terms', 'privacy'], facts, addresses: { terms: '/legal/terms' } });
  assert.deepEqual(answer.documents.map(document => document.document_type), ['terms', 'privacy']);
  const [terms] = answer.documents;
  assert.ok(terms.text.includes('Harbor Coaching LLC'));
  assert.match(terms.identity, /^1f:[0-9a-f]{64}$/);
  assert.equal(terms.address, '/legal/terms');
  assert.equal(terms.ready_to_publish, false);
  assert.equal(terms.lawyer_review_needed, true);
  assert.ok(terms.clauses.includes('terms.accounts'));
  assert.ok(!terms.clauses.includes('terms.ai-outputs'));
  assert.ok(answer.facts_it_reads.terms.fills.includes('governing_law_state'));
  assert.ok(answer.facts_it_reads.terms.decides_which_clauses.includes('uses_ai'));
  assert.match(answer.note, /not legal advice/);
});

test('a document is ready to publish only once a lawyer has reviewed it, no fact is to be confirmed and none is missing', () => {
  const all = { ...facts, governing_law_state: 'the State of Maine', venue: 'Cumberland County, Maine', pricing_surface_url: 'https://harbor.example/pricing', refund_policy_url: 'https://harbor.example/refunds', data_export_statement: 'On request we send you a copy of your sessions.', notice_channel: 'email' };
  const open = writeLegalDocuments({ documents: ['terms'], facts: all });
  assert.deepEqual(open.documents[0].missing_facts, []);
  assert.equal(open.documents[0].ready_to_publish, false);
  assert.equal(writeLegalDocuments({ documents: ['terms'], facts: all, reviewed_by_a_lawyer: true }).documents[0].ready_to_publish, true);
  const unconfirmed = writeLegalDocuments({ documents: ['terms'], reviewed_by_a_lawyer: true, facts: { ...all, contact_email: { value: 'help@harbor.example', needs_founder_verification: 'confirm the inbox is watched' } } });
  assert.equal(unconfirmed.documents[0].ready_to_publish, false);
  assert.deepEqual(unconfirmed.documents[0].facts_to_confirm, ['contact_email']);
  const lacking = writeLegalDocuments({ documents: ['terms'], reviewed_by_a_lawyer: true, facts });
  assert.ok(lacking.documents[0].missing_facts.includes('governing_law_state'));
  assert.equal(lacking.documents[0].ready_to_publish, false);
});

test('write-legal-documents prints one JSON line for its argument and refuses an unknown document on standard error', () => {
  const asked = run('write-legal-documents.mjs', { documents: ['terms'], facts }, 'argv');
  assert.equal(asked.status, 0);
  assert.equal(asked.answer.documents[0].document_type, 'terms');
  const unknown = stderrOf('write-legal-documents.mjs', { documents: ['lease'], facts });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Not known: lease/);
  assert.throws(() => writeLegalDocuments({ documents: [], facts }), /documents must list some of/);
  assert.throws(() => writeLegalDocuments({ documents: ['terms'], facts: [] }), /facts must be an object/);
  assert.throws(() => writeLegalDocuments(null), /must be an object/);
});

test('make-a-sales-contract answers with what to accept, the terms rows, the file request and the forms asked for', () => {
  const answer = makeSalesContract({ contract, formats: ['pdf', 'md'], created_at: '2030-03-04T05:06:07.000Z' });
  assert.deepEqual(answer.acceptance_requirements, ['I understand the contract terms.', 'I understand the payment obligation.']);
  assert.deepEqual(answer.output_forms.map(form => form.extension), ['md', 'pdf']);
  assert.deepEqual(answer.file_request.formats, ['markdown', 'pdf']);
  assert.equal(answer.file_request.requestId, 'approval_contract-9:files');
  assert.equal(answer.file_request.fileStem, 'swim-coaching-agreement');
  assert.deepEqual(answer.terms_rows, answer.file_request.sections[0].rows);
  assert.ok(answer.terms_rows.some(row => row[0] === 'Total' && row[1] === 'USD 480.00'));
  assert.equal('approval_link' in answer, false);
});

test('make-a-sales-contract makes the approval link only for a base address, over standard input', () => {
  const done = run('make-a-sales-contract.mjs', { contract, base_url: 'https://deals.example', actor_id: 'person-3', request_id: 'approval_x' });
  assert.equal(done.status, 0);
  assert.ok(done.answer.result.approval_link.startsWith('https://deals.example/contracts/approve/approval_x?request='));
  assert.equal(done.answer.result.output_forms.length, 5);
});

test('make-a-sales-contract refuses a contract without rules, a form that is not listed and no forms', () => {
  assert.throws(() => makeSalesContract({ contract: { name: 'No rules' } }), /rules list/);
  assert.throws(() => makeSalesContract({ contract, formats: ['odt'] }), /formats not known: odt/);
  assert.throws(() => makeSalesContract({ contract, formats: [] }), /formats must list/);
  assert.throws(() => makeSalesContract({ contract, created_at: 'never' }), /created_at/);
  assert.equal(run('make-a-sales-contract.mjs', {}).status, 1);
});

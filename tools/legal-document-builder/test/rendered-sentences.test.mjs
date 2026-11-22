// tools/legal-document-builder: a rendered document reads as written prose. Slot values are bare phrases and each
// clause owns the words around them, so no rendered sentence may repeat a word in a row, end in a doubled period,
// or keep a missing-fact marker. Made-up facts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeLegalDocuments } from '../do-work/write-legal-documents.mjs';

const facts = {
  business_legal_name: 'Harbor Coaching LLC', service_name: 'Harbor Coaching', site_url: 'https://harbor.example',
  contact_email: 'user-a4af8001@example.com', service_description: 'Coaching for swimmers, billed monthly.',
  has_paid_offers: true, has_subscriptions: true, uses_ai: true,
  pricing_surface_url: 'https://harbor.example/pricing', refund_policy_url: 'https://harbor.example/refunds',
  cancel_method: 'replying cancel to any email from us, or using the booking page',
  refund_statement: 'No refund is given for a month that has already started.',
  governing_law_state: 'the State of Alabama', venue: 'the state or federal courts located in Alabama',
  notice_channel: 'email to the address you gave at booking, or through the booking page',
  data_export_statement: 'On request, we send you your data in a common file format within 30 days.',
  data_categories_table: 'Name and email from booking. Booking times.',
  purposes_list: 'To run your booking and calls, and to bill the service.',
  subprocessors_table: 'TidyCal (booking). Stripe (payments).',
  ai_providers_statement: 'We use AI models to research and draft the work we deliver.',
  ai_training_statement: 'The AI providers get your information only to do the work, and do not train on it.',
  connected_accounts_statement: 'We connect AI tools to the accounts you grant us, only with your permission.',
  retention_statement: 'We keep billing records for seven years.', children_statement: 'The service is for adults.',
  dispute_contact: 'reply to your invoice email, write to user-a4af8001@example.com, or use the booking page',
  billing_descriptor: 'BITFIELD',
};

const documents = ['terms', 'privacy', 'refunds'];
const sentences = text => text.split(/(?<=[.!?])\s+/).filter(Boolean);

test('every rendered sentence of terms, privacy and refunds is clean prose', () => {
  const answer = writeLegalDocuments({ documents, facts, reviewed_by_a_lawyer: false });
  for (const document of answer.documents) {
    assert.ok(!document.text.includes('[[MISSING'), `${document.document_type} still has a missing-fact marker`);
    for (const sentence of sentences(document.text)) {
      assert.ok(!/\.\./.test(sentence), `${document.document_type}: doubled period in "${sentence}"`);
      assert.ok(!/\b(\w+)\s+\1\b/i.test(sentence), `${document.document_type}: repeated word in "${sentence}"`);
    }
  }
});

test('a slot value is a bare phrase: the clause supplies the words around it', () => {
  const [refunds] = writeLegalDocuments({ documents: ['refunds'], facts }).documents;
  assert.ok(refunds.text.includes('Charges appear on your statement as BITFIELD.'));
  assert.ok(refunds.text.includes('If you believe a charge is wrong, reply to your invoice email'));
});

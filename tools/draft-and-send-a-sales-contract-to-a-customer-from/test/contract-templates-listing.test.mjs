import test from 'node:test';
import assert from 'node:assert/strict';
import { salesContractTemplatesFrom } from '../read-data/contract-templates-listing.mjs';

// Made-up template records for the test only; no real customer terms are shipped with this module.
const sample = () => ({
  payload: {
    id: 'sales-contract-template:sample-coaching',
    label: 'Sample coaching',
    summary: 'Two calls a month',
    known_terms: [{ id: 'coaching-calls', label: 'Coaching calls', source: 'offer:sample-coaching' }],
    fields_to_agree: ['start_date'],
    contract: {
      name: 'Sample coaching',
      included_usage: [{ service: 'Coaching call', quantity: 2, unit: 'call' }, { quantity: 1 }],
      access_grants: ['access:decision-method', 'access:sample-session'],
    },
  },
});

test('no template records gives no templates', () => {
  assert.deepEqual(salesContractTemplatesFrom(null), []);
  assert.deepEqual(salesContractTemplatesFrom([]), []);
});

test('each template becomes its id, name, summary, usage rules, access rules and kept terms', () => {
  const [template] = salesContractTemplatesFrom([sample()]);
  assert.equal(template.id, 'sales-contract-template:sample-coaching');
  assert.equal(template.name, 'Sample coaching');
  assert.equal(template.description, 'Two calls a month');
  assert.deepEqual(template.rules[0], { type: 'MeterUsage', label: 'Coaching call', resource: 'Coaching call', metric: 'call', pricing_rules: { per_unit_cents: 0, included_units: 2 } });
  assert.deepEqual(template.rules[1], { type: 'MeterUsage', label: 'Included usage 2', resource: 'service', metric: 'usage', pricing_rules: { per_unit_cents: 0, included_units: 1 } });
  assert.deepEqual(template.rules[2], { type: 'GrantAccess', label: 'decision method', resource: 'access:decision-method', condition: 'conditional' });
  assert.equal(template.rules.length, 4);
  assert.deepEqual(template.sourceTerms.known_terms, sample().payload.known_terms);
  assert.deepEqual(template.sourceTerms.fields_to_agree, ['start_date']);
});

test('the kept terms are copies, not the records themselves', () => {
  const record = sample();
  const [template] = salesContractTemplatesFrom([record]);
  template.sourceTerms.contract.name = 'changed';
  assert.equal(record.payload.contract.name, 'Sample coaching');
});

test('a record with no usage or access lists gets no rules', () => {
  const record = sample();
  record.payload.contract = { name: 'Bare' };
  assert.deepEqual(salesContractTemplatesFrom([record])[0].rules, []);
});

test('an invalid list of records is refused with the old status and code', () => {
  assert.throws(() => salesContractTemplatesFrom({}), { status: 503, code: 'sales_contract_templates_invalid', message: 'Sales contract templates need ordinary named terms and valid usage/access lists.' });
});

test('a record that is not valid is refused: no id, no name, duplicate id, bad quantity, bad access id', () => {
  const broken = [
    () => { const r = sample(); delete r.payload.id; return [r]; },
    () => { const r = sample(); r.payload.label = ''; return [r]; },
    () => [sample(), sample()],
    () => { const r = sample(); r.payload.contract.included_usage = [{ quantity: -1 }]; return [r]; },
    () => { const r = sample(); r.payload.contract.access_grants = ['']; return [r]; },
  ];
  for (const make of broken) assert.throws(() => salesContractTemplatesFrom(make()), { code: 'sales_contract_templates_invalid' });
});

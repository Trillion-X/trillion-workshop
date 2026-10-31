// Carried from bitfield-packages packages/legal-document-builder/__tests__/assemble-legal-documents.test.ts.
// Changed: vitest is the Workshop's shim; the clause library is read from data/policy-clause-library.json (the package kept
// it inside its boundary file); the business instances are three made-up businesses; and the "L101 parity" test, which
// compared with the hashes of documents live on the package set's own sites, now compares with the BLAKE3 identities of
// the made-up businesses' documents (fixtures/expected-document-identities.json), so a changed clause or fact still fails.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import {
  assembleDocumentsForBusiness,
  predicatePasses,
  type BusinessPolicyInstance,
  type PolicyClauseLibrary,
} from '../read-data/assemble-legal-documents.ts';

const here = dirname(fileURLToPath(import.meta.url));
const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const identityOf = (text: string) => makeHashCodeHexFromBytes(new TextEncoder().encode(text));

const library: PolicyClauseLibrary = JSON.parse(readFileSync(join(here, '..', 'data', 'policy-clause-library.json'), 'utf8'));
const instanceSet = JSON.parse(readFileSync(join(here, 'fixtures', 'business-policy-instances.json'), 'utf8'));
const expectedIdentities = JSON.parse(readFileSync(join(here, 'fixtures', 'expected-document-identities.json'), 'utf8'));

describe('predicatePasses', () => {
  const facts = { offers_pwyw: true, minimum_age: 13 };
  it('always passes', () => {
    expect(predicatePasses({ always: true }, facts)).toBe(true);
  });
  it('equals matches and rejects', () => {
    expect(predicatePasses({ when_field: 'offers_pwyw', equals: true }, facts)).toBe(true);
    expect(predicatePasses({ when_field: 'offers_pwyw', equals: false }, facts)).toBe(false);
  });
  it('gt compares numbers only', () => {
    expect(predicatePasses({ when_field: 'minimum_age', gt: 12 }, facts)).toBe(true);
    expect(predicatePasses({ when_field: 'minimum_age', gt: 13 }, facts)).toBe(false);
    expect(predicatePasses({ when_field: 'offers_pwyw', gt: 0 }, facts)).toBe(false);
  });
  it('missing field never passes a conditional predicate', () => {
    expect(predicatePasses({ when_field: 'nonexistent', equals: true }, facts)).toBe(false);
    expect(predicatePasses({ when_field: 'nonexistent', gt: 0 }, facts)).toBe(false);
  });
});

describe('slot fill + fail-closed gates', () => {
  const miniLibrary: PolicyClauseLibrary = {
    kind: 'policy-clause-library',
    clauses: [
      {
        clause_id: 'test-intro',
        document_type: 'terms',
        predicate: { always: true },
        body: ['{{business_legal_name}} provides service. Contact {{contact_email}}.'],
      },
      {
        clause_id: 'test-missing',
        document_type: 'terms',
        predicate: { always: true },
        body: ['Slot that does not exist: {{no_such_fact}}.'],
      },
    ],
  };
  const instance: BusinessPolicyInstance = {
    business_id: 'test-biz',
    partition: 'test',
    documents: ['terms'],
    urls: { terms: '/legal/terms' },
    business_facts: {
      business_legal_name: { value: 'Test LLC', needs_founder_verification: true },
      contact_email: 'help@test.example',
    },
  };

  it('fills slots, marks missing, propagates unverified, and stays customer_ready=false', () => {
    const [doc] = assembleDocumentsForBusiness(miniLibrary, instance, { customer_ready: true }, sha256Hex);
    expect(doc.text).toContain('Test LLC provides service. Contact help@test.example.');
    expect(doc.text).toContain('[[MISSING:no_such_fact]]');
    expect(doc.blocking.unverified_founder_fields).toEqual(['business_legal_name']);
    expect(doc.blocking.missing_fields).toEqual(['test-missing:no_such_fact']);
    expect(doc.customer_ready).toBe(false);
  });

  it('customer_ready true only when gate closed AND no unverified AND no missing', () => {
    const clean: BusinessPolicyInstance = {
      ...instance,
      business_facts: { business_legal_name: 'Test LLC', contact_email: 'help@test.example' },
    };
    const cleanLibrary: PolicyClauseLibrary = { kind: 'x', clauses: [miniLibrary.clauses[0]] };
    const [ready] = assembleDocumentsForBusiness(cleanLibrary, clean, { customer_ready: true }, sha256Hex);
    expect(ready.customer_ready).toBe(true);
    const [gated] = assembleDocumentsForBusiness(cleanLibrary, clean, { customer_ready: false }, sha256Hex);
    expect(gated.customer_ready).toBe(false);
  });

  it('throws when no clause matches a requested document type', () => {
    const none: BusinessPolicyInstance = { ...instance, documents: ['nonexistent-doc-type'] };
    expect(() => assembleDocumentsForBusiness(miniLibrary, none, { customer_ready: false }, sha256Hex))
      .toThrow(/no clauses matched/);
  });
});

describe('deletion test (L069): an unrelated business assembles with zero code change', () => {
  it('a plumbing company with a custom document type works from DATA alone', () => {
    const plumbing: PolicyClauseLibrary = {
      kind: 'policy-clause-library',
      clauses: [
        {
          clause_id: 'plumb-scope',
          document_type: 'service-agreement',
          predicate: { always: true },
          body: ['{{business_legal_name}} repairs pipes in {{service_city}}.'],
        },
        {
          clause_id: 'plumb-emergency',
          document_type: 'service-agreement',
          predicate: { when_field: 'offers_emergency', equals: true },
          body: ['Emergency callouts are available.'],
        },
      ],
    };
    const instance: BusinessPolicyInstance = {
      business_id: 'ace-plumbing',
      partition: 'ace-plumbing',
      documents: ['service-agreement'],
      urls: { 'service-agreement': '/legal/service-agreement' },
      document_titles: { 'service-agreement': 'Service Agreement' },
      business_facts: {
        business_legal_name: 'Ace Plumbing LLC',
        contact_email: 'ace@example.com',
        service_city: 'Springfield',
        offers_emergency: false,
      },
    };
    const [doc] = assembleDocumentsForBusiness(plumbing, instance, { customer_ready: true }, sha256Hex);
    expect(doc.title).toBe('Service Agreement');
    expect(doc.text).toContain('Ace Plumbing LLC repairs pipes in Springfield.');
    expect(doc.text).not.toContain('Emergency callouts');
    expect(doc.customer_ready).toBe(true);
  });
});

describe('identity parity: the assembler reproduces the identity of every made-up business document exactly', () => {
  it('all fixture business/document identities match, and a changed fact is a new identity', () => {
    const produced = new Map<string, string>();
    for (const instance of instanceSet.instances) {
      const docs = assembleDocumentsForBusiness(library, instance, instanceSet.attorney_review_gate, identityOf);
      for (const doc of docs) {
        produced.set(`${doc.business_id}/${doc.document_type}`, doc.document_content_hash);
        expect(doc.document_content_hash.startsWith('1f:')).toBe(true);
      }
    }
    expect(expectedIdentities.documents.length).toBeGreaterThanOrEqual(10);
    expect(produced.size).toBe(expectedIdentities.documents.length);
    for (const row of expectedIdentities.documents) {
      expect(produced.get(`${row.business_id}/${row.document_type}`)).toBe(row.identity);
    }
    const first = instanceSet.instances[0];
    const changed = { ...first, business_facts: { ...first.business_facts, contact_email: 'other@harborlight-tennis.example' } };
    const [before] = assembleDocumentsForBusiness(library, first, instanceSet.attorney_review_gate, identityOf);
    const [after] = assembleDocumentsForBusiness(library, changed, instanceSet.attorney_review_gate, identityOf);
    expect(after.document_content_hash === before.document_content_hash).toBe(false);
  });

  it('readiness and the facts to confirm match the fixtures: the open review gate keeps every document not ready', () => {
    for (const instance of instanceSet.instances) {
      const docs = assembleDocumentsForBusiness(library, instance, instanceSet.attorney_review_gate, identityOf);
      for (const doc of docs) {
        const row = expectedIdentities.documents.find((entry: { business_id: string; document_type: string }) =>
          entry.business_id === doc.business_id && entry.document_type === doc.document_type);
        expect(doc.customer_ready).toBe(row.customer_ready);
        expect(doc.clause_ids.length).toBe(row.clauses);
        expect(doc.blocking.missing_fields).toEqual(row.missing);
        expect(doc.blocking.unverified_founder_fields).toEqual(row.unverified);
      }
    }
  });

  it('a closed review gate makes a document ready only when no fact is still to be confirmed', () => {
    const closed = { customer_ready: true };
    const [harbor] = assembleDocumentsForBusiness(library, instanceSet.instances[0], closed, identityOf);
    expect(harbor.customer_ready).toBe(true);
    const [northwind] = assembleDocumentsForBusiness(library, instanceSet.instances[1], closed, identityOf);
    expect(northwind.blocking.unverified_founder_fields).toEqual(['business_legal_name']);
    expect(northwind.customer_ready).toBe(false);
  });
});

// Carried from bitfield-packages packages/legal-document-builder/__tests__/project-to-prose-page-record.test.ts.
// Changed: vitest is the Workshop's shim; the clause library is read from data/policy-clause-library.json; the business
// is a made-up tennis club; the identity is the BLAKE3 identity the tool uses. A test of project-to-blocks-page-record.ts
// is added (the package had none for it).
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { assembleDocumentsForBusiness, type PolicyClauseLibrary } from '../read-data/assemble-legal-documents.ts';
import { projectToProsePageRecord, proseParagraphs } from '../read-data/project-to-prose-page-record.ts';
import { projectToBlocksPageRecord } from '../read-data/project-to-blocks-page-record.ts';

const here = dirname(fileURLToPath(import.meta.url));
const identityOf = (text: string) => makeHashCodeHexFromBytes(new TextEncoder().encode(text));
const library: PolicyClauseLibrary = JSON.parse(readFileSync(join(here, '..', 'data', 'policy-clause-library.json'), 'utf8'));
const instanceSet = JSON.parse(readFileSync(join(here, 'fixtures', 'business-policy-instances.json'), 'utf8'));

describe('proseParagraphs', () => {
  it('drops the H1 and rule lines, splits blank-line paragraphs, trims empties', () => {
    const text = '# Title\n\nFirst para line one.\nStill first.\n\n---\n\nSecond para.\n';
    expect(proseParagraphs(text)).toEqual(['First para line one.\nStill first.', 'Second para.']);
  });
});

describe('projectToProsePageRecord', () => {
  const club = instanceSet.instances.find((i: { business_id: string }) => i.business_id === 'harbor-light-tennis');
  const routeBySlug: Record<string, string> = {
    terms: '/tos', privacy: '/privacy', refunds: '/refunds', waiver: '/waiver',
  };
  const nav = [
    { label: 'Harbor Light', href: '/' },
    { label: 'Terms', href: '/tos' },
    { label: 'Privacy', href: '/privacy' },
    { label: 'Refunds', href: '/refunds' },
    { label: 'Waiver', href: '/waiver' },
  ];

  it('emits the public-sales-page record shape a live display surface renders', () => {
    const docs = assembleDocumentsForBusiness(library, club, instanceSet.attorney_review_gate, identityOf);
    for (const doc of docs) {
      const record = projectToProsePageRecord(doc, {
        id_prefix: 'public-sales-page:legal-',
        route_path: routeBySlug[doc.document_type],
        brand: 'Harbor Light Tennis Club',
        nav,
      });
      expect(record.kind).toBe('public-sales-page');
      expect(record.schema).toBe('public-sales-page/page');
      expect(record.id).toBe(`public-sales-page:legal-${doc.document_type}`);
      expect(record.route_path).toBe(routeBySlug[doc.document_type]);
      expect(record.footerNote).toBe(`Document identity: ${doc.document_content_hash}`);
      const navSections = record.sections.filter((s) => s.category === 'nav');
      expect(navSections.map((s) => (s as { href?: string }).href))
        .toEqual(['/', '/tos', '/privacy', '/refunds', '/waiver']);
      const body = record.sections.find((s) => s.category === 'prose') as {
        heading: string; items: { text: { text: string }[] }[];
      };
      expect(body.heading).toBe(doc.title);
      expect(body.items.length).toBeGreaterThan(3);
      // No H1, no rules, no empty paragraphs in the projected items.
      for (const item of body.items) {
        expect(item.text[0].text.startsWith('# ')).toBe(false);
        expect(item.text[0].text.trim()).not.toBe('');
        expect(item.text[0].text.trim()).not.toBe('---');
      }
    }
  });

  it('deletion test: projects an unrelated business/document with zero code change', () => {
    const doc = {
      business_id: 'ace-plumbing',
      partition: 'ace-plumbing',
      document_type: 'service-agreement',
      title: 'Service Agreement',
      url: '/legal/service-agreement',
      text: '# Service Agreement\n\nWe fix pipes.\n\n---\n\nCall us.\n',
      document_content_hash: '1f:abc',
      clause_ids: ['x'],
      customer_ready: true,
      blocking: { attorney_review_gate_open: false, unverified_founder_fields: [], missing_fields: [] },
    };
    const record = projectToProsePageRecord(doc, {
      id_prefix: 'public-sales-page:legal-',
      route_path: '/legal/service-agreement',
      brand: 'Ace Plumbing',
      nav: [{ label: 'Home', href: '/' }],
    });
    const body = record.sections.find((s) => s.category === 'prose') as {
      items: { text: { text: string }[] }[];
    };
    expect(body.items.map((i) => i.text[0].text)).toEqual(['We fix pipes.', 'Call us.']);
  });
});

describe('projectToBlocksPageRecord', () => {
  const doc = {
    business_id: 'ace-plumbing',
    partition: 'ace-plumbing',
    document_type: 'service-agreement',
    title: 'Service Agreement',
    url: '/legal/service-agreement',
    text: '# Service Agreement\n\n1. Scope\n\nWe fix pipes.\n\n---\n\nCall us any day of the week at the number on our site, because a leak does not wait for office hours at all.\n',
    document_content_hash: '1f:abc',
    clause_ids: ['x'],
    customer_ready: true,
    blocking: { attorney_review_gate_open: false, unverified_founder_fields: [], missing_fields: [] },
  };
  const projection = {
    id: 'public-sales-page:service-agreement',
    route_path: '/service-agreement',
    brand_label: 'Ace Plumbing',
    navigation: [{ label: 'Home', href: '/' }],
  };

  it('writes the title and numbered short lines strong and every other paragraph plain', () => {
    const record = projectToBlocksPageRecord(doc, projection);
    expect(record.kind).toBe('public-sales-page');
    expect(record.title).toBe('Service Agreement, Ace Plumbing');
    expect(record.blocks[0]).toEqual({ kind: 'paragraph', parts: [{ strong: true, text: 'Service Agreement' }] });
    expect(record.blocks[1]).toEqual({ kind: 'paragraph', parts: [{ strong: true, text: '1. Scope' }] });
    expect(record.blocks[2]).toEqual({ kind: 'paragraph', text: 'We fix pipes.' });
    expect(record.blocks.length).toBe(4);
  });

  it('carries an opaque schema and a given title untouched, and leaves the schema out when none is given', () => {
    const withSchema = projectToBlocksPageRecord(doc, { ...projection, title: 'Plumbing terms', schema: { '@type': 'WebPage' } });
    expect(withSchema.title).toBe('Plumbing terms');
    expect(withSchema.schema).toEqual({ '@type': 'WebPage' });
    expect('schema' in projectToBlocksPageRecord(doc, projection)).toBe(false);
  });
});

// tools/legal-document-builder/do-work/write-legal-documents.mjs
//
// The Workshop tool "Write a business's terms, privacy, refund or waiver documents". Reads one JSON input (argv[2]):
//   { documents: ["terms", ...], facts: { <fact>: value | { value, needs_founder_verification } },
//     titles?: { <document>: title }, addresses?: { <document>: web address }, reviewed_by_a_lawyer?: boolean }
// assembles each document from the clause library (data/policy-clause-library.json) with the business's facts, and
// prints one JSON line: each document's text, its BLAKE3 identity, the clauses used, whether it is ready to publish,
// and which facts are missing or still to be confirmed, plus every fact each asked-for document reads.
import { readFileSync } from 'node:fs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { assembleDocumentsForBusiness } from '../read-data/assemble-legal-documents.ts';

const library = JSON.parse(readFileSync(new URL('../data/policy-clause-library.json', import.meta.url), 'utf8'));
const identityOf = text => `1f:${bytesToHex(blake3(utf8ToBytes(text)))}`;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function writeLegalDocuments(input) {
  if (!object(input)) throw new Error('The input must be an object with documents and facts.');
  const known = [...new Set(library.clauses.filter(clause => !clause.internal_only).map(clause => clause.document_type))];
  const documents = Array.isArray(input.documents) ? input.documents : [];
  const unknown = documents.filter(document => !known.includes(document));
  if (!documents.length || unknown.length) throw new Error(`documents must list some of: ${known.join(', ')}.${unknown.length ? ` Not known: ${unknown.join(', ')}.` : ''}`);
  if (!object(input.facts)) throw new Error('facts must be an object of the business\'s facts.');
  const assembled = assembleDocumentsForBusiness(library, {
    business_id: 'business', partition: 'business', documents, urls: object(input.addresses) ? input.addresses : {},
    ...(object(input.titles) ? { document_titles: input.titles } : {}), business_facts: input.facts,
  }, { customer_ready: input.reviewed_by_a_lawyer === true }, identityOf);
  // Every fact a document reads: the {{slots}} its clauses fill and the facts that decide which clauses apply.
  const factsItReads = document => {
    const clauses = library.clauses.filter(clause => clause.document_type === document && !clause.internal_only);
    return {
      fills: [...new Set(clauses.flatMap(clause => clause.body.flatMap(paragraph => [...paragraph.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]))))].sort(),
      decides_which_clauses: [...new Set(clauses.map(clause => clause.predicate.when_field).filter(Boolean))].sort(),
    };
  };
  return {
    documents: assembled.map(document => ({
      document_type: document.document_type, title: document.title, ...(document.url ? { address: document.url } : {}),
      text: document.text, identity: document.document_content_hash, clauses: document.clause_ids,
      ready_to_publish: document.customer_ready, lawyer_review_needed: document.blocking.attorney_review_gate_open,
      facts_to_confirm: document.blocking.unverified_founder_fields,
      missing_facts: [...new Set(document.blocking.missing_fields.map(field => field.split(':').at(-1)))],
    })),
    facts_it_reads: Object.fromEntries(documents.map(document => [document, factsItReads(document)])),
    note: library.not_legal_advice,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(writeLegalDocuments(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

// packages/legal-document-builder/read-data/assemble-legal-documents.ts
//
// Pure assembly of legal/policy documents from a clause library + one business's
// policy facts. No I/O, no display, no consent capture: display belongs to
// written-policy-page (or any sales-page route record), consent capture belongs
// to checkout, export belongs to structured-file-output.
//
// Invariants:
// - Document identity is the injected content identity of the assembled text (the
//   caller supplies BLAKE3 "1f:<hex>"), so a changed clause or fact is a new identity.
// - customer_ready is structurally false while the attorney review gate is open or
//   any consumed fact carries needs_founder_verification or any {{slot}} is missing.
//   A consumer that publishes a document as binding must check customer_ready;
//   assembly never lies about readiness.
// - Clause predicates and {{slot}} fill are DATA-driven: a new document type, new
//   business, or new jurisdiction toggle is new rows, zero code change here.
// - identityOf is injected so this module stays runtime-agnostic (node, wasm, browser).

export type ClausePredicate =
  | { always: true }
  | { when_field: string; equals: unknown }
  | { when_field: string; gt: number };

export type PolicyClause = {
  clause_id: string;
  document_type: string;
  predicate: ClausePredicate;
  body: readonly string[];
  internal_only?: boolean;
};

export type PolicyClauseLibrary = {
  kind: string;
  clauses: readonly PolicyClause[];
};

export type PolicyFactValue =
  | string
  | number
  | boolean
  | { value: string | number | boolean; needs_founder_verification?: boolean };

export type BusinessPolicyInstance = {
  business_id: string;
  partition: string;
  documents: readonly string[];
  urls: Record<string, string>;
  document_titles?: Record<string, string>;
  business_facts: Record<string, PolicyFactValue>;
};

export type AttorneyReviewGate = { customer_ready: boolean };

export type AssembledDocument = {
  business_id: string;
  partition: string;
  document_type: string;
  title: string;
  url: string | undefined;
  text: string;
  document_content_hash: string;
  clause_ids: readonly string[];
  customer_ready: boolean;
  blocking: {
    attorney_review_gate_open: boolean;
    unverified_founder_fields: readonly string[];
    missing_fields: readonly string[];
  };
};

const DEFAULT_TITLES: Record<string, string> = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  refunds: 'Refund and Cancellation Policy',
  waiver: 'Assumption of Risk, Release, and Media Consent',
};

function factValue(
  facts: Record<string, PolicyFactValue>,
  key: string,
): { value: string | number | boolean | undefined; unverified: boolean } {
  const raw = facts[key];
  if (raw === undefined || raw === null) return { value: undefined, unverified: false };
  if (typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) {
    return { value: raw.value, unverified: Boolean(raw.needs_founder_verification) };
  }
  return { value: raw as string | number | boolean, unverified: false };
}

export function predicatePasses(
  predicate: ClausePredicate,
  facts: Record<string, PolicyFactValue>,
): boolean {
  if ('always' in predicate && predicate.always) return true;
  if (!('when_field' in predicate)) return false;
  const { value } = factValue(facts, predicate.when_field);
  if ('equals' in predicate) return value === predicate.equals;
  if ('gt' in predicate) return typeof value === 'number' && value > predicate.gt;
  return false;
}

export function assembleDocumentsForBusiness(
  library: PolicyClauseLibrary,
  instance: BusinessPolicyInstance,
  gate: AttorneyReviewGate,
  identityOf: (text: string) => string,
): AssembledDocument[] {
  const facts = instance.business_facts;
  const documents: AssembledDocument[] = [];

  for (const docType of instance.documents) {
    const clauses = library.clauses.filter(
      (c) => c.document_type === docType && !c.internal_only && predicatePasses(c.predicate, facts),
    );
    if (clauses.length === 0) {
      throw new Error(`no clauses matched ${instance.business_id}/${docType}`);
    }

    const unverifiedFields = new Set<string>();
    const missingFields = new Set<string>();
    const sections = clauses.map((clause) => {
      const filled = clause.body.map((paragraph) =>
        paragraph.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
          const { value, unverified } = factValue(facts, key);
          if (value === undefined) {
            missingFields.add(`${clause.clause_id}:${key}`);
            return `[[MISSING:${key}]]`;
          }
          if (unverified) unverifiedFields.add(key);
          return String(value);
        }),
      );
      return { clause_id: clause.clause_id, text: filled.join('\n\n') };
    });

    const title = instance.document_titles?.[docType] ?? DEFAULT_TITLES[docType] ?? docType;
    const bizName = factValue(facts, 'business_legal_name').value;
    const body = sections.map((s) => s.text).join('\n\n');
    const fullText = `# ${title}\n\n${body}\n`;
    const hash = identityOf(fullText);
    const footer = `\n---\n\nDocument identity: ${hash} · Business: ${String(bizName)} · Effective date: set at publication. Questions: ${String(factValue(facts, 'contact_email').value)}\n`;

    const blocking = {
      attorney_review_gate_open: !gate.customer_ready,
      unverified_founder_fields: [...unverifiedFields],
      missing_fields: [...missingFields],
    };
    documents.push({
      business_id: instance.business_id,
      partition: instance.partition,
      document_type: docType,
      title,
      url: instance.urls[docType],
      text: fullText + footer,
      document_content_hash: hash,
      clause_ids: sections.map((s) => s.clause_id),
      customer_ready:
        !blocking.attorney_review_gate_open
        && blocking.unverified_founder_fields.length === 0
        && blocking.missing_fields.length === 0,
      blocking,
    });
  }
  return documents;
}

// The starting sales contract templates: each template's included usage and access turned into the rules a contract keeps,
// with its own terms kept as written. Port of salesContractTemplates in the old owner (src/sales-contract-templates.mjs,
// held at from-an-older-version). Storage-free: the caller reads the template records and passes them in. Templates
// are inert: choosing one never changes a saved deal, its price or its sharing.
import data from './draft-and-send-a-sales-contract-to-a-customer-from-contract-templates-listing.json' with { type: 'json' };
import { object, text } from './list-contract-records.mjs';

const humanWords = id => id.replace(/^[^:]+:/, '').replace(/[-_]+/g, ' ');
const failure = () => Object.assign(new Error(data.fail.message), { status: data.fail.status, code: data.fail.code });

/** records: the template records' list (each { payload }), or null when the records are not there (then no templates). */
export function salesContractTemplatesFrom(records) {
  if (records === null) return [];
  if (!Array.isArray(records)) throw failure();
  const seen = new Set();
  return records.map(record => {
    const payload = record?.payload;
    if (!object(payload) || !text(payload.id) || seen.has(payload.id) || !text(payload.label) || typeof payload.summary !== 'string' || !object(payload.contract)) throw failure();
    seen.add(payload.id);
    const terms = payload.contract;
    const access = terms.access_grants ?? [];
    const usage = terms.included_usage ?? [];
    if (!Array.isArray(access) || access.some(id => !text(id))
      || !Array.isArray(usage) || usage.some(row => !object(row) || (row.quantity !== undefined && (!Number.isFinite(row.quantity) || row.quantity < 0)))
      || (payload.known_terms !== undefined && !Array.isArray(payload.known_terms))
      || (payload.fields_to_agree !== undefined && (!Array.isArray(payload.fields_to_agree) || payload.fields_to_agree.some(field => !text(field))))) {
      throw failure();
    }
    const rules = [
      ...usage.map((row, rowIndex) => ({
        type: data.usage_rule.type,
        label: String(row.service ?? data.usage_rule.default_label.replace('{n}', () => String(rowIndex + 1))),
        resource: String(row.service ?? data.usage_rule.default_resource),
        metric: String(row.unit ?? data.usage_rule.default_metric),
        pricing_rules: { per_unit_cents: 0, included_units: row.quantity ?? 0 },
      })),
      ...access.map(id => ({ type: data.access_rule.type, label: humanWords(id), resource: id, condition: data.access_rule.condition })),
    ];
    return {
      id: payload.id,
      name: payload.label,
      description: payload.summary,
      rules,
      sourceTerms: {
        contract: structuredClone(terms),
        known_terms: structuredClone(payload.known_terms ?? []),
        fields_to_agree: structuredClone(payload.fields_to_agree ?? []),
      },
    };
  });
}

// tools/coordination-sessions/do-work/coordination-sessions.mjs
//
// The tool seam. Each export is run by tools/records-door/do-work/run-an-export.mjs as fn(input). Sessions, catalog
// entries and plans go in and come out as JSON; nothing is kept here, so the caller keeps what it wants as records.
import { runASessionOperation } from './session-lifecycle.ts';
import {
  crossOfferSessionCatalogEntry,
  publishSessionCatalogEntry,
  readSessionCatalog,
  retractSessionCatalogEntry,
  supersedeSessionCatalogEntry,
  updateSessionCatalogEntry,
} from '../read-data/session-catalog.ts';
import { planAnEvent as plan } from '../read-data/plan-an-event.ts';

const need = (value, field) => {
  if (value === undefined || value === null) throw new Error(`${field} is required for this operation.`);
  return value;
};

export function runASessionStep(input) {
  const answer = runASessionOperation(input);
  return 'predecessor' in answer ? answer : { session: answer };
}

// One entry per catalog operation: an unknown name is refused by name, never run as something else.
const CATALOG_OPERATIONS = {
  publish: input => ({ entry: publishSessionCatalogEntry(need(input.entry, 'entry')) }),
  read: input => ({ entries: readSessionCatalog(need(input.entries, 'entries'), { catalog_entry_refs: input.catalog_entry_refs, session_refs: input.session_refs }) }),
  update: input => ({ entry: updateSessionCatalogEntry(need(input.entry, 'entry'), need(input.patch, 'patch')) }),
  retract: input => ({ entry: retractSessionCatalogEntry(need(input.entry, 'entry'), input.retracted_at ?? new Date().toISOString(), need(input.reason_ref, 'reason_ref')) }),
  supersede: input => supersedeSessionCatalogEntry(need(input.predecessor, 'predecessor'), need(input.successor, 'successor')),
  cross_offer: input => ({ entry: crossOfferSessionCatalogEntry(need(input.entry, 'entry'), need(input.relation, 'relation')) }),
};

export function workASessionCatalog(input) {
  const operation = Object.hasOwn(CATALOG_OPERATIONS, input.operation) ? CATALOG_OPERATIONS[input.operation] : undefined;
  if (!operation) throw new Error(`There is no catalog operation "${input.operation}". The operations are: ${Object.keys(CATALOG_OPERATIONS).join(', ')}.`);
  return operation(input);
}

export function planAnEvent(input) {
  return plan(input);
}

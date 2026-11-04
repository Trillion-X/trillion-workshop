// src/list-proposals.mjs
//
// Purpose: an AI writer proposes, a person decides. A proposal is a reviewable change to a list kept beside it as one
// record, <type>:<list>:<id>: the rows it would change with their new values, what each of those values was when it was
// proposed (`saw`), the rows it may touch at all (`editable`), the places it looked for its evidence (`scopes`) and the
// evidence (rows within them). Nothing changes until a person approves; approving applies the whole change once, as the
// approver, through the list's own putRows (so keys, pairs, required values, settles and rights are the list's), and a row
// changed since it was proposed makes the proposal conflicted instead of half applied. A list that says
// review_changes: true refuses direct writes from a gated writer (src/lists.mjs putRows, `gatedWriter`).
//
// Why the lists engine and not parts/record-log record-layers: a layer keeps raw records aside and merges them into the
// store with applyChanges, under none of a list's rules (identity keys, paired links, required values, settled values,
// stamps, history, write rights), needs the store's own SQL (a list placed in another database, or a store without it,
// has none) and holds a table per draft. A proposal is the request putRows will be asked, kept as data, so approving
// it is the same write the AI would have made, checked the same way, and it lives wherever the list's rows live.
//
// Non-Negotiable Invariants:
//   1. Exactly once: the proposal's state is checked and changed in the same transaction as the rows; approving an
//      applied proposal is refused, and a proposal whose rows already hold its values (a retry after the write) is marked
//      applied without writing them again.
//   2. All or nothing: every row is compared with what it held when proposed before anything is written; one changed row
//      leaves every row as it is and the proposal conflicted, naming the rows and fields.
//   3. Bounded by what it says: a row outside `editable`, a scope past scopes_most, evidence outside its scopes, or a
//      change putRows would refuse (previewRows) is refused when proposed.
//   4. Decisions, who may make each, their states and every limit are DATA (src/lists.json `proposals`).
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { ListsError, listSay as say } from './list-refusals.mjs';
import { actorClass } from './list-stamps.mjs';

const rules = data.proposals;
const encoder = new TextEncoder();
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const idOf = value => typeof value === 'string' && value && value.length <= 200 && !value.includes('/');
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const decisions = Object.keys(rules.decisions).filter(name => !name.startsWith('_'));

/** Whether a writer is one whose changes to a review_changes list wait for a person (lists.json proposals.gated). */
export const gatedWriter = actor => rules.gated.roads.includes(actor?.via?.road) || rules.gated.classes.includes(actorClass(actor));

/**
 * The proposals of the lists of one store. `eeaf` is the store, `write(records, context)` the lists' one write road,
 * `transaction(work)` its transaction, `readList(slug)` a kept definition, `rowPrefix(type)` a list's row prefix, and
 * `lists` the lists object (previewRows, putRows).
 */
export function listProposals({ eeaf, write, transaction, readList, rowPrefix, lists }) {
  const recordOf = (slug, proposalId) => `${rules.type}:${slug}:${proposalId}`;
  const refuse = what => say('bad_proposal', { editable_most: rules.editable_most, scopes_most: rules.scopes_most, evidence_most: rules.evidence_most, what });
  const shown = (proposalId, kept) => ({ proposal_id: proposalId, ...kept });

  // Checks a proposal's shape against its own bounds; answers it normalized.
  const checked = input => {
    const rows = input.rows ?? [];
    const remove = input.remove ?? [];
    const editable = input.editable ?? [];
    const scopes = input.scopes ?? [];
    const evidence = input.evidence ?? [];
    if (!Array.isArray(editable) || !editable.length || editable.length > rules.editable_most || !editable.every(idOf)) throw refuse('editable');
    if (!Array.isArray(rows) || !Array.isArray(remove) || !rows.length && !remove.length) throw refuse('rows');
    for (const row of rows) if (!isObject(row) || !idOf(row.id) || !isObject(row.values) || !editable.includes(row.id)) throw refuse(`row ${JSON.stringify(row?.id)}`);
    for (const rowId of remove) if (!editable.includes(rowId)) throw refuse(`remove ${JSON.stringify(rowId)}`);
    if (!Array.isArray(scopes) || scopes.length > rules.scopes_most || !scopes.every(scope => isObject(scope) && idOf(scope.list_id) && (scope.view_id === undefined || idOf(scope.view_id)))) throw refuse('scopes');
    if (!Array.isArray(evidence) || evidence.length > rules.evidence_most
      || !evidence.every(item => isObject(item) && idOf(item.list_id) && idOf(item.row_id) && scopes.some(scope => scope.list_id === item.list_id))) throw refuse('evidence');
    if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > data.limits.basis_chars)) throw refuse('note');
    return { rows: rows.map(row => ({ id: row.id, values: row.values })), remove: [...new Set(remove)], editable: [...new Set(editable)],
      scopes: scopes.map(scope => ({ list_id: scope.list_id, ...(scope.view_id ? { view_id: scope.view_id } : {}) })),
      evidence: evidence.map(item => ({ list_id: item.list_id, row_id: item.row_id })), ...(input.note ? { note: input.note } : {}) };
  };
  // What each row held, for the fields the proposal changes (null: the row did not exist).
  const sawOf = (list, change) => change.rows.map(row => {
    const current = eeaf.read(`${rowPrefix(list.row_type)}${row.id}`);
    return { id: row.id, values: current ? Object.fromEntries(Object.keys(row.values).map(field => [field, current[field] ?? null])) : null };
  });

  return {
    /** Keeps a proposal (or revises one of the same proposer still open): { proposal_id, status, review }. */
    propose(slug, input = {}, { actor } = {}) {
      const list = readList(slug);
      const change = checked(input);
      // A change the list would refuse is refused now, in the list's own words, before anyone is asked to look at it.
      const preview = lists.previewRows(slug, { rows: change.rows, remove: change.remove }, { actor: { by: 'list-proposals' } });
      if (preview.ok === false) {
        const { message, ...detail } = preview.refused;
        throw Object.assign(new ListsError(message), { detail });
      }
      const now = new Date().toISOString();
      let proposalId = input.proposal_id;
      if (proposalId !== undefined) {
        const open = idOf(proposalId) ? eeaf.read(recordOf(slug, proposalId)) : null;
        if (!open) throw say('no_proposal', { list_id: slug, proposal_id: proposalId });
        if (!rules.decisions.withdraw.from.includes(open.status) || open.by !== (actor?.by ?? null))
          throw say('proposal_decided', { proposal_id: proposalId, status: open.status, decision: 'revised', decisions: decisions.join(', ') });
      } else {
        proposalId = `p${bytesToHex(blake3(encoder.encode(JSON.stringify([slug, change, now, actor?.by ?? null])))).slice(0, 24)}`;
      }
      const value = { list_id: slug, status: 'pending', ...change, saw: sawOf(list, change), proposed_at: now, by: actor?.by ?? null, ...(actor?.via ? { via: actor.via } : {}) };
      write([{ id: recordOf(slug, proposalId), type: rules.type, value }], { actor });
      return { list_id: slug, proposal_id: proposalId, status: 'pending', review: { decide_with: 'decide_list_proposal', retry_after_seconds: rules.retry_after_seconds } };
    },

    /** A list's proposals in one state (default pending), newest first: { proposals: [...], next_cursor }. */
    proposals(slug, { status = 'pending', limit = rules.listed_most, cursor } = {}) {
      readList(slug);
      const most = Math.min(Math.max(1, Number(limit) || rules.listed_most), rules.listed_most);
      const entries = eeaf.scan(rules.type, 'list-proposals', { equal: [slug, String(status)], ...(cursor ? { to: cursor } : {}), reverse: true, limit: most + 1 })
        .filter(entry => !cursor || entry.values[2] < cursor);
      const page = entries.slice(0, most);
      return { list_id: slug, status, proposals: page.map(entry => shown(entry.id.slice(`${rules.type}:${slug}:`.length), eeaf.read(entry.id))).filter(row => row.list_id),
        ...(entries.length > most ? { next_cursor: page.at(-1).values[2] } : {}) };
    },

    /** One proposal as kept. */
    proposal(slug, proposalId) {
      const kept = idOf(proposalId) ? eeaf.read(recordOf(slug, proposalId)) : null;
      if (!kept) throw say('no_proposal', { list_id: slug, proposal_id: proposalId });
      return shown(proposalId, kept);
    },

    /** A decision on a proposal (lists.json proposals.decisions): { proposal_id, status, kept?, conflicts? }. */
    decide(slug, proposalId, { decision } = {}, { actor } = {}) {
      const rule = Object.hasOwn(rules.decisions, decision ?? '') && !String(decision).startsWith('_') ? rules.decisions[decision] : null;
      return transaction(() => {
        const id = idOf(proposalId) ? recordOf(slug, proposalId) : null;
        const kept = id ? eeaf.read(id) : null;
        if (!kept) throw say('no_proposal', { list_id: slug, proposal_id: proposalId });
        if (!rule || !rule.from.includes(kept.status)) throw say('proposal_decided', { proposal_id: proposalId, status: kept.status, decision: String(decision), decisions: decisions.join(', ') });
        if (rule.person && gatedWriter(actor)) throw say('person_decides', { proposal_id: proposalId });
        if (rule.proposer && kept.by !== (actor?.by ?? null)) throw say('person_decides', { proposal_id: proposalId });
        const decided = { decided_at: new Date().toISOString(), decided_by: actor?.by ?? null, ...(actor?.via ? { decided_via: actor.via } : {}) };
        if (rule.removes) {
          write([{ id, type: rules.type, value: null }], { actor });
          return { list_id: slug, proposal_id: proposalId, removed: true };
        }
        if (!rule.applies) {
          write([{ id, type: rules.type, value: { ...kept, status: rule.to, ...decided } }], { actor });
          return { list_id: slug, proposal_id: proposalId, status: rule.to };
        }
        // Every row is compared with what it held when proposed; a row already holding the proposed values was applied.
        const list = readList(slug);
        const prefix = rowPrefix(list.row_type);
        const conflicts = [];
        let pending = 0;
        for (const [index, row] of kept.rows.entries()) {
          const current = eeaf.read(`${prefix}${row.id}`);
          const saw = kept.saw[index]?.values ?? null;
          if (current && Object.entries(row.values).every(([field, value]) => same(current[field], value))) continue;
          pending += 1;
          if (saw === null ? current !== null : !current) { conflicts.push({ row_id: row.id, found: Boolean(current), fields: [] }); continue; }
          if (saw === null) continue;
          const changed = Object.keys(saw).filter(field => !same(current[field], saw[field]));
          if (changed.length) conflicts.push({ row_id: row.id, found: true, fields: changed });
        }
        const removing = kept.remove.filter(rowId => eeaf.read(`${prefix}${rowId}`));
        if (conflicts.length) {
          write([{ id, type: rules.type, value: { ...kept, status: 'conflicted', conflicts, ...decided } }], { actor });
          return { list_id: slug, proposal_id: proposalId, status: 'conflicted', conflicts };
        }
        const answer = pending || removing.length ? lists.putRows(slug, {
          rows: kept.rows.map((row, index) => ({ id: row.id, values: row.values, ...(kept.saw[index]?.values ? { if_values: kept.saw[index].values } : {}) })),
          remove: removing,
        }, { actor: { ...(actor ?? {}), proposed_by: kept.by } }) : { kept: kept.rows.map(row => ({ id: row.id })), removed: [] };
        if (answer.conflicts?.length) throw say('proposal_decided', { proposal_id: proposalId, status: 'conflicted', decision, decisions: decisions.join(', ') });
        const { conflicts: _old, ...rest } = kept;
        write([{ id, type: rules.type, value: { ...rest, status: 'applied', ...decided } }], { actor });
        return { list_id: slug, proposal_id: proposalId, status: 'applied', kept: answer.kept.map(row => row.id), removed: answer.removed ?? [] };
      });
    },
  };
}

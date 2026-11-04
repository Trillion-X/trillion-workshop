// Native workspace invariant owner. The original conflict/HLC algorithms are
// supplied directly over this resource's carried SQL, without account forwarding.
import {workspaceRecordSql,makeWorkspaceConflict,tickHybridClock,workspaceConflictLabel,workspaceValueIdentity} from '../../set-up-my-account/read-data/conflicts.mjs';
import {jsonExpansionBytes} from '../../json-expansion.mjs';
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/pool-settings.json' with {type:'json'};
import firstAnswers from '../../keep-and-wake-ai-sessions-on-this-computer/src/workspace/first-answers.json' with {type:'json'};
import historyRules from '../../make-screen-layouts-and-controls/src/workspace-record-history.json' with {type:'json'};
import { revisionPolicyFor, revisionMember, revisionMembers, restoreRevisionMember, removeRevisionMember } from '../../make-screen-layouts-and-controls/src/workspace-revision-selection.mjs';
import { applyOperations, documentFromBlocks, openDocument, stampOperations, DocumentOperationError, DOCUMENT_LIMITS, DOCUMENT_OPERATIONS_LABEL_PREFIX, DOCUMENT_SCHEMA_VERSION } from './workspace/document-operations.mjs';
const WORKSPACE_LIMITS=settings.workspace_records;
export const SHOW_RULES_OWNER_CAPABILITY=Symbol('native-show-rules-owner-write');
/** The existing conditional saved-record operation, described from its owning limits. */
export function workspaceWriteInputSchema() {
  return { type: 'object', properties: {
    writes: { type: 'array', minItems: 1, maxItems: WORKSPACE_LIMITS.writes, items: { type: 'object', required: ['address_label', 'payload'], properties: {
      address_label: { type: 'string', minLength: 1, maxLength: WORKSPACE_LIMITS.label_chars }, payload: {},
      expected_identity: { type: ['string', 'null'] }, scope_id: { type: 'string', minLength: 1, maxLength: WORKSPACE_LIMITS.label_chars },
    } } },
    conflict_policy: { type: 'string', enum: ['preserve', 'retry'] },
    resolve_conflict: { type: 'object', required: ['id', 'branch_identity'], properties: {
      id: { type: 'string', minLength: 1 }, branch_identity: { type: 'string', minLength: 1 },
    } },
  }, oneOf: [{ required: ['writes'], not: { required: ['resolve_conflict'] } }, { required: ['resolve_conflict'], not: { required: ['writes'] } }] };
}
const DOCUMENT_REVISION_LIMIT = historyRules.max_revisions_per_member;
const DOCUMENT_REVISION_BYTES = historyRules.max_total_bytes;
const isVersionedAddress = address => Boolean(revisionPolicyFor(address, historyRules.records));
// One version store for every owner type src/workspace-record-history.json names (documents, layouts, a screen's own
// arrangement, looks): each version has a kind, and each kind its own retention.
const KINDS = historyRules.kinds;
const PINNED_KINDS = JSON.stringify(Object.keys(KINDS).filter(kind => KINDS[kind].keep === null));
const keepOf = (policy, kind) => (Object.hasOwn(policy?.retention ?? {}, kind) ? policy.retention[kind] : KINDS[kind].keep);
const ownerTypeOf = address => revisionPolicyFor(address, historyRules.records)?.owner_type ?? null;
// The kind a write is kept as, from the road it came by, and the turn it belongs to when that road keeps turns.
const writingOf = acting => {
  const row = historyRules.writer_kinds.find(one => one.road === acting?.via?.road) ?? null;
  return { kind: row?.kind ?? historyRules.default_kind, turn: row?.turn === true && typeof acting?.turn === 'string' && acting.turn ? acting.turn : null };
};
const memberIdentity = (value, policy, scopeId) => { const member = value ? revisionMember(value, policy, scopeId) : null; return member ? workspaceValueIdentity(member) : null; };
const assertDocumentHistoryOwner = address => {
  if (!isVersionedAddress(address)) throw new Error('Version history is unavailable for this record owner; shared-room history is not supported by the private Documents history owner.');
};
export class NativeWorkspaceRecords {
  // written (labels): told of the labels each successful write changed, after its rows are put.
  // actor (): who is writing now, { author, via, turn } (the admitted command's reader, road and permit), or null.
  constructor({sql,transaction,live,commandJournal=null,written=null,actor=()=>null}){this.sql=sql;this.transaction=transaction;this.live=live;this.commandJournal=commandJournal;this.written=written;this.actor=actor;}
  workspaceTable() {
    return workspaceRecordSql(this.sql);
  }
  workspaceRecords(selection) {
    const sql = this.workspaceTable(), clauses = [], args = [];
    if (selection !== undefined) {
      const labels = Array.isArray(selection) ? selection : selection?.labels ?? [];
      const prefixes = Array.isArray(selection) ? [] : selection?.prefixes ?? [];
      if (!Array.isArray(labels) || !Array.isArray(prefixes) || labels.length + prefixes.length > WORKSPACE_LIMITS.writes)
        throw Object.assign(new Error(`Read at most ${WORKSPACE_LIMITS.writes} workspace addresses at a time.`),{status:400});
      if ([...labels, ...prefixes].some(label => typeof label !== 'string' || !label || label.length > WORKSPACE_LIMITS.label_chars))
        throw Object.assign(new Error('Each record needs a valid address label.'),{status:400});
      const unique = [...new Set(labels)];
      if (unique.length) { clauses.push(`label IN (${unique.map(() => '?').join(', ')})`); args.push(...unique); }
      for (const prefix of new Set(prefixes)) { clauses.push('substr(label, 1, length(?)) = ?'); args.push(prefix, prefix); }
      if (!clauses.length) return {};
    }
    const where = clauses.length ? ` WHERE ${clauses.map(clause => `(${clause})`).join(' OR ')}` : '';
    // Count bytes inside SQLite before returning any value text. Legacy full-map reads have the same budget.
    const [size] = sql.exec(`SELECT COALESCE(SUM(length(CAST(label AS BLOB)) + length(CAST(value AS BLOB))), 0) AS bytes FROM workspace_records${where}`, ...args).toArray();
    if (size.bytes > WORKSPACE_LIMITS.read_bytes) throw Object.assign(new Error('These saved records are too large to read together. Read fewer addresses.'),{status:400});
    const records = {};
    let expanded = 0;
    for (const row of sql.exec(`SELECT label, value FROM workspace_records${where}`, ...args)) {
      expanded += 32 + row.label.length * 2;
      expanded += jsonExpansionBytes(row.value, WORKSPACE_LIMITS.read_expanded_bytes - expanded).bytes;
      if (expanded > WORKSPACE_LIMITS.read_expanded_bytes) throw Object.assign(new Error('These saved records are too large to read together. Read fewer addresses.'),{status:400});
      records[row.label] = JSON.parse(row.value);
    }
    return records;
  }
  workspaceConflicts({ limit = 25, after = '' } = {}) {
    const take = Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 25));
    const cursor = typeof after === 'string' ? after.slice(0, WORKSPACE_LIMITS.label_chars) : '';
    const prefix = 'workspace-conflict:';
    const rows = this.workspaceTable().exec('SELECT label, id, address, current_identity, wall_ms, logical, device_id, state FROM workspace_conflict_index WHERE label >= ? AND label < ? AND label > ? AND state = \'open\' ORDER BY label LIMIT ?', prefix, 'workspace-conflict;', cursor, take + 1).toArray();
    const page = rows.slice(0, take);
    return { conflicts: page.map(({ id, address, current_identity, wall_ms, logical, device_id, state }) => ({ id, address, current_identity, clock: { wall_ms, logical, device_id }, state })),
      next_cursor: rows.length > take ? page.at(-1)?.label ?? null : null };
  }
  workspaceConflict(id) {
    const label = workspaceConflictLabel(id);
    const [row] = this.workspaceTable().exec('SELECT value FROM workspace_records WHERE label = ?', label).toArray();
    if (!row) return null;
    const conflict = JSON.parse(row.value);
    return conflict.state === 'open' ? conflict : null;
  }
  indexWorkspaceConflict(conflict) {
    const label = workspaceConflictLabel(conflict.id);
    const { wall_ms, logical, device_id } = conflict.clock;
    this.workspaceTable().exec('INSERT INTO workspace_conflict_index (label, id, address, current_identity, wall_ms, logical, device_id, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(label) DO UPDATE SET id = excluded.id, address = excluded.address, current_identity = excluded.current_identity, wall_ms = excluded.wall_ms, logical = excluded.logical, device_id = excluded.device_id, state = excluded.state', label, conflict.id, conflict.address, conflict.current_identity, wall_ms, logical, device_id, conflict.state);
  }
  workspaceRecord(label) {
    const [row] = this.workspaceTable().exec('SELECT value FROM workspace_records WHERE label = ?', label).toArray();
    return row ? JSON.parse(row.value) : null;
  }
  keepsRevisionHistory(address) { return isVersionedAddress(address); }
  workspaceRevisionHistory(address, { scope_id: scopeId, limit = 50, before = null, kind = null } = {}) {
    assertDocumentHistoryOwner(address);
    if (typeof scopeId !== 'string' || !scopeId.trim()) throw new Error('Choose a document before reading its version history.');
    const take = Math.max(1, Math.min(DOCUMENT_REVISION_LIMIT, Number.isInteger(limit) ? limit : 50));
    const sql = this.workspaceTable();
    const cursor = Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
    if (kind !== null && !Object.hasOwn(KINDS, kind)) throw Object.assign(new Error(`Versions are kept as ${Object.keys(KINDS).join(', ')}.`), { status: 400 });
    const rows = sql.exec('SELECT revision_id,identity,written_at,author,sequence,kind FROM workspace_document_revisions WHERE address=? AND scope_id=? AND sequence<? AND (? IS NULL OR kind=?) ORDER BY sequence DESC LIMIT ?', address, scopeId, cursor, kind, kind, take + 1).toArray();
    const page = rows.slice(0, take);
    const [current] = sql.exec('SELECT value FROM workspace_records WHERE label=?', address).toArray();
    const record = current ? JSON.parse(current.value) : null;
    const member = record ? revisionMember(record, revisionPolicyFor(address, historyRules.records), scopeId) : null;
    const currentIdentity = member ? workspaceValueIdentity(member) : null;
    const [head] = sql.exec('SELECT revision_id,identity FROM workspace_document_revisions WHERE address=? AND scope_id=? ORDER BY sequence DESC LIMIT 1', address, scopeId).toArray();
    const omitted = sql.exec('SELECT omitted_at FROM workspace_document_revision_counters WHERE address=? AND scope_id=?', address, scopeId).toArray()[0]?.omitted_at;
    return { owner_type: ownerTypeOf(address), limited: Boolean(omitted), revisions: page.map(row => ({ id: row.revision_id, number: Number(row.sequence), kind: row.kind, at: row.written_at, by: row.author ?? null, words: null, current: row.revision_id === head?.revision_id && row.identity === currentIdentity })), current_identity: currentIdentity, next_cursor: rows.length > take ? Number(page.at(-1)?.sequence) : null };
  }
  workspaceRevision(revisionId) {
    if (typeof revisionId !== 'string' || !revisionId) throw new Error('Choose a saved document version.');
    const [row] = this.workspaceTable().exec('SELECT revision_id,address,scope_id,identity,value,written_at,author,sequence,kind FROM workspace_document_revisions WHERE revision_id=?', revisionId).toArray();
    return row ? { id: row.revision_id, address: row.address, owner_type: ownerTypeOf(row.address), scope_id: row.scope_id, identity: row.identity, kind: row.kind, value: JSON.parse(row.value), at: row.written_at, by: row.author ?? null, number: Number(row.sequence) } : null;
  }
  // What a restore whose call is gone did (its readback; reads only). A restore is one write: the document's member
  // still at the expected identity was never restored; the member now the restored version's is the restore.
  restoreOutcome({ address, id, expected_identity: expectedIdentity, scope_id: scopeId }) {
    const revision = this.workspaceRevision(id);
    if (!revision || revision.address !== address || scopeId !== revision.scope_id) return { state: 'unknown' };
    const [stored] = this.workspaceTable().exec('SELECT value FROM workspace_records WHERE label=?', address).toArray();
    const current = stored ? JSON.parse(stored.value) : null;
    const currentMember = current ? revisionMember(current, revisionPolicyFor(address, historyRules.records), scopeId) : null;
    const currentIdentity = currentMember ? workspaceValueIdentity(currentMember) : null;
    if (currentIdentity === expectedIdentity) return { state: 'aborted' };
    return currentIdentity !== null && currentIdentity === workspaceValueIdentity(revision.value)
      ? { state: 'committed', result: { restored: true, identity: workspaceValueIdentity(current), scope_id: scopeId } } : { state: 'unknown' };
  }
  restoreWorkspaceRevision(address, revisionId, expectedIdentity, author = null, scopeId = undefined) {
    const revision = this.workspaceRevision(revisionId);
    if (!revision || revision.address !== address) throw new Error('That document version is no longer available.');
    const [stored] = this.workspaceTable().exec('SELECT value FROM workspace_records WHERE label=?', address).toArray();
    const current = stored ? JSON.parse(stored.value) : null;
    const policy = revisionPolicyFor(address, historyRules.records);
    if (typeof scopeId !== 'string' || scopeId !== revision.scope_id) throw new Error('That version belongs to another document.');
    const currentMember = current ? revisionMember(current, policy, scopeId) : null;
    const currentIdentity = currentMember ? workspaceValueIdentity(currentMember) : null;
    if (currentIdentity !== expectedIdentity) return { restored: false, conflict: true, current_identity: currentIdentity, scope_id: scopeId };
    const restored = restoreRevisionMember(current, revision.value, policy, scopeId);
    const result = this.putWorkspaceRecords([{ address_label: address, payload: restored, expected_identity: current ? workspaceValueIdentity(current) : null, scope_id: scopeId }], { author });
    if (result.conflicts?.length) return { restored: false, conflict: true, conflicts: result.conflicts };
    return { restored: result.written === 1, identity: workspaceValueIdentity(restored), ...(scopeId === undefined ? {} : { scope_id: scopeId }) };
  }
  // Keeps a member as it is now as an asked-for kind (src/workspace-record-history.json `asked`): a manual version is never
  // pruned, a publish version keeps its own count. Answers the revision, or a refusal when the member is not there.
  keepWorkspaceVersion({ address, scope_id: scopeId, kind = 'manual', expected_identity: expected } = {}, author = null) {
    assertDocumentHistoryOwner(address);
    if (KINDS[kind]?.asked !== true) throw Object.assign(new Error(`A version can be kept on request as ${Object.keys(KINDS).filter(one => KINDS[one].asked === true).join(' or ')}.`), { status: 400 });
    return this.transaction(() => {
      const sql = this.workspaceTable(), policy = revisionPolicyFor(address, historyRules.records);
      const current = this.workspaceRecord(address), member = current ? revisionMember(current, policy, scopeId) : null;
      if (!member) throw Object.assign(new Error('There is nothing kept there to keep a version of.'), { status: 404 });
      const identity = workspaceValueIdentity(member);
      if (expected !== undefined && expected !== identity) return { kept: false, conflict: true, current_identity: identity, scope_id: scopeId };
      const id = this.keepDocumentRevision(sql, address, scopeId, member, new Date().toISOString(), author ?? this.actor()?.author ?? null, kind);
      return { kept: true, revision: id, kind, identity, owner_type: ownerTypeOf(address), scope_id: scopeId };
    });
  }
  keepOutcome({ address, scope_id: scopeId, kind = 'manual' } = {}) {
    if (!isVersionedAddress(address) || typeof scopeId !== 'string') return { state: 'aborted' };
    const current = this.workspaceRecord(address), identity = memberIdentity(current, revisionPolicyFor(address, historyRules.records), scopeId);
    const [row] = this.workspaceTable().exec('SELECT revision_id,kind,identity FROM workspace_document_revisions WHERE address=? AND scope_id=? ORDER BY sequence DESC LIMIT 1', address, scopeId).toArray();
    return row && row.identity === identity && row.kind === kind ? { state: 'committed', result: { kept: true, revision: row.revision_id, kind, identity, owner_type: ownerTypeOf(address), scope_id: scopeId } } : { state: 'aborted' };
  }
  // The turns kept (newest first): what one admitted AI command changed, member by member, with the version before
  // and the version it left. `turn` reads one turn.
  workspaceTurns({ turn = null, limit = historyRules.turns_kept } = {}) {
    const sql = this.workspaceTable(), take = Math.max(1, Math.min(historyRules.turns_kept, Number.isInteger(limit) ? limit : historyRules.turns_kept));
    const turns = turn !== null ? [turn] : sql.exec('SELECT turn FROM workspace_revision_turns GROUP BY turn ORDER BY MAX(at) DESC, MAX(rowid) DESC LIMIT ?', take).toArray().map(row => row.turn);
    return { turns: turns.map(id => {
      const rows = sql.exec('SELECT address,scope_id,before_identity,after_identity,at,author FROM workspace_revision_turns WHERE turn=? ORDER BY address,scope_id', id).toArray();
      return rows.length ? { turn: id, at: rows.reduce((last, row) => (row.at > last ? row.at : last), ''), by: rows[0].author ?? null,
        changed: rows.map(row => ({ address: row.address, owner_type: ownerTypeOf(row.address), scope_id: row.scope_id, before_identity: row.before_identity, after_identity: row.after_identity })) } : null;
    }).filter(Boolean) };
  }
  // Puts every member one turn changed back to the version before that turn, in one write per record: a member the turn
  // made is removed, one it removed comes back. Nothing is written when any member changed since the turn (named in
  // `changed_since`) or its earlier version is no longer kept (`gone`).
  revertWorkspaceTurn({ turn } = {}, author = null) {
    if (typeof turn !== 'string' || !turn) throw Object.assign(new Error('Say which turn to put back; GET /records/turns lists them.'), { status: 400 });
    return this.transaction(() => {
      const sql = this.workspaceTable();
      const rows = sql.exec('SELECT address,scope_id,before_identity,after_identity FROM workspace_revision_turns WHERE turn=?', turn).toArray();
      if (!rows.length) throw Object.assign(new Error('That turn is not kept.'), { status: 404 });
      const changedSince = [], gone = [], next = new Map();
      for (const row of rows) {
        const policy = revisionPolicyFor(row.address, historyRules.records);
        if (!policy) { gone.push({ address: row.address, scope_id: row.scope_id }); continue; }
        if (!next.has(row.address)) next.set(row.address, this.workspaceRecord(row.address));
        const value = next.get(row.address), now = memberIdentity(value, policy, row.scope_id);
        if (now !== row.after_identity) { changedSince.push({ address: row.address, scope_id: row.scope_id, identity: now }); continue; }
        if (row.before_identity === null) { next.set(row.address, removeRevisionMember(value, policy, row.scope_id)); continue; }
        const [kept] = sql.exec('SELECT value FROM workspace_document_revisions WHERE address=? AND scope_id=? AND identity=? ORDER BY sequence DESC LIMIT 1', row.address, row.scope_id, row.before_identity).toArray();
        if (!kept) { gone.push({ address: row.address, scope_id: row.scope_id }); continue; }
        const base = value ?? (policy.collection.whole ? null : policy.collection.path.length ? null : []);
        if (base === null && !policy.collection.whole) { gone.push({ address: row.address, scope_id: row.scope_id }); continue; }
        next.set(row.address, restoreRevisionMember(base, JSON.parse(kept.value), policy, row.scope_id));
      }
      if (changedSince.length || gone.length) return { reverted: false, turn, changed_since: changedSince, gone };
      const writes = [...next].map(([address, value]) => { const stored = this.workspaceRecord(address); return { address_label: address, payload: value, expected_identity: stored === null ? null : workspaceValueIdentity(stored) }; });
      const result = this.putWorkspaceRecords(writes, { author });
      if (result.conflicts?.length) return { reverted: false, turn, conflicts: result.conflicts };
      return { reverted: true, turn, records: [...next.keys()].map(address => ({ address, owner_type: ownerTypeOf(address), members: rows.filter(row => row.address === address).map(row => row.scope_id) })) };
    });
  }
  revertOutcome({ turn } = {}) {
    const rows = typeof turn === 'string' ? this.workspaceTable().exec('SELECT address,scope_id,before_identity,after_identity FROM workspace_revision_turns WHERE turn=?', turn).toArray() : [];
    if (!rows.length) return { state: 'aborted' };
    const now = rows.map(row => memberIdentity(this.workspaceRecord(row.address), revisionPolicyFor(row.address, historyRules.records), row.scope_id));
    if (rows.every((row, at) => now[at] === row.after_identity)) return { state: 'aborted' };
    return rows.every((row, at) => now[at] === row.before_identity) ? { state: 'committed', result: { reverted: true, turn } } : { state: 'unknown' };
  }
  eraseDocument(address, expectedIdentity = undefined, scopeId = undefined) {
    assertDocumentHistoryOwner(address);
    if (scopeId !== undefined && (typeof scopeId !== 'string' || !scopeId.trim())) throw new Error('Choose a document before erasing its revisions.');
    let erased = false, replayed = false;
    this.transaction(() => {
      const sql = this.workspaceTable();
      const [stored] = sql.exec('SELECT value FROM workspace_records WHERE label=?', address).toArray();
      const currentValue = stored ? JSON.parse(stored.value) : null;
      const current = currentValue ? (scopeId === undefined ? workspaceValueIdentity(currentValue) : (revisionMember(currentValue, revisionPolicyFor(address, historyRules.records), scopeId) ? workspaceValueIdentity(revisionMember(currentValue, revisionPolicyFor(address, historyRules.records), scopeId)) : null)) : null;
      const [priorErasure] = sql.exec('SELECT erased_identity FROM workspace_document_erasures WHERE address=? AND scope_id=?', address, scopeId ?? '').toArray();
      if (!current && priorErasure && (expectedIdentity === undefined || expectedIdentity === priorErasure.erased_identity)) { erased = true; replayed = true; return; }
      if (expectedIdentity !== undefined && expectedIdentity !== current) throw new Error('The document changed before erasure. Read it again.');
      this.live.changedFor([firstAnswers.workspace_records_path], () => {
        if (scopeId !== undefined) {
          const policy = revisionPolicyFor(address, historyRules.records);
          if (!currentValue || !revisionMember(currentValue, policy, scopeId)) throw new Error('That document is already unavailable.');
          const next = removeRevisionMember(currentValue, policy, scopeId);
          const afterIdentity = next === null ? null : workspaceValueIdentity(next);
          const encoded = JSON.stringify(next), at = new Date().toISOString();
          this.commandJournal?.eraseWorkspaceDocumentCopies?.(address, scopeId, current);
          this.clearDocumentRevisions(sql, address, scopeId);
          this.clearDocumentConflicts(sql, address);
          sql.exec('INSERT INTO workspace_document_erasures(address,scope_id,erased_identity,erased_at) VALUES(?,?,?,?) ON CONFLICT(address,scope_id) DO UPDATE SET erased_identity=excluded.erased_identity,erased_at=excluded.erased_at', address, scopeId, current, at);
          if (next === null) sql.exec('DELETE FROM workspace_records WHERE label=?', address);
          else sql.exec('INSERT INTO workspace_records(label,value,written_at) VALUES(?,?,?) ON CONFLICT(label) DO UPDATE SET value=excluded.value,written_at=excluded.written_at', address, encoded, at);
          erased = true;
          return { identity: afterIdentity };
        }
        const policy = revisionPolicyFor(address, historyRules.records);
        const affectedMembers = new Map(sql.exec('SELECT scope_id,identity FROM workspace_document_revisions WHERE address=?', address).toArray().map(row => [row.scope_id, row.identity]));
        if (currentValue && policy) {
          for (const [id, member] of revisionMembers(currentValue, policy)) {
            affectedMembers.set(id, workspaceValueIdentity(member));
          }
        }
        for (const [id, identity] of affectedMembers) {
          const existing = sql.exec('SELECT erased_identity FROM workspace_document_erasures WHERE address=? AND scope_id=?', address, id).toArray()[0];
          if (!existing) sql.exec('INSERT INTO workspace_document_erasures(address,scope_id,erased_identity,erased_at) VALUES(?,?,?,?)', address, id, identity, new Date().toISOString());
          this.commandJournal?.eraseWorkspaceDocumentCopies?.(address, id, identity);
        }
        this.commandJournal?.eraseWorkspaceDocumentCopies?.(address, '', current);
        this.clearDocumentRevisions(sql, address);
        this.clearDocumentConflicts(sql, address);
        sql.exec('DELETE FROM workspace_records WHERE label=?', address);
        sql.exec("DELETE FROM workspace_document_erasures WHERE address=? AND scope_id=''", address);
        sql.exec('INSERT INTO workspace_document_erasures(address,scope_id,erased_identity,erased_at) VALUES(?,?,?,?) ON CONFLICT(address,scope_id) DO UPDATE SET erased_identity=excluded.erased_identity,erased_at=excluded.erased_at', address, '', current, new Date().toISOString());
      });
      if (scopeId === undefined) erased = Boolean(stored);
    });
    return { erased, address, ...(scopeId === undefined ? {} : { scope_id: scopeId }), ...(replayed ? { replayed: true } : {}) };
  }
  clearDocumentRevisions(sql, address, scopeId = undefined) {
    const rows = sql.exec(`SELECT scope_id,total_bytes,revision_count FROM workspace_document_revision_counters WHERE address=?${scopeId === undefined ? '' : ' AND scope_id=?'}`, ...(scopeId === undefined ? [address] : [address, scopeId])).toArray();
    const bytes = rows.reduce((sum, row) => sum + Number(row.total_bytes), 0);
    if (rows.length) sql.exec('UPDATE workspace_document_revision_budget SET total_bytes=MAX(0,total_bytes-?),total_count=MAX(0,total_count-?) WHERE id=1', bytes, rows.reduce((sum,row)=>sum+Number(row.revision_count),0));
    sql.exec(`DELETE FROM workspace_document_revisions WHERE address=?${scopeId === undefined ? '' : ' AND scope_id=?'}`, ...(scopeId === undefined ? [address] : [address, scopeId]));
    sql.exec(`DELETE FROM workspace_document_revision_counters WHERE address=?${scopeId === undefined ? '' : ' AND scope_id=?'}`, ...(scopeId === undefined ? [address] : [address, scopeId]));
    sql.exec(`DELETE FROM workspace_revision_turns WHERE address=?${scopeId === undefined ? '' : ' AND scope_id=?'}`, ...(scopeId === undefined ? [address] : [address, scopeId]));
  }
  clearDocumentConflicts(sql, address) {
    const conflicts = sql.exec("SELECT label FROM workspace_records WHERE json_extract(value,'$.address')=? AND label LIKE 'workspace-conflict:%'", address).toArray();
    for (const { label } of conflicts) {
      sql.exec('DELETE FROM workspace_records WHERE label=?', label);
      sql.exec('DELETE FROM workspace_conflict_index WHERE label=?', label);
    }
  }
  documentErasure(address, scopeId = undefined) {
    assertDocumentHistoryOwner(address);
    const sql = this.workspaceTable();
    const scoped = typeof scopeId === 'string' && scopeId.length > 0;
    const [erasure] = sql.exec('SELECT erased_identity,erased_at FROM workspace_document_erasures WHERE address=? AND scope_id=?', address, scoped ? scopeId : '').toArray();
    const [current] = sql.exec('SELECT 1 AS found FROM workspace_records WHERE label=?', address).toArray();
    const [revisions] = sql.exec(`SELECT COUNT(*) AS count FROM workspace_document_revisions WHERE address=?${scoped ? ' AND scope_id=?' : ''}`, ...(scoped ? [address, scopeId] : [address])).toArray();
    const [conflicts] = sql.exec("SELECT COUNT(*) AS count FROM workspace_records WHERE json_extract(value,'$.address')=? AND label LIKE 'workspace-conflict:%'", address).toArray();
    let memberRemaining = false;
    if (scoped && current) { const record = JSON.parse(sql.exec('SELECT value FROM workspace_records WHERE label=?', address).toArray()[0].value); memberRemaining = Boolean(revisionMember(record, revisionPolicyFor(address, historyRules.records), scopeId)); }
    const scopes = scoped ? [scopeId] : sql.exec('SELECT scope_id FROM workspace_document_erasures WHERE address=? AND scope_id<>\'\'', address).toArray().map(row => row.scope_id);
    const commandCopiesRemaining = Number(this.commandJournal?.workspaceDocumentCopiesRemaining?.(address, scoped ? scopeId : '') ?? 0);
    const capturedResultCleanupPending = Number(this.commandJournal?.workspaceDocumentResultCleanupPending?.(address, scoped ? scopeId : undefined) ?? 0);
    return { record: address, erased: Boolean(erasure), done: Boolean(erasure) && !memberRemaining && Number(revisions.count) === 0 && commandCopiesRemaining === 0 && capturedResultCleanupPending === 0 && (!scoped ? !current && Number(conflicts.count) === 0 : true), identity: erasure?.erased_identity ?? null, at: erasure?.erased_at ?? null,
      current_remaining: scoped ? memberRemaining : Boolean(current), revisions_remaining: Number(revisions.count), conflicts_remaining: scoped ? 0 : Number(conflicts.count), command_copies_remaining: commandCopiesRemaining, captured_result_cleanup_pending: capturedResultCleanupPending, ...(scoped ? { scope_id: scopeId } : {}) };
  }
  adjustRevisionBudget(sql, deletedRows) {
    const totals = new Map();
    let bytes = 0;
    for (const row of deletedRows) {
      const size = Number(row.bytes);
      bytes += size;
      const key = JSON.stringify([row.address, row.scope_id]);
      const current = totals.get(key) ?? { address: row.address, scope_id: row.scope_id, bytes: 0, count: 0 };
      current.bytes += size; current.count += 1; totals.set(key, current);
    }
    if (!bytes) return;
    for (const row of totals.values()) sql.exec('UPDATE workspace_document_revision_counters SET revision_count=MAX(0,revision_count-?),total_bytes=MAX(0,total_bytes-?) WHERE address=? AND scope_id=?', row.count, row.bytes, row.address, row.scope_id);
    sql.exec('UPDATE workspace_document_revision_budget SET total_bytes=MAX(0,total_bytes-?),total_count=MAX(0,total_count-?) WHERE id=1', bytes, deletedRows.length);
  }
  // Keeps `value` as the member's newest version of `kind`; answers its revision id (null when none was kept). A value
  // equal to the newest version is not kept twice: asking to keep it as a never-pruned kind marks that version so.
  keepDocumentRevision(sql, address, scopeId, value, writtenAt, author, kind = historyRules.default_kind) {
    if (!isVersionedAddress(address) || value === undefined || value === null) return null;
    if (!Object.hasOwn(KINDS, kind)) throw new Error(`Versions are kept as ${Object.keys(KINDS).join(', ')}.`);
    const policy = revisionPolicyFor(address, historyRules.records), keep = keepOf(policy, kind);
    const identity = workspaceValueIdentity(value), encoded = JSON.stringify(value);
    const bytes = new TextEncoder().encode(encoded).byteLength;
    const [latest] = sql.exec('SELECT revision_id,identity,kind FROM workspace_document_revisions WHERE address=? AND scope_id=? ORDER BY sequence DESC LIMIT 1', address, scopeId).toArray();
    if (latest?.identity === identity) {
      if (keep === null && latest.kind !== kind) sql.exec('UPDATE workspace_document_revisions SET kind=? WHERE revision_id=?', kind, latest.revision_id);
      return latest.revision_id;
    }
    sql.exec('INSERT OR IGNORE INTO workspace_document_revision_counters(address,scope_id,revision_count,total_bytes,next_sequence) VALUES(?,?,0,0,1)', address, scopeId);
    let usage = sql.exec('SELECT total_bytes,total_count FROM workspace_document_revision_budget WHERE id=1').toArray()[0];
    if (!usage) {
      // The budget row is written with its table; a store stopped between the two gets it here, on its first save.
      sql.exec('INSERT OR IGNORE INTO workspace_document_revision_budget(id,total_bytes,total_count) VALUES(1,0,0)');
      usage = { total_bytes: 0, total_count: 0 };
    }
    if (bytes <= DOCUMENT_REVISION_BYTES && (Number(usage.total_bytes)+bytes > DOCUMENT_REVISION_BYTES || Number(usage.total_count)+1 > historyRules.max_total_revisions)) {
      // Never-pruned kinds are never evicted for room.
      const oldest = sql.exec('SELECT revision_id,address,scope_id,length(CAST(value AS BLOB)) AS bytes FROM workspace_document_revisions WHERE kind NOT IN (SELECT value FROM json_each(?)) ORDER BY written_at,revision_id LIMIT ?', PINNED_KINDS, historyRules.max_evictions_per_save).toArray();
      const removed = [];
      for (const row of oldest) {
        if (Number(usage.total_bytes)+bytes <= DOCUMENT_REVISION_BYTES && Number(usage.total_count)+1 <= historyRules.max_total_revisions) break;
        sql.exec('DELETE FROM workspace_document_revisions WHERE revision_id=?', row.revision_id);
        usage = {total_bytes:Number(usage.total_bytes)-Number(row.bytes),total_count:Number(usage.total_count)-1};
        removed.push(row);
      }
      this.adjustRevisionBudget(sql, removed);
    }
    if (bytes > DOCUMENT_REVISION_BYTES || Number(usage.total_bytes)+bytes > DOCUMENT_REVISION_BYTES || Number(usage.total_count)+1 > historyRules.max_total_revisions) {
      // A version asked to be kept for good is refused rather than silently left out.
      if (keep === null) throw Object.assign(new Error('There is no room to keep this version. Remove versions you kept before, then keep it again.'), { status: 409 });
      sql.exec('UPDATE workspace_document_revision_counters SET omitted_at=? WHERE address=? AND scope_id=?', writtenAt, address, scopeId);
      return null; // Retention pressure must never reject the authored document save.
    }
    const [counter] = sql.exec('SELECT next_sequence FROM workspace_document_revision_counters WHERE address=? AND scope_id=?', address, scopeId).toArray();
    const sequence = Number(counter.next_sequence), revisionId = workspaceValueIdentity({ address, scopeId, identity, sequence });
    sql.exec('INSERT INTO workspace_document_revisions(revision_id,address,scope_id,identity,value,written_at,author,sequence,kind) VALUES(?,?,?,?,?,?,?,?,?)', revisionId, address, scopeId, identity, encoded, writtenAt, author ?? null, sequence, kind);
    sql.exec('UPDATE workspace_document_revision_counters SET revision_count=revision_count+1,total_bytes=total_bytes+?,next_sequence=next_sequence+1 WHERE address=? AND scope_id=?', bytes, address, scopeId);
    sql.exec('UPDATE workspace_document_revision_budget SET total_bytes=total_bytes+?,total_count=total_count+1 WHERE id=1', bytes);
    // Each kind keeps its own newest `keep` versions of this member.
    if (keep !== null) {
      const countEvicted = sql.exec('DELETE FROM workspace_document_revisions WHERE address=? AND scope_id=? AND kind=? AND sequence NOT IN (SELECT sequence FROM workspace_document_revisions WHERE address=? AND scope_id=? AND kind=? ORDER BY sequence DESC LIMIT ?) RETURNING address,scope_id,length(CAST(value AS BLOB)) AS bytes', address, scopeId, kind, address, scopeId, kind, keep).toArray();
      this.adjustRevisionBudget(sql, countEvicted);
    }
    return revisionId;
  }
  // writing ({ kind, turn }): the kind the new versions are kept as and, for a road that keeps turns, the turn they are
  // part of. The version before a change is kept as the default kind (it is what was there before the writer came).
  captureChangedDocumentMembers(sql, address, before, after, beforeAt, afterAt, author, writing = { kind: historyRules.default_kind, turn: null }) {
    const policy = revisionPolicyFor(address, historyRules.records);
    if (!policy) return;
    const oldMembers = before ? revisionMembers(before, policy) : new Map();
    const newMembers = after ? revisionMembers(after, policy) : new Map();
    const ids = new Set([...oldMembers.keys(), ...newMembers.keys()]);
    for (const id of ids) {
      const oldMember = oldMembers.get(id), newMember = newMembers.get(id);
      if (oldMember && (!newMember || workspaceValueIdentity(oldMember) !== workspaceValueIdentity(newMember))) {
        const tombstone = sql.exec('SELECT erased_identity FROM workspace_document_erasures WHERE address=? AND scope_id=?', address, id).toArray()[0];
        if (tombstone) continue;
        this.keepDocumentRevision(sql, address, id, oldMember, beforeAt, null);
      }
      if (newMember && (!oldMember || workspaceValueIdentity(oldMember) !== workspaceValueIdentity(newMember))) {
        const tombstone = sql.exec('SELECT erased_identity FROM workspace_document_erasures WHERE address=? AND scope_id=?', address, id).toArray()[0];
        if (tombstone) throw new Error('This erased document version cannot be restored by a delayed save.');
        this.keepDocumentRevision(sql, address, id, newMember, afterAt, author, writing.kind);
      }
      if (writing.turn && (!oldMember || !newMember || workspaceValueIdentity(oldMember) !== workspaceValueIdentity(newMember))) this.noteTurnChange(sql, writing.turn, address, id, oldMember, newMember, afterAt, author);
    }
  }
  // One member a turn changed: the version before its first change in that turn and the one its last change left.
  noteTurnChange(sql, turn, address, scopeId, oldMember, newMember, at, author) {
    sql.exec('INSERT INTO workspace_revision_turns(turn,address,scope_id,before_identity,after_identity,at,author) VALUES(?,?,?,?,?,?,?) ON CONFLICT(turn,address,scope_id) DO UPDATE SET after_identity=excluded.after_identity,at=excluded.at',
      turn, address, scopeId, oldMember ? workspaceValueIdentity(oldMember) : null, newMember ? workspaceValueIdentity(newMember) : null, at, author ?? null);
    sql.exec('DELETE FROM workspace_revision_turns WHERE turn NOT IN (SELECT turn FROM workspace_revision_turns GROUP BY turn ORDER BY MAX(at) DESC, MAX(rowid) DESC LIMIT ?)', historyRules.turns_kept);
  }
  assertNoErasedDocumentReplay(sql, address, value) {
    if (!isVersionedAddress(address)) return;
    const full = sql.exec("SELECT erased_identity FROM workspace_document_erasures WHERE address=? AND scope_id=''", address).toArray()[0];
    if (full) throw new Error('This erased document version cannot be restored by a delayed save.');
    if (!value) return;
    const policy = revisionPolicyFor(address, historyRules.records);
    const members = revisionMembers(value, policy);
    for (const [scopeId, member] of members) {
      const erased = sql.exec('SELECT erased_identity FROM workspace_document_erasures WHERE address=? AND scope_id=?', address, scopeId).toArray()[0];
      if (erased) throw new Error('This erased document version cannot be restored by a delayed save.');
    }
  }
  // A document edited as operations (src/workspace/document-operations.mjs) is one saved record under
  // `document-operations:<address>`: { schema_version, version, base_identity, document, log, batches, kept_after }.
  // `base_identity` names the file version the document was opened from; `log` keeps the last operations (log_ops) so
  // a copy at an older version catches up by operations, and a copy older than `kept_after` is sent the whole
  // document. Each batch is applied in the order this store receives it and written with the record's expected
  // identity: a writer that lost that compare reads the newer record and applies its batch to it again, so no batch
  // is lost or applied to a stale document. A batch id seen before answers what it did instead of applying twice.
  documentOperationsLabel(address) {
    if (typeof address !== 'string' || !address || address.length > DOCUMENT_LIMITS.address_chars || !/^[A-Za-z0-9:._~/-]+$/.test(address)) throw Object.assign(new Error('Choose the document whose operations to use.'), { status: 400 });
    return DOCUMENT_OPERATIONS_LABEL_PREFIX + address;
  }
  documentOperationsReply(record, since, extra = {}) {
    const caughtUp = Number.isSafeInteger(since) && since >= record.kept_after && since <= record.version;
    return { found: true, schema_version: record.schema_version, version: record.version, base_identity: record.base_identity, ...extra,
      ...(caughtUp ? { committed: record.log.filter(entry => entry.version > since).map(({ version, actor, by, ops }) => ({ version, actor, by, ops })) } : { document: record.document }) };
  }
  storedDocumentOperations(label) {
    const [row] = this.workspaceTable().exec('SELECT value FROM workspace_records WHERE label=?', label).toArray();
    if (!row) return null;
    const record = JSON.parse(row.value);
    openDocument(record.document);
    return record;
  }
  readDocumentOperations({ address, since = null } = {}) {
    const record = this.storedDocumentOperations(this.documentOperationsLabel(address));
    return record ? this.documentOperationsReply(record, since) : { found: false };
  }
  // A new record needs room: idle documents (no write for idle_evict_hours) are dropped oldest first; none idle refuses.
  makeRoomForDocumentOperations(sql) {
    const rows = sql.exec('SELECT label, written_at FROM workspace_records WHERE substr(label,1,length(?))=? ORDER BY written_at', DOCUMENT_OPERATIONS_LABEL_PREFIX, DOCUMENT_OPERATIONS_LABEL_PREFIX).toArray();
    const idleBefore = Date.now() - DOCUMENT_LIMITS.idle_evict_hours * 3600000;
    const evict = rows.filter(row => Date.parse(row.written_at) < idleBefore).slice(0, Math.max(0, rows.length - DOCUMENT_LIMITS.open_documents + 1));
    if (rows.length - evict.length >= DOCUMENT_LIMITS.open_documents) throw new DocumentOperationError('too_many_open', `At most ${DOCUMENT_LIMITS.open_documents} documents are edited together. Finish editing one first.`, 409);
    if (evict.length) this.live.changedFor([firstAnswers.workspace_records_path], () => { for (const row of evict) sql.exec('DELETE FROM workspace_records WHERE label=?', row.label); });
  }
  commitDocumentBatch(input, author, makeOps) {
    return this.transaction(() => this.commitDocumentBatchInTransaction(input, author, makeOps));
  }
  commitDocumentBatchInTransaction(input, author, makeOps) {
    const label = this.documentOperationsLabel(input?.address);
    const { batch_id: batchId, actor, base_version: baseVersion, base_identity: baseIdentity } = input ?? {};
    if (typeof batchId !== 'string' || !batchId || batchId.length > DOCUMENT_LIMITS.batch_id_chars) throw new DocumentOperationError('batch_invalid', 'Each batch carries its own id.');
    if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) throw new DocumentOperationError('batch_invalid', 'Each batch names the version it was made against.');
    if (typeof baseIdentity !== 'string' || !baseIdentity) throw new DocumentOperationError('batch_invalid', 'Each batch names the file version the document was opened from.');
    for (let attempt = 0; attempt < DOCUMENT_LIMITS.apply_attempts; attempt += 1) {
      const sql = this.workspaceTable();
      const [row] = sql.exec('SELECT value FROM workspace_records WHERE label=?', label).toArray();
      const stored = row ? JSON.parse(row.value) : null;
      if (stored) openDocument(stored.document);
      if (stored && stored.base_identity !== baseIdentity) throw Object.assign(new DocumentOperationError('base_changed', 'This document was opened again from a newer saved version. Open the latest version.', 409), { base_identity: stored.base_identity });
      if (stored?.batches.some(batch => batch.batch_id === batchId)) return this.documentOperationsReply(stored, baseVersion, { applied: true, replayed: true });
      if (stored && baseVersion > stored.version) throw new DocumentOperationError('batch_invalid', 'That version of this document was never kept.', 409);
      if (!stored && !Array.isArray(input.seed)) throw new DocumentOperationError('document_missing', 'This document is not open for editing. Send its blocks to open it.', 404);
      if (!stored) this.makeRoomForDocumentOperations(sql);
      const record = stored ?? { schema_version: DOCUMENT_SCHEMA_VERSION, version: 0, base_identity: baseIdentity, document: documentFromBlocks(input.seed), log: [], batches: [], kept_after: 0 };
      const made = makeOps(record);
      if (!made) return this.documentOperationsReply(record, baseVersion, { applied: false, nothing_to_undo: true });
      const result = applyOperations(record.document, made.ops, { actor });
      const version = record.version + 1;
      const log = [...record.log.map(entry => entry.batch_id === made.undoes ? { ...entry, undone: batchId } : entry),
        { version, batch_id: batchId, actor, by: author, ops: result.applied, inverse: result.inverse, ...(made.undoes ? { undo_of: made.undoes } : {}) }];
      let kept = log, keptAfter = record.kept_after;
      while (kept.reduce((sum, entry) => sum + entry.ops.length, 0) > DOCUMENT_LIMITS.log_ops && kept.length > 1) { keptAfter = kept[0].version; kept = kept.slice(1); }
      const next = { schema_version: DOCUMENT_SCHEMA_VERSION, version, base_identity: record.base_identity, document: result.document, log: kept,
        batches: [...record.batches, { batch_id: batchId, version }].slice(-DOCUMENT_LIMITS.batches_kept), kept_after: keptAfter };
      const written = this.live.changedFor([firstAnswers.workspace_records_path], () => this.putWorkspaceRecords([{ address_label: label, payload: next, expected_identity: stored ? workspaceValueIdentity(stored) : null }], { conflictPolicy: 'retry', author }));
      if (written.written === 1) return this.documentOperationsReply(next, baseVersion, { applied: true, ...(made.undoes ? { undid: made.undoes } : {}) });
    }
    throw new DocumentOperationError('busy', 'This document kept changing while the edit was saved. Send it again.', 409);
  }
  applyDocumentOperations(input, author = null) {
    return this.commitDocumentBatch(input, author, () => ({ ops: input.ops }));
  }
  // Undo for one person (an AI's key or a person's sign-in): their newest batch still in the log that is neither undone
  // nor itself an undo, inverted against the current document; the inverse's guards leave anyone else's later change.
  undoDocumentOperations(input, author = null) {
    if (typeof author !== 'string' || !author) throw new DocumentOperationError('author_missing', 'Undo needs to know whose edits to take back.', 403);
    return this.commitDocumentBatch(input, author, record => {
      const target = record.log.findLast(entry => entry.by === author && !entry.undone && !entry.undo_of && entry.inverse.length);
      return target ? { ops: stampOperations(record.document, [...target.inverse].reverse(), input.actor), undoes: target.batch_id } : null;
    });
  }
  removeDocumentOperations({ address, expected_version: expectedVersion } = {}) {
    const label = this.documentOperationsLabel(address);
    let removed = false;
    this.transaction(() => {
      const record = this.storedDocumentOperations(label);
      if (!record) return;
      if (expectedVersion !== record.version) throw Object.assign(new DocumentOperationError('version_changed', 'This document changed after the version you saved. It stays open for the people still editing it.', 409), { version: record.version });
      this.live.changedFor([firstAnswers.workspace_records_path], () => this.workspaceTable().exec('DELETE FROM workspace_records WHERE label=?', label));
      removed = true;
    });
    return { removed, address };
  }
  // What a lost batch did (its readback; reads only): its id kept with the document is the batch; no record or no id
  // means it was never applied.
  documentOperationsOutcome(input) {
    let label;
    try { label = this.documentOperationsLabel(input?.address); } catch { return { state: 'aborted' }; }
    const record = this.storedDocumentOperations(label);
    if (!record || !record.batches.some(batch => batch.batch_id === input.batch_id)) return { state: 'aborted' };
    return { state: 'committed', result: this.documentOperationsReply(record, input.base_version, { applied: true, replayed: true }) };
  }
  // One generic synchronous read/modify/write for a workspace value. The transform runs against the owner’s current
  // bytes inside the storage transaction, so overlapping callers cannot replace a newer aggregate with an old snapshot.
  updateWorkspaceRecord(label, update) {
    if (typeof label !== 'string' || !label || label.length > WORKSPACE_LIMITS.label_chars || label.startsWith('workspace-conflict:')) throw new Error('The workspace record address is not valid.');
    if (typeof update !== 'function') throw new Error('A workspace record update needs a synchronous change.');
    let result;
    this.transaction(() => {
      const sql = this.workspaceTable();
      const [stored] = sql.exec('SELECT value FROM workspace_records WHERE label = ?', label).toArray();
      const before = stored ? JSON.parse(stored.value) : null;
      const value = update(before);
      if (value && typeof value.then === 'function') throw new Error('A workspace record change must finish synchronously.');
      const encoded = JSON.stringify(value);
      if (encoded === undefined || encoded.length > WORKSPACE_LIMITS.value_chars) throw new Error(`The record ${label} is larger than this workspace keeps.`);
      if (stored?.value === encoded) { result = { before, value, written: false }; return; }
      this.putWorkspaceRecords([{ address_label: label, payload: value }]);
      result = { before, value, written: true };
    });
    return result;
  }
  putWorkspaceRecords(writes, { conflictPolicy = 'preserve', ownerCapability = null, author = null } = {}) {
    if (!['preserve', 'retry'].includes(conflictPolicy)) throw new Error('The workspace conflict policy is not valid.');
    if (!Array.isArray(writes) || !writes.length || writes.length > WORKSPACE_LIMITS.writes) throw new Error(`Send between 1 and ${WORKSPACE_LIMITS.writes} records at a time.`);
    const rows = writes.map(write => {
      const label = write?.address_label;
      if (typeof label !== 'string' || !label || label.length > WORKSPACE_LIMITS.label_chars) throw new Error('Each record needs its address label.');
      if (label.startsWith('workspace-conflict:')) throw new Error('Workspace conflict rows are changed through their resolver.');
      const value = JSON.stringify(write.payload ?? null);
      if (value.length > WORKSPACE_LIMITS.value_chars) throw new Error(`The record ${label} is larger than this workspace keeps.`);
      if (write.expected_identity !== undefined && write.expected_identity !== null && typeof write.expected_identity !== 'string') throw new Error('The expected record identity is not valid.');
      if (write.scope_id !== undefined && (typeof write.scope_id !== 'string' || !write.scope_id.trim() || write.scope_id.length > WORKSPACE_LIMITS.label_chars)) throw new Error('The document scope is not valid.');
      return { label, value, expectedIdentity: write.expected_identity, scopeId: write.scope_id };
    });
    const sql = this.workspaceTable();
    const known = new Set(sql.exec('SELECT label FROM workspace_records').toArray().map(row => row.label));
    if (new Set([...known, ...rows.map(row => row.label)]).size > WORKSPACE_LIMITS.labels) throw new Error('This workspace keeps no more records.');
    const at = new Date().toISOString();
    const acting = this.actor();
    const writer = author ?? acting?.author ?? null, writing = writingOf(acting);
    // A value written again unchanged changes no row, so it moves no screen revision.
    const put = ({ label, value, scopeId }) => {
      const [stored] = sql.exec('SELECT value,written_at FROM workspace_records WHERE label=?', label).toArray();
      const nextValue = JSON.parse(value);
      if (isVersionedAddress(label) && scopeId) {
        const policy = revisionPolicyFor(label, historyRules.records);
        const beforeValue = stored ? JSON.parse(stored.value) : null;
        const beforeMember = beforeValue ? revisionMember(beforeValue, policy, scopeId) : null;
        const afterMember = revisionMember(nextValue, policy, scopeId);
        if (!beforeMember && !afterMember) throw new Error('The write scope does not identify a member of this document.');
      }
      if (isVersionedAddress(label) && stored && stored.value !== value) {
        const erased = sql.exec("SELECT erased_identity FROM workspace_document_erasures WHERE address=? AND scope_id=''", label).toArray()[0];
        if (erased) throw new Error('This erased document version cannot be restored by a delayed save.');
        this.captureChangedDocumentMembers(sql, label, JSON.parse(stored.value), nextValue, stored.written_at, at, writer, writing);
      } else if (isVersionedAddress(label) && !stored) {
        const erased = sql.exec("SELECT erased_identity FROM workspace_document_erasures WHERE address=? AND scope_id=''", label).toArray()[0];
        if (erased) throw new Error('This erased document version cannot be restored by a delayed save.');
        this.captureChangedDocumentMembers(sql, label, null, nextValue, null, at, writer, writing);
      }
      sql.exec('INSERT INTO workspace_records (label, value, written_at) VALUES (?, ?, ?) ON CONFLICT(label) DO UPDATE SET value = excluded.value, written_at = excluded.written_at WHERE workspace_records.value <> excluded.value', label, value, at);
      return scopeId;
    };
    const conflicts = [];
    const retryConflicts = [];
    const conflictRows = [];
    const queuedConflictLabels = new Set();
    let refused = false;
    const [heldClock] = sql.exec('SELECT wall_ms, logical, device_id FROM workspace_hybrid_clock WHERE id = 1').toArray();
    let nextClock = heldClock ?? null;
    for (const row of rows) {
      if (row.expectedIdentity === undefined) continue;
      const [stored] = sql.exec('SELECT value FROM workspace_records WHERE label = ?', row.label).toArray();
      const currentFound = Boolean(stored);
      const currentValue = currentFound ? JSON.parse(stored.value) : undefined;
      const currentIdentity = currentFound ? workspaceValueIdentity(currentValue) : null;
      if (currentIdentity === row.expectedIdentity) continue;
      // A retry after the competing value already won is idempotent: it must not manufacture a conflict with itself.
      if (currentFound && stored.value === row.value) continue;
      // Automatic append callers retain their identified item and reread the winner. Their retry is not an
      // unresolved human editing fork; preserving that stale candidate would offer a later way to drop events.
      if (conflictPolicy === 'retry') {
        retryConflicts.push({ address: row.label, current: { found: currentFound, identity: currentIdentity ?? 'missing', ...(currentFound ? { value: currentValue } : {}) } });
        refused = true;
        continue;
      }
      this.assertNoErasedDocumentReplay(sql, row.label, JSON.parse(row.value));
      const conflict = makeWorkspaceConflict({ address: row.label, currentFound, currentValue, incomingValue: JSON.parse(row.value), expectedIdentity: row.expectedIdentity, clock: { wall_ms: 0, logical: 0, device_id: 'person-store' } });
      const label = workspaceConflictLabel(conflict.id);
      const [prior] = sql.exec('SELECT value FROM workspace_records WHERE label = ?', label).toArray();
      // Preserve first-seen clock and resolution if an at-least-once retry repeats the same fork.
      if (!prior) {
        if (!queuedConflictLabels.has(label)) {
          if (new Set([...known, ...queuedConflictLabels, label]).size > WORKSPACE_LIMITS.labels) throw new Error('This workspace keeps no more records.');
          conflict.clock = tickHybridClock(nextClock, null, Date.now());
          nextClock = conflict.clock;
          const value = JSON.stringify(conflict);
          if (new TextEncoder().encode(value).byteLength > WORKSPACE_LIMITS.value_chars * 4 + 8192) throw new Error('The two workspace versions are too large to keep together.');
          conflictRows.push({ label, value });
          queuedConflictLabels.add(label);
        }
      } else {
        const previous = JSON.parse(prior.value);
        conflicts.push(previous);
        // The same pair can fork again after someone settled it. Reopen its deterministic row with a later HLC;
        // repeated delivery while open then leaves that new occurrence unchanged.
        if (previous.state === 'resolved') {
          conflict.clock = tickHybridClock(nextClock, previous.clock, Date.now());
          nextClock = conflict.clock;
          const value = JSON.stringify(conflict);
          if (new TextEncoder().encode(value).byteLength > WORKSPACE_LIMITS.value_chars * 4 + 8192) throw new Error('The two workspace versions are too large to keep together.');
          conflictRows.push({ label, value, replace: true });
        }
      }
      if (!prior) conflicts.push(conflict);
      refused = true;
    }
    if (refused) {
      if (conflictPolicy === 'retry') return { written: 0, conflicts: retryConflicts };
      if (conflictRows.length) this.live.changedFor([firstAnswers.workspace_records_path], () => {
        for (const row of conflictRows) {
          const conflict = JSON.parse(row.value);
          sql.exec('INSERT INTO workspace_hybrid_clock (id, wall_ms, logical, device_id) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET wall_ms = excluded.wall_ms, logical = excluded.logical, device_id = excluded.device_id', conflict.clock.wall_ms, conflict.clock.logical, conflict.clock.device_id);
          if (row.replace) sql.exec('UPDATE workspace_records SET value = ?, written_at = ? WHERE label = ?', row.value, at, row.label);
          else sql.exec('INSERT INTO workspace_records (label, value, written_at) VALUES (?, ?, ?)', row.label, row.value, at);
          this.indexWorkspaceConflict(conflict);
        }
      });
      const unique = new Map(conflicts.map(conflict => [conflict.id, conflict]));
      for (const row of conflictRows) { const conflict = JSON.parse(row.value); unique.set(conflict.id, conflict); }
      return { written: 0, conflicts: [...unique.values()].map(conflict => {
        const current = conflict.branches.find(branch => branch.identity === conflict.current_identity);
        return { id: conflict.id, address: conflict.address, current: current ?? { found: false, identity: 'missing' } };
      }) };
    }
    const shownOnlyInRecords = new Set(WORKSPACE_LIMITS.shown_only_in_records.labels);
    for (const row of rows) {
      if (shownOnlyInRecords.has(row.label)) this.live.changedFor([firstAnswers.workspace_records_path], () => put(row));
      else put(row);
    }
    this.written?.(rows.map(row => row.label));
    return { written: rows.length };
  }

  resolveWorkspaceConflict(id, branchIdentity, ownerCapability = null, expected = null, author = null) {
    if (typeof id !== 'string' || !id || typeof branchIdentity !== 'string') throw new Error('Choose a kept version of this workspace record.');
    const sql = this.workspaceTable();
    const conflictLabel = workspaceConflictLabel(id);
    const [row] = sql.exec('SELECT value FROM workspace_records WHERE label = ?', conflictLabel).toArray();
    if (!row) throw new Error('Those workspace versions are no longer open.');
    const conflict = JSON.parse(row.value);
    if (conflict.state !== 'open') throw new Error('Those workspace versions are no longer open.');
    if (ownerCapability === SHOW_RULES_OWNER_CAPABILITY && conflict.address !== 'show-rules') throw new Error('The show-rule resolver only handles show-rule versions.');
    if (ownerCapability === SHOW_RULES_OWNER_CAPABILITY) {
      if (!expected || workspaceValueIdentity(conflict) !== expected.conflict_identity) throw new Error('The saved show-rule conflict changed. Read it again before resolving.');
    }
    const branch = conflict.branches.find(candidate => candidate.identity === branchIdentity);
    if (!branch) throw new Error('Choose one of the kept versions.');
    const [current] = sql.exec('SELECT value,written_at FROM workspace_records WHERE label = ?', conflict.address).toArray();
    const currentFound = Boolean(current);
    const currentValue = currentFound ? JSON.parse(current.value) : undefined;
    const currentIdentity = currentFound ? workspaceValueIdentity(currentValue) : null;
    if (ownerCapability === SHOW_RULES_OWNER_CAPABILITY && currentIdentity !== expected.current_identity) throw new Error('The current show-rules record changed. Read it again before resolving.');
    const original = conflict.branches.find(candidate => candidate.identity !== branchIdentity);
    const originalIdentity = original?.found ? original.identity : null;
    const selectedIdentity = branch.found ? branch.identity : null;
    const isSelectedCurrent = currentIdentity === selectedIdentity;
    if (!isSelectedCurrent && currentIdentity !== originalIdentity) {
      const [held] = sql.exec('SELECT wall_ms, logical, device_id FROM workspace_hybrid_clock WHERE id = 1').toArray();
      const newer = makeWorkspaceConflict({ address: conflict.address, currentFound, currentValue, incomingFound: branch.found, incomingValue: branch.value, expectedIdentity: originalIdentity, clock: { wall_ms: 0, logical: 0, device_id: 'person-store' } });
      const newerLabel = workspaceConflictLabel(newer.id);
      const [alreadyKept] = sql.exec('SELECT label FROM workspace_records WHERE label = ?', newerLabel).toArray();
      if (alreadyKept) return { resolved: false, conflict_id: newer.id };
      const clock = tickHybridClock(held ?? null, conflict.clock, Date.now());
      newer.clock = clock;
      const encoded = JSON.stringify(newer);
      if (new TextEncoder().encode(encoded).byteLength > WORKSPACE_LIMITS.value_chars * 4 + 8192) throw new Error('The two workspace versions are too large to keep together.');
      const known = new Set(sql.exec('SELECT label FROM workspace_records').toArray().map(record => record.label));
      if (!known.has(newerLabel) && known.size >= WORKSPACE_LIMITS.labels) throw new Error('This workspace keeps no more records.');
      this.live.changedFor([firstAnswers.workspace_records_path], () => {
        sql.exec('INSERT INTO workspace_hybrid_clock (id, wall_ms, logical, device_id) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET wall_ms = excluded.wall_ms, logical = excluded.logical, device_id = excluded.device_id', clock.wall_ms, clock.logical, clock.device_id);
        sql.exec('INSERT INTO workspace_records (label, value, written_at) VALUES (?, ?, ?) ON CONFLICT(label) DO NOTHING', newerLabel, encoded, new Date().toISOString());
        this.indexWorkspaceConflict(newer);
      });
      return { resolved: false, conflict_id: newer.id };
    }
    this.live.changedFor([firstAnswers.workspace_records_path], () => {
      const resolvedAt = new Date().toISOString();
      if (isVersionedAddress(conflict.address) && currentFound && (!branch.found || workspaceValueIdentity(currentValue) !== branch.identity)) this.captureChangedDocumentMembers(sql, conflict.address, currentValue, branch.found ? branch.value : null, current.written_at, resolvedAt, author);
      if (branch.found && !isSelectedCurrent) {
        sql.exec('INSERT INTO workspace_records (label, value, written_at) VALUES (?, ?, ?) ON CONFLICT(label) DO UPDATE SET value = excluded.value, written_at = excluded.written_at', conflict.address, JSON.stringify(branch.value), new Date().toISOString());
      } else if (!branch.found) {
        sql.exec('DELETE FROM workspace_records WHERE label = ?', conflict.address);
      }
      conflict.state = 'resolved';
      conflict.resolution = { branch_identity: branchIdentity, at: new Date().toISOString() };
      sql.exec('UPDATE workspace_records SET value = ?, written_at = ? WHERE label = ?', JSON.stringify(conflict), new Date().toISOString(), conflictLabel);
      this.indexWorkspaceConflict(conflict);
    });
    return { resolved: true, address: conflict.address, kept: branchIdentity };
  }

}

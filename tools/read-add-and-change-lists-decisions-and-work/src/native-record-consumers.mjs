// Compatibility operations used by account record/list/decision/work screens.
// The supplied EEAF and domain owners are already bound to one addressed
// resource; this adapter never looks up or forwards to PersonStore.
import { aggregateRows } from '../../query-and-change-list-rows/src/list-aggregates.mjs';
import { documentsFolderOf, readDocumentTypes, saveDocumentTypes } from '../../documents-as-list-rows/read-data/document-properties.mjs';
import { exportListFiles, importListFiles } from '../../query-and-change-list-rows/src/list-plain-files.mjs';
import { backlinks, duplicateRows, fileReferences, joinAnswers, mergeRows, planRowRequest, resolveRows, rewriteFileNames, withDangling } from '../../query-and-change-list-rows/src/list-row-operations.mjs';
import { readSnapshot, snapshotPages, takeSnapshot } from '../../query-and-change-list-rows/src/list-snapshots.mjs';
import { coldRows, reviewRows, rowsNeedingReview } from '../../review-what-a-list-says/read-data/list-review.mjs';
import { withRollups } from '../../query-and-change-list-rows/src/list-rollups.mjs';
import { makeLists, viewsWithParameters } from '../../keep-lists-of-rows/lists.mjs';
import { INTRODUCTION_REFUSED, isIntroduction, withProposerNames } from './ais.mjs';

// The writes whose whole effect is one synchronous write, kept with their reply under the command's receipt once their
// rights are checked (receipted: src/standalone-resource-behavior.mjs, src/behavior-command-readbacks.json receipted_here).
export const RECORD_CONSUMER_RECEIPTED_OPERATIONS = Object.freeze(['decisions:write', 'ais:introduce', 'ais:fromCard']);
// The list writes, each kept with its reply under the command's receipt: a write that stays in the account's own records
// is one synchronous write committed with it (lists localWrite); any other is begun before it runs and its reply kept as
// its last step (begin), so a lost one with no mark wrote nothing.
export const RECORD_CONSUMER_LIST_WRITES = Object.freeze(['lists:put', 'lists:ensure', 'lists:putRows', 'lists:saveView', 'lists:removeView', 'lists:saveFilter', 'lists:removeFilter', 'lists:moveRow', 'lists:mergeRows', 'lists:duplicateRows', 'lists:make', 'lists:publishRows',
  'lists:restoreRows', 'lists:moveView', 'lists:snapshot', 'lists:rewriteFileNames', 'lists:review', 'lists:noteUse', 'lists:proposeChanges', 'lists:decideProposal',
  'lists:saveDocumentTypes', 'lists:exportFiles', 'lists:importFiles']);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const plain = value => JSON.parse(JSON.stringify(value));
const bounded = (value, name, max = 100) => {
  const n = value ?? max;
  if (!Number.isInteger(n) || n < 1 || n > max) throw fail(`${name} must be between 1 and ${max}.`);
  return n;
};

/**
 * Create direct compatibility operations from canonical native owners.
 * `eeaf`, `decisions`, `source`, `lists`, and `work` must all belong to the
 * same already-authorized resource incarnation. `authorize` is called for
 * every operation, including reads and continuation pages.
 */
export function nativeRecordConsumers({ eeaf, decisions, source, lists, listStores = null, publishListRows = null, rowsFiling = () => null, work, ais, views = null, evaluateBinding = null, files = null, authorize = () => {}, actor = 'native-resource', via = () => null, receipted = (_operation, write) => write(), begin = () => {} } = {}) {
  if (!eeaf?.read || !eeaf?.ids || !eeaf?.write || !decisions?.read || !source?.decision)
    throw new TypeError('A resource EEAF, decision store and source authority are required.');
  const listOwner = lists ?? makeLists({ eeaf });
  const withRights = async (operation, input, run) => { await authorize(operation, input); return RECORD_CONSUMER_RECEIPTED_OPERATIONS.includes(operation) ? receipted(operation, run) : run(); };
  const recordRead = input => {
    if (typeof input.id !== 'string' || !input.id) throw fail('A record id is required.');
    return eeaf.read(input.id) ?? null;
  };
  const recordList = input => {
    const type = input.type;
    if (typeof type !== 'string' || !type) throw fail('A record type is required.');
    const limit = bounded(input.limit, 'limit');
    const ids = eeaf.ids(type, { ...(input.after ? { after: input.after } : {}), limit: limit + 1 });
    const page = ids.slice(0, limit);
    return { records: page.map(id => ({ id, type: eeaf.typeOf?.(id) ?? type, value: eeaf.read(id) })).filter(row => row.value !== null),
      next: ids.length > limit ? page.at(-1) : null };
  };
  // Who asked (`by`) and the road it came by (`via`, src/write-via.mjs), kept once per change in the log's actor context.
  const actorOf=()=>{const road=via();return {by:typeof actor==='function'?actor():actor,...(road?{via:road}:{})};};
  const namespace = () => { if (!files) throw fail('Documents and plain files are unavailable here.', 501); return files; };
  const namedProposers = answer => withProposerNames(answer, typeof ais?.list === 'function' ? ais.list() : []);
  const listCall = (method, ...args) => {
    if (typeof listOwner[method] !== 'function') throw fail(`List operation ${method} is unavailable.`, 501);
    return listOwner[method](...args);
  };
  // `alongside(answer)` is a synchronous write kept with the list write: in its transaction when the write is local.
  const listWriteWith = async (alongside, operation, method, ...args) => {
    const local = typeof listOwner.localWrite === 'function' ? listOwner.localWrite(method, ...args) : null;
    const along = answer => { alongside?.(answer); return answer; };
    if (local) return receipted(operation, () => along(local()));
    return kept(operation, async () => along(await listCall(method, ...args)));
  };
  const listWrite = (operation, method, ...args) => listWriteWith(null, operation, method, ...args);
  const kept = async (operation, run) => {
    begin(operation);
    const answer = await run();
    return receipted(operation, () => answer);
  };
  const ops = {
    'records:read': input => withRights('records:read', input, () => recordRead(input)),
    'records:list': input => withRights('records:list', input, () => recordList(input)),
    'lists:all': input => withRights('lists:all', input, () => input.native_collection_page ? listCall('page',input) : listCall('all')),
    'lists:find': input => withRights('lists:find', input, () => listCall('find', input.list_id ?? input.id)),
    'lists:put': input => withRights('lists:put', input, () => listWrite('lists:put', 'save', input, { actor: actorOf() })),
    // A rollup field's value is worked out from the linked rows by the formula engine on every read (src/list-rollups.mjs).
    'lists:read': input => withRights('lists:read', input, async () => {
      const answer = await listCall('read', input.list_id ?? input.id, {
        ...(input.row_ids === undefined ? {} : { row_ids: input.row_ids }),
        ...(input.keep === undefined ? {} : { keep: input.keep }), ...(input.only === undefined ? {} : { only: input.only }),
        ...(input.open === undefined ? {} : { open: input.open }), ...(input.order === undefined ? {} : { order: input.order }),
        ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return { ...answer, rows: await withRollups(listOwner, answer.list, answer.rows, { evaluateBinding: evaluateBinding ?? undefined }) };
    }),
    'lists:changes': input => withRights('lists:changes', input, () => listCall('changes', input.list_id ?? input.id, input.since)),
    'lists:search': input => withRights('lists:search', input, () => listCall('search', input)),
    'lists:ensure': input => withRights('lists:ensure', input, () => listWrite('lists:ensure', 'ensure', input, { actor: actorOf() })),
    // Filed rows are checked before they are kept and told after, by the account's filing owner (rowsFiling: the waiting
    // owner's fileRows, src/native-waiting-account-owner.mjs); a refusal writes nothing, and what is to be told is kept
    // with the rows (intend).
    // Rows named by who they are (match_on) or by a selection (select) become plain row requests first
    // (src/list-row-operations.mjs), so the filing checks and the list owner see exactly the rows that will be kept.
    'lists:putRows': input => withRights('lists:putRows', input, async () => {
      const filing = rowsFiling();
      const plan = await planRowRequest(listOwner, input.list_id, input, { readView: views ? options => views(options) : undefined });
      const putOne = async (request, write) => {
        const asked = { ...input, rows: request.rows, remove: request.remove };
        const prepared = filing ? await filing.prepare(input.list_id, listOwner.find(input.list_id), asked) : null;
        const given = prepared?.input ?? asked;
        const answer = await write(prepared?.intend, { rows: given.rows, remove: given.remove });
        return filing ? filing.filed(prepared, answer) : answer;
      };
      // One request is the write it always was; a selection is several, begun once and answered as one. A removal says
      // which links still point at what it removed (dangling).
      if (plan.requests.length === 1)
        return withDangling(listOwner, input.list_id, joinAnswers([await putOne(plan.requests[0], (intend, request) => listWriteWith(intend, 'lists:putRows', 'putRows', input.list_id, request, { actor: actorOf() }))], plan));
      return withDangling(listOwner, input.list_id, await kept('lists:putRows', async () => {
        const answers = [];
        for (const request of plan.requests)
          answers.push(await putOne(request, async (intend, one) => { const answer = await listCall('putRows', input.list_id, one, { actor: actorOf() }); intend?.(answer); return answer; }));
        return joinAnswers(answers, plan);
      }));
    }),
    // What putRows would do, written nowhere: its own operation, so a layer that does not know it refuses rather than writes.
    'lists:previewRows': input => withRights('lists:previewRows', input, () => listCall('previewRows', input.list_id, { rows: input.rows, remove: input.remove }, { actor: actorOf() })),
    'lists:mergeRows': input => withRights('lists:mergeRows', input, () => kept('lists:mergeRows', () => mergeRows(listOwner, input.list_id, { base_id: input.base_id, target_id: input.target_id, prefer: input.prefer, values: input.values }, { actor: actorOf() }))),
    'lists:duplicateRows': input => withRights('lists:duplicateRows', input, () => kept('lists:duplicateRows', () => duplicateRows(listOwner, input.list_id,
      { row_ids: input.row_ids, values: input.values, ...(input.to_list === undefined ? {} : { to_list: input.to_list }), ...(input.map === undefined ? {} : { map: input.map }) }, { actor: actorOf() }))),
    'lists:aggregate': input => withRights('lists:aggregate', input, () => aggregateRows(listOwner, input.list_id, { view_id: input.view_id, snapshot_id: input.snapshot_id, measures: input.measures, group_by: input.group_by },
      { evaluateBinding: evaluateBinding ?? undefined, readView: views ? options => views(options) : undefined, readSnapshot: snapshotPages(listOwner) })),
    // A removed row listed and put back from the log; one field of many rows as it was; a view's rows held still; a file
    // field following its file to a new name (src/lists.mjs, src/list-snapshots.mjs, src/list-row-operations.mjs).
    'lists:removedRows': input => withRights('lists:removedRows', input, () => listCall('removedRows', input.list_id, { ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor === undefined ? {} : { cursor: input.cursor }) })),
    'lists:restoreRows': input => withRights('lists:restoreRows', input, () => listWrite('lists:restoreRows', 'restoreRows', input.list_id, { row_ids: input.row_ids }, { actor: actorOf() })),
    'lists:fieldAt': input => withRights('lists:fieldAt', input, () => listCall('fieldAt', input.list_id, { field_id: input.field_id, at: input.at, row_ids: input.row_ids, ...(input.limit === undefined ? {} : { limit: Number(input.limit) }), ...(input.cursor === undefined ? {} : { cursor: input.cursor }) })),
    'lists:snapshot': input => withRights('lists:snapshot', input, () => kept('lists:snapshot', () => takeSnapshot(listOwner, input.list_id, { ...(input.view_id === undefined ? {} : { view_id: input.view_id }) },
      { actor: actorOf(), readView: views ? options => views(options) : undefined }))),
    'lists:readSnapshot': input => withRights('lists:readSnapshot', input, () => readSnapshot(listOwner, input.list_id, { snapshot_id: input.snapshot_id, ...(input.from === undefined ? {} : { from: input.from }), ...(input.count === undefined ? {} : { count: input.count }) })),
    'lists:fileReferences': input => withRights('lists:fileReferences', input, () => fileReferences(listOwner, { name: input.name })),
    'lists:rewriteFileNames': input => withRights('lists:rewriteFileNames', input, () => kept('lists:rewriteFileNames', () => rewriteFileNames(listOwner, { from: input.from, to: input.to }, { actor: actorOf() }))),
    'lists:moveView': input => withRights('lists:moveView', input, () => listWrite('lists:moveView', 'moveView', input.list_id, { view_id: input.view_id, anchor_id: input.anchor_id, placement: input.placement }, { actor: actorOf() })),
    'lists:resolveRows': input => withRights('lists:resolveRows', input, () => resolveRows(listOwner, { refs: input.refs })),
    'lists:backlinks': input => withRights('lists:backlinks', input, () => backlinks(listOwner, input.list_id, input.row_id)),
    // A folder of documents' property kinds and formulas, and a list as plain files, through the person's Namespace
    // (`files`: src/document-properties.mjs namespaceFiles) under the request's own rights.
    'lists:documentTypes': input => withRights('lists:documentTypes', input, async () => readDocumentTypes(namespace(), documentsFolderOf(await listCall('find', input.list_id), input.list_id))),
    'lists:saveDocumentTypes': input => withRights('lists:saveDocumentTypes', input, () => kept('lists:saveDocumentTypes', async () => saveDocumentTypes(namespace(), documentsFolderOf(await listCall('find', input.list_id), input.list_id),
      { types: input.types, formulas: input.formulas, ...(input.expected_identity === undefined ? {} : { expected_identity: input.expected_identity }) }))),
    'lists:exportFiles': input => withRights('lists:exportFiles', input, () => kept('lists:exportFiles', () => exportListFiles(listOwner, input.list_id, { folder: input.folder, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) }, { files: namespace() }))),
    'lists:importFiles': input => withRights('lists:importFiles', input, () => kept('lists:importFiles', () => importListFiles(listOwner,
      { folder: input.folder, ...(input.list_id === undefined ? {} : { list_id: input.list_id }), ...(input.match_on === undefined ? {} : { match_on: input.match_on }), ...(input.after === undefined ? {} : { after: input.after }) }, { files: namespace(), actor: actorOf() }))),
    // A field's history as lines; review of what a list says; use heat and cold rows; an AI's proposed changes and a
    // person's decision on them (src/list-value-history.mjs, src/list-review.mjs, src/list-proposals.mjs).
    'lists:fieldHistory': input => withRights('lists:fieldHistory', input, () => listCall('fieldHistory', input.list_id, { row_id: input.row_id, field_id: input.field_id })),
    'lists:review': input => withRights('lists:review', input, () => kept('lists:review', () => reviewRows(listOwner, input.list_id,
      { action: input.action, ...(input.row_ids === undefined ? {} : { row_ids: input.row_ids }), ...(input.owner === undefined ? {} : { owner: input.owner }), ...(input.expires_days === undefined ? {} : { expires_days: input.expires_days }) }, { actor: actorOf() }))),
    'lists:needsReview': input => withRights('lists:needsReview', input, () => rowsNeedingReview(listOwner, input.list_id, { ...(input.owner === undefined ? {} : { owner: input.owner }) }, { readView: views ? options => views(options) : undefined })),
    'lists:noteUse': input => withRights('lists:noteUse', input, () => listWrite('lists:noteUse', 'noteUse', input.list_id, { row_ids: input.row_ids }, { actor: actorOf() })),
    'lists:heatOf': input => withRights('lists:heatOf', input, () => listCall('heatOf', input.list_id, { row_ids: input.row_ids })),
    'lists:coldRows': input => withRights('lists:coldRows', input, () => coldRows(listOwner, input.list_id, { ...(input.owner === undefined ? {} : { owner: input.owner }), ...(input.cursor === undefined ? {} : { cursor: input.cursor }) })),
    'lists:proposeChanges': input => withRights('lists:proposeChanges', input, () => listWrite('lists:proposeChanges', 'proposeChanges', input.list_id,
      { rows: input.rows, remove: input.remove, editable: input.editable, scopes: input.scopes, evidence: input.evidence, ...(input.note === undefined ? {} : { note: input.note }), ...(input.proposal_id === undefined ? {} : { proposal_id: input.proposal_id }) }, { actor: actorOf() })),
    'lists:proposals': input => withRights('lists:proposals', input, async () => namedProposers(await listCall('proposals', input.list_id, { ...(input.status === undefined ? {} : { status: input.status }), ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor === undefined ? {} : { cursor: input.cursor }) }))),
    'lists:proposal': input => withRights('lists:proposal', input, async () => namedProposers(await listCall('proposal', input.list_id, { proposal_id: input.proposal_id }))),
    'lists:decideProposal': input => withRights('lists:decideProposal', input, () => listWrite('lists:decideProposal', 'decideProposal', input.list_id, { proposal_id: input.proposal_id, decision: input.decision }, { actor: actorOf() })),
    'lists:remove': input => withRights('lists:remove', input, () => listCall('save', { id: input.list_id ?? input.id, remove: true }, { actor: actorOf() })),
    'lists:views': input => withRights('lists:views', input, async () => ({ list_id: input.list_id, views: viewsWithParameters((await listCall('find', input.list_id))?.views ?? []) })),
    'lists:saveView': input => withRights('lists:saveView', input, () => listWrite('lists:saveView', 'saveView', input.list_id, input.view ?? input, { actor: actorOf() })),
    'lists:filters': input => withRights('lists:filters', input, () => listCall('filters', input.list_id, {})),
    'lists:saveFilter': input => withRights('lists:saveFilter', input, () => listWrite('lists:saveFilter', 'saveFilter', input.list_id, { ...(input.filter ?? input), ...(input.filter_id ? { id: input.filter_id } : {}) }, { actor: actorOf() })),
    'lists:removeFilter': input => withRights('lists:removeFilter', input, () => listWrite('lists:removeFilter', 'removeFilter', input.list_id, { filter_id: input.filter_id }, { actor: actorOf() })),
    'lists:removeView': input => withRights('lists:removeView', input, () => listWrite('lists:removeView', 'removeView', input.list_id, input.view_id, { actor: actorOf() })),
    // Make many lists at once, each in the store the storage placement rows choose (src/list-store-provisioning.mjs).
    'lists:make': input => withRights('lists:make', input, () => {
      if (!listStores) throw fail('Making lists in their own stores is unavailable here.', 501);
      return kept('lists:make', () => listStores.make(input.lists, { save: list => listOwner.save(list, { actor: actorOf() }) }).then(made => ({ made })));
    }),
    // Publish some of a list's own rows on the Marketplace, on the list's own shelf (src/place-lists.mjs shelfOf), so
    // accounts that take this account as a default publisher see them beside their own rows.
    'lists:publishRows': input => withRights('lists:publishRows', input, async () => {
      if (!publishListRows) throw fail('Publishing list rows is unavailable here.', 501);
      const list = listOwner.find(input.list_id);
      if (!list) throw fail(`There is no list ${input.list_id}.`, 404);
      const ids = Array.isArray(input.row_ids) ? input.row_ids.filter(id => typeof id === 'string') : null;
      if (ids && ids.length > 50) throw fail('Publish at most 50 rows at a time.');
      const page = await listOwner.read(list.id, { limit: 50, ...(ids ? { row_ids: ids } : {}) });
      return kept('lists:publishRows', () => publishListRows(list, page.rows ?? []));
    }),
    // One page more of each list moving to another store (src/placed-lists.mjs), from the resource's alarm.
    'lists:continueMoves': input => withRights('lists:continueMoves', input, () => typeof listOwner.continueMoves === 'function' ? listOwner.continueMoves({}, { actor: actorOf() }) : []),
    'lists:moveRow': input => withRights('lists:moveRow', input, () => listWrite('lists:moveRow', 'moveRow', input.list_id, input, { actor: actorOf() })),
    'lists:readView': input => withRights('lists:readView', input, () => {
      if (typeof views !== 'function') throw fail('The native list view evaluator is unavailable.', 503);
      return views({ list_id: input.list_id, view_id: input.view_id, row_ids: input.row_ids, page: input.page, limit: input.limit, cursor: input.cursor, ...(input.parameters === undefined ? {} : { parameters: input.parameters }) });
    }),
    'pursuits:list': input => withRights('pursuits:list', input, async () => ({ pursuits: await source.engine.pursuits() })),
    'pursuits:replace': input => withRights('pursuits:replace', input, () => source.engine.recordPursuits(input.pursuits, { replace_all: input.replace_all === true })),
    'decisions:list': input => withRights('decisions:list', input, () => {
      const limit=bounded(input.limit,'limit');
      if(!input.native_collection_page)return decisions.summaries(limit,input.before?{before:input.before}:{});
      const rows=decisions.summaries(limit+1,input.before?{before:input.before}:{});
      return {summaries:rows.slice(0,limit),next_before:rows.length>limit?rows[limit-1].case_id:null};
    }),
    'decisions:read': input => withRights('decisions:read', input, () => {
      if (typeof input.case_id !== 'string' || !input.case_id) throw fail('A decision case id is required.');
      return decisions.read({ cases: [input.case_id] }).cases[input.case_id] ?? null;
    }),
    'decisions:write': input => withRights('decisions:write', input, () => decisions.write(input.state, { actor: actorOf() })),
    'decisions:forMessage': input => withRights('decisions:forMessage', input, () => source.decision(input.message_id)),
    'work:read': input => withRights('work:read', input, () => {
      if (!work?.work?.read) throw fail('Native work owner is unavailable.', 503);
      return work.work.read(input.task_id);
    }),
    'work:cards': input => withRights('work:cards', input, () => {
      if (!work?.work?.cards) throw fail('Native work owner is unavailable.', 503);
      if(input.native_collection_page){
        if(!work.work.cardsPage)throw fail('The native work owner requires its bounded cards page.',503);
        return work.work.cardsPage(input);
      }
      return work.work.cards(input);
    }),
    'ais:list': input => withRights('ais:list', input, () => {
      if (!ais?.list || !ais?.isLive) throw fail('The resource AI owner is unavailable.', 503);
      return { ais: ais.list().map(ai => ({ ...ai, live_now: ais.isLive(ai) })) };
    }),
    // An MCP client that introduced itself on a sign-in (src/worker.mjs MCP initialize, after the sign-in gate kept its
    // name): the one list of the account's AIs now holds that sign-in, so Connect your AI and recovery see it.
    'ais:introduce': input => withRights('ais:introduce', input, () => {
      if (!ais?.fromClient || !ais?.upsert) throw fail('The resource AI owner is unavailable.', 503);
      if (!isIntroduction(input)) throw fail(INTRODUCTION_REFUSED);
      return ais.upsert(ais.fromClient(input.sign_in, input.client), { actor: { by: 'ais', app: input.client.name ?? null } });
    }),
    'ais:fromCard': input => withRights('ais:fromCard', input, () => {
      if (!ais?.fromCard || !ais?.upsert) throw fail('The resource AI owner is unavailable.', 503);
      const card = input.card;
      if (!card?.agent_id) throw fail('A published agent card is required.');
      const discovered=ais.fromCard(card,ais.list());
      return discovered?ais.upsert(discovered,{actor:actorOf()}):null;
    }),
  };
  return Object.freeze({
    operations: Object.freeze(ops),
    async invoke(operation, input = {}) {
      if (!Object.hasOwn(ops, operation)) throw fail('The native record consumer operation is not installed.', 404);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Send an input object.');
      const result = await ops[operation](plain(input));
      return result === undefined ? null : plain(result);
    },
  });
}

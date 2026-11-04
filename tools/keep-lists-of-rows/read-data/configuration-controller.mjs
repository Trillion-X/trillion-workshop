// The same controller serves React catalogs and imperative mounted record views.
// Transport and navigation are supplied by the host; saved state has one EEAF owner.
import { captureConfigurationSettings } from './configuration-values.mjs';

const blankRules = () => ({kind: 'group', combinator: 'and', negate: false, rules: []});
export const configurationView = record => ({
  id: record.id, label: record.label, search: '', rules: blankRules(), ...record.settings,
  aspects: record.aspects, owner: record.owner, revision: record.revision,
  ...(record.record_ref ? {record_ref: record.record_ref} : {}),
  readOnly: record.readOnly === true,
  canRemove: !record.share_code && !record.offer_id, canShare: !record.share_code && !record.offer_id,
});

export function makeConfigurationController({source, target, openPath, fieldIds, initialId, sharedCode, sharedOffer,
  beforeSave = async () => {}, applied = () => {}, changed = () => {}}) {
  let records = new Map(), generation = 0, selectionIntent = 0, disposed = false, activeId = initialId ?? null;
  let pendingCreate = null;
  const mutationKept = () => {generation++; state = {...state, loading: false, error: undefined};};
  let state = {loading: false, error: undefined, hasMore: false}, ownCursor = null, sharedCursor = null;
  const emit = () => {if (!disposed) changed();};
  const compatible = record => {
    if (!record || record.target !== target) throw new Error(`This configuration belongs to ${record?.target ?? 'another screen'}. Open its original screen to use it.`);
    return record;
  };
  const put = record => {const found = compatible(record); records.set(found.id, found); return found;};
  const selectedSettings = view => {
    const {search, rules, sort, groups, columns, time, time_zone, display} = view;
    return Object.fromEntries(Object.entries({search, rules, sort, groups, columns, time, time_zone, display}).filter(([, value]) => value !== undefined));
  };
  const savedInput = async (view, current) => {
    await beforeSave(view);
    const fields = fieldIds();
    const settings = {...(current?.settings ?? {}), ...selectedSettings(view)};
    const aspects = view.aspects ?? current?.aspects;
    return {label: view.label ?? current?.label, target, open_path: openPath, format: 'record-view',
      aspects, field_ids: fields, settings: captureConfigurationSettings(settings, aspects, fields)};
  };
  const get = id => {const record = records.get(id); if (!record) throw new Error('Open the latest configuration before changing it.'); return record;};
  const load = async ({more = false} = {}) => {
    disposed = false;
    const token = ++generation;
    const selectedAtStart = selectionIntent;
    state = {...state, loading: true, error: undefined}; emit();
    const ownRead = more && !ownCursor ? Promise.resolve(null) : source.list({target, ...(more && ownCursor ? {before: ownCursor} : {})});
    const sharedRead = more && !sharedCursor ? Promise.resolve(null) : source.listShared
      ? source.listShared({target, ...(more && sharedCursor ? {before: sharedCursor} : {})})
      : Promise.resolve({configurations: [], next_before: null});
    // An exact deep link resolves independently even if both catalogs fail.
    const pendingId = pendingCreate?.id, requestedId = activeId;
    const wanted = pendingId ? () => source.read(pendingId)
      : sharedCode ? () => source.readShared(sharedCode)
      : sharedOffer ? () => source.readOffer(sharedOffer)
      : requestedId && !requestedId.startsWith('shared-') ? () => source.read(requestedId) : null;
    // Opening one configuration does not depend on the discovery catalogs.
    // Publish its admitted exact answer as soon as it arrives; the final merge
    // still gives that answer precedence over older catalog projections.
    const exactRead = !more && wanted ? Promise.resolve().then(wanted).then(value => {
      if (!disposed && token === generation && value) {
        const record = put(value.configuration ?? value);
        if (selectionIntent === selectedAtStart) activeId = record.id;
        if (pendingCreate?.id === record.id) pendingCreate = null;
        emit();
      }
      return value;
    }) : Promise.resolve(null);
    const pending = [more && !ownCursor ? Promise.resolve(null) : ownRead,
      more && !sharedCursor ? Promise.resolve(null) : sharedRead,
      exactRead];
    const answers = await Promise.allSettled(pending);
    if (disposed || token !== generation) return;
    // A newer choice may come from a later catalog page. A first-page refresh
    // must not leave that selected identity without its already admitted row.
    const selectedDuringRead = selectionIntent !== selectedAtStart ? records.get(activeId) : null;
    if (!more) records = new Map(selectedDuringRead ? [[selectedDuringRead.id, selectedDuringRead]] : []);
    const errors = [];
    answers.forEach((answer, at) => {
      if (answer.status === 'rejected') {
        if (at !== 2 || pendingId || selectionIntent === selectedAtStart) errors.push(String(answer.reason?.message ?? answer.reason));
        return;
      }
      const value = answer.value;
      if (!value) return;
      if (at < 2) {
        for (const record of value.configurations ?? []) if (record.target === target) records.set(record.id, record);
        if (at === 0) ownCursor = value.next_before ?? null; else sharedCursor = value.next_before ?? null;
        if (value.unavailable) errors.push(`${value.unavailable} shared configuration${value.unavailable === 1 ? ' is' : 's are'} temporarily unavailable.`);
      } else {
        try {
          const record = put(value.configuration ?? value);
          if (selectionIntent === selectedAtStart) activeId = record.id;
          if (pendingCreate?.id === record.id) pendingCreate = null;
        }
        catch (error) {errors.push(error.message);}
      }
    });
    state = {loading: false, error: errors.length ? errors.join(' ') : undefined, hasMore: Boolean(ownCursor || sharedCursor)}; emit();
  };
  const controller = {
    load,
    dispose() {disposed = true; generation++; records.clear();},
    has: id => records.has(id),
    snapshot: () => ({savedViews: [...records.values()].map(configurationView), initialSavedViewId: activeId ?? undefined,
      savedViewsState: state}),
    async save(view) {
      const input = await savedInput(view);
      const signature = JSON.stringify(input);
      if (pendingCreate && pendingCreate.signature !== signature)
        throw new Error('An earlier save may still be finishing. Reload saved configurations to resolve it before changing this draft.');
      if (!pendingCreate) pendingCreate = {id: `record:configuration:${crypto.randomUUID()}`, input, signature};
      const attempt = pendingCreate;
      const keep = recovered => {
        mutationKept();
        const record = put(recovered); activeId = record.id;
        if (pendingCreate === attempt) pendingCreate = null;
        emit(); return record;
      };
      try {
        const result = await source.save({...attempt.input, id: attempt.id});
        return keep(result.configuration ?? result);
      } catch (error) {
        // The owner rejects these requests before a write. Keep the editor's
        // draft, but release its attempt so a corrected name or setting can save.
        // Network failures, timeouts, conflicts and server failures stay ambiguous.
        if ([400, 401, 403, 404, 405, 413, 422].includes(error?.status)) {
          if (pendingCreate === attempt) pendingCreate = null;
          throw error;
        }
        try {
          const exact = await source.read(attempt.id), recovered = exact.configuration ?? exact;
          if (recovered?.id === attempt.id && recovered.revision === 1 && recovered.label === attempt.input.label
            && JSON.stringify(recovered.settings) === JSON.stringify(attempt.input.settings)) return keep(recovered);
        } catch { /* Keep the original failure and attempted id for the next retry. */ }
        throw error;
      }
    },
    async update(view) {
      const current = get(view.id);
      if (current.readOnly) throw new Error('This configuration is shared for viewing. Save your own copy to change it.');
      const input = await savedInput(view, current);
      const result = current.share_code
        ? await source.editShared(current.share_code, {label: input.label, aspects: input.aspects, settings: input.settings, expected_revision: current.revision})
        : await source.save({...input, id: current.id, expected_revision: current.revision});
      mutationKept(); put(result.configuration ?? result); emit();
    },
    async remove(id) {
      const current = get(id);
      if (current.share_code || current.offer_id || current.readOnly) throw new Error('Only the owner can remove this configuration.');
      if (activeId === id) selectionIntent++;
      await source.remove(id, current.revision); mutationKept(); records.delete(id); if (activeId === id) activeId = null; emit();
    },
    apply(view) {selectionIntent++; activeId = view.id; applied(view);},
    async share(id) {
      const current = get(id);
      if (current.share_code || current.offer_id) throw new Error('Only the owner can change who this configuration is shared with.');
      await source.share(current);
    },
    async copyLink(id) {await source.copyLink(get(id));},
    options() {
      return {...controller.snapshot(), ...(source.context ? {configurationContext: source.context} : {}), onSaveView: async view => {await controller.save(view);},
        onUpdateSavedView: view => controller.update(view), onRemoveSavedView: id => controller.remove(id),
        onApplySavedView: view => controller.apply(view), onShareSavedView: id => controller.share(id),
        onCopySavedViewLink: id => controller.copyLink(id), onReloadSavedViews: () => load(), onLoadMoreSavedViews: () => load({more: true})};
    },
  };
  return controller;
}

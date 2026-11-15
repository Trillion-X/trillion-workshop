// Read-time titles, shared by list pages, linked labels and record search. No name is written or cached.
// Adapted from lists.mjs:titleOf (old trillion src/lists.mjs:470) and the existing shell namesOf batch seam.
// Formula execution stays with the host's existing evaluator: this pure helper only prepares and checks its answer.

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Preserve the existing stored-title conversion, including array titles and null for absent/non-text cells. */
export function titleText(value) {
  return typeof value === 'string' && value ? value : Array.isArray(value) ? value.join(', ') : null;
}

/** Prepare one batch over raw stored values. The host evaluates `request` once (if non-null), then calls finish.
 * Both synchronous Workshop evaluateFormula({binding, rows}) and an async browser adapter may supply that answer.
 * Browser adapters must reuse list-targets.evaluateFormula({binding, context}), not load another evaluator.
 * fieldKinds is the host's existing DATA vocabulary, used to recognize a missing declared derivation.
 */
export function prepareListTitles(list, values, { fieldKinds = [] } = {}) {
  if (!object(list)) throw new TypeError('A list definition is required to read row titles.');
  if (!Array.isArray(values)) throw new TypeError('Title rows must be an array of stored values.');
  if (!Array.isArray(fieldKinds)) throw new TypeError('Title field kinds must be an array.');
  const field = list.fields?.find(row => row.id === list.title_field);
  const kind = fieldKinds.find(row => row.id === field?.kind);
  const carried = kind?.carries?.key;
  const derives = field && (Object.hasOwn(field, 'derive') || carried === 'derive' || (!kind && field.kind === 'formula'));
  if (!derives) {
    const titles = values.map(value => titleText(list.title_field ? value?.[list.title_field] : undefined));
    return { request: null, finish: () => [...titles] };
  }
  const derive = { ...(carried === 'derive' ? kind.carries.defaults : {}), ...field.derive };
  const binding = derive.request?.binding;
  if (!object(binding)) throw new Error('This list’s title field names no formula binding.');
  // This helper understands the existing formula contract, not arbitrary executable targets or result paths.
  if (derive.target !== undefined && derive.target !== 'slot::formula-engine') throw new Error('This list’s title field names an unsupported formula target.');
  if (derive.result_path !== undefined && !(Array.isArray(derive.result_path) && derive.result_path.length === 1 && derive.result_path[0] === 'value')) throw new Error('This list’s title field names an unsupported formula result path.');
  const request = values.length ? { binding, rows: values } : null;
  return {
    request,
    finish(answer) {
      if (!values.length) return [];
      if (!object(answer) || !Array.isArray(answer.values) || answer.values.length !== values.length) throw new Error('The title formula did not return one value for every row.');
      if (!Array.isArray(answer.errors)) throw new Error('The title formula did not report whether its rows had errors.');
      if (answer.errors.length) throw Object.assign(new Error('The title formula could not evaluate every row.'), { errors: answer.errors });
      return answer.values.map(value => {
        const title = titleText(value);
        return typeof title === 'string' && title.trim() ? title : null;
      });
    },
  };
}

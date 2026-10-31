// tools/plan-trips/read-data/checklist.mjs
//
// How much of a checklist is done, and the checklist grouped. Which statuses count as done and which leave the
// count (an item that is no longer needed) are the person's, given in the request.
//
//   request: { items: [{ id, status?, group?, ... }], done_statuses: [..], skipped_statuses: [..], ungrouped_label? }
//   answer:  { done, total, ratio, groups: [{ group, count, done, items }] }

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value.trim() : '');
const names = (request, key) => {
  const list = request[key];
  if (!Array.isArray(list) || list.some(name => typeof name !== 'string')) throw new Error(`${key} must be a list of status names (it may be empty).`);
  return new Set(list);
};

export function measureAChecklist(request) {
  if (!isObject(request) || !Array.isArray(request.items)) throw new Error('items must be a list of { id, status, group }.');
  const doneStatuses = names(request, 'done_statuses');
  const skippedStatuses = names(request, 'skipped_statuses');
  const ungrouped = text(request.ungrouped_label) || 'uncategorized';
  const groups = new Map();
  let done = 0;
  let total = 0;
  for (const [index, item] of request.items.entries()) {
    if (!isObject(item) || !text(item.id)) throw new Error(`items[${index}] needs an id.`);
    const status = text(item.status);
    const counted = !skippedStatuses.has(status);
    const finished = counted && doneStatuses.has(status);
    if (counted) total += 1;
    if (finished) done += 1;
    const name = text(item.group) || ungrouped;
    const group = groups.get(name) ?? { group: name, count: 0, done: 0, items: [] };
    group.count += 1;
    if (finished) group.done += 1;
    group.items.push(item);
    groups.set(name, group);
  }
  return { done, total, ratio: total === 0 ? 0 : done / total, groups: [...groups.values()] };
}

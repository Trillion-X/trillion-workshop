// tools/plan-trips/read-data/checklist.mjs
//
// How much of a checklist is done, and the checklist grouped. Which statuses count as done and which leave the
// count (an item that is no longer needed) are the person's, given in the request.
//
//   request: { items: [{ id, status?, group?, ... }], done_statuses: [..], skipped_statuses: [..], ungrouped_label? }
//   answer:  { done, total, ratio, groups: [{ group, count, done, items }] }
//
// Two optional shapes, answered only when the request carries them (nested bags; "this waits on that"):
//   request: { containers: [{ id, label?, parent? }], items: [{ id, container?, depends_on?: [id] }],
//              dependencies: [{ id?, item, depends_on, reason? }] }
//   answer:  { container_paths: { <item id>: [label, ...] root first }, blocked: [{ id, waiting_on: [id], reasons: [text] }] }
// A dependency named on the item and one in the list are joined, the item's own first. An item that is not done
// and waits on something that is not done is blocked; a thing it waits on that is not in the list counts as not done.

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value.trim() : '');
const names = (request, key) => {
  const list = request[key];
  if (!Array.isArray(list) || list.some(name => typeof name !== 'string')) throw new Error(`${key} must be a list of status names (it may be empty).`);
  return new Set(list);
};

function containerPaths(request, items) {
  if (request.containers === undefined) return undefined;
  if (!Array.isArray(request.containers)) throw new Error('containers must be a list of { id, label, parent }.');
  const byId = new Map();
  for (const [index, container] of request.containers.entries()) {
    if (!isObject(container) || !text(container.id)) throw new Error(`containers[${index}] needs an id.`);
    byId.set(text(container.id), container);
  }
  const labelPath = (id, seen = []) => {
    if (seen.includes(id)) throw new Error(`container ${id} sits inside itself.`);
    const container = byId.get(id);
    if (!container) throw new Error(`container ${id} is not in containers.`);
    const parent = text(container.parent);
    return [...(parent ? labelPath(parent, [...seen, id]) : []), text(container.label) || id];
  };
  const paths = {};
  for (const item of items) if (text(item.container)) paths[text(item.id)] = labelPath(text(item.container));
  return paths;
}

function blockedItems(request, items, finishedIds) {
  const listed = request.dependencies;
  if (listed !== undefined && !Array.isArray(listed)) throw new Error('dependencies must be a list of { item, depends_on, reason }.');
  const waits = new Map();
  const add = (id, on, reason) => {
    const entry = waits.get(id) ?? { on: [], reasons: [] };
    if (!entry.on.includes(on)) entry.on.push(on);
    if (reason) entry.reasons.push(reason);
    waits.set(id, entry);
  };
  for (const item of items) {
    if (item.depends_on === undefined) continue;
    if (!Array.isArray(item.depends_on) || item.depends_on.some(name => typeof name !== 'string')) throw new Error(`item ${text(item.id)}: depends_on must be a list of item ids.`);
    for (const on of item.depends_on) add(text(item.id), on);
  }
  for (const [index, dependency] of (listed ?? []).entries()) {
    if (!isObject(dependency) || !text(dependency.item) || !text(dependency.depends_on)) throw new Error(`dependencies[${index}] needs item and depends_on.`);
    add(text(dependency.item), text(dependency.depends_on), text(dependency.reason));
  }
  if (waits.size === 0 && listed === undefined) return undefined;
  const blocked = [];
  for (const item of items) {
    const id = text(item.id);
    const entry = waits.get(id);
    if (!entry || finishedIds.has(id)) continue;
    const waitingOn = entry.on.filter(on => !finishedIds.has(on));
    if (waitingOn.length) blocked.push({ id, waiting_on: waitingOn, reasons: entry.reasons });
  }
  return blocked;
}

export function measureAChecklist(request) {
  if (!isObject(request) || !Array.isArray(request.items)) throw new Error('items must be a list of { id, status, group }.');
  const doneStatuses = names(request, 'done_statuses');
  const skippedStatuses = names(request, 'skipped_statuses');
  const ungrouped = text(request.ungrouped_label) || 'uncategorized';
  const groups = new Map();
  const finishedIds = new Set();
  let done = 0;
  let total = 0;
  for (const [index, item] of request.items.entries()) {
    if (!isObject(item) || !text(item.id)) throw new Error(`items[${index}] needs an id.`);
    const status = text(item.status);
    const counted = !skippedStatuses.has(status);
    const finished = counted && doneStatuses.has(status);
    if (counted) total += 1;
    if (finished) done += 1;
    if (finished) finishedIds.add(text(item.id));
    const name = text(item.group) || ungrouped;
    const group = groups.get(name) ?? { group: name, count: 0, done: 0, items: [] };
    group.count += 1;
    if (finished) group.done += 1;
    group.items.push(item);
    groups.set(name, group);
  }
  const answer = { done, total, ratio: total === 0 ? 0 : done / total, groups: [...groups.values()] };
  const paths = containerPaths(request, request.items);
  if (paths) answer.container_paths = paths;
  const blocked = blockedItems(request, request.items, finishedIds);
  if (blocked) answer.blocked = blocked;
  return answer;
}

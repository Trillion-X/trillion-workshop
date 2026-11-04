// src/namespace-release-rules.mjs
//
// PURPOSE
//   When the storage of what a person deleted is given back, by their own rules. A rule is DATA (namespace-byte-release
//   .json `_rules`): which items it covers is a formula-engine rule tree over each item's facts (name, kind, where it
//   was, size, days since deleted, state, by, files), decided by the engine the host hands in, never here; it gives
//   their storage back a number of days after they were deleted, or while the storage kept is above a size. The plan
//   answers which items leave now and when every other item will leave, so the store's daily pass, a person's run
//   through a Workshop tool (from a rule or schedule of their own), and the storage screen read one answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a folder, a kind, a size or a number of days; every number comes from the person's rows or
//      their keep-for setting.
//   2. Keep-for is the longest anything waits: a rule only gives storage back sooner. An item no rule covers leaves when
//      its keep-for ends (the set-aside sweep), and an item in a state that moves on (Archived) leaves only by a rule.
//   3. A storage rule never guesses tomorrow: it gives back, in its order, only while the bytes kept now are above its
//      size, and says so for the rest ("when storage passes").
//   4. Facts are worked out once per item and read by the same ids on the screen and here.
//   5. One item leaves by its id: { when: group over the fact `id` is_any_of [that id], after_days: 0 }. `id` is a fact like any
//      other, so this is a rule, never a second path.
//
// Shapes
//   releaseItemFacts(item, now) -> { id, label, kind, where, size, days_deleted, state, by, count }
//   checkReleaseRules(rows) -> rows (each checked; a refusal says what to fix)
//   releasePlan({ items, rules, keptBytes, finalStates, filterRows, now }) -> Promise<{
//     now: [id], items: [{ id, leaves_at: ISO | null, because: rule id | 'keep-for' | null, when_storage_above: bytes | null }],
//     leaving: [{ day, bytes, items }] (the next forecast_days), kept_after: bytes }>
//
import data from '../../organize-my-files/src/namespace-byte-release.json' with { type: 'json' };
import previews from '../../keep-and-wake-ai-sessions-on-this-computer/src/workspace/file-previews.json' with { type: 'json' };

// A rule that cannot be used is refused before anything is read or changed: its reason reaches the caller (src/namespace-resource-owner.mjs).
const refusal = message => Object.assign(new Error(message), { status: 400, not_sent: true, refusal: true });
const DAY_MS = 86_400_000;
const extensionOf = name => { const base = String(name ?? '').slice(String(name ?? '').lastIndexOf('/') + 1); const dot = base.lastIndexOf('.'); return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''; };
const kindOf = item => {
  const family = item.folder ? 'folder' : previews.families_by_extension[extensionOf(item.names?.[0] ?? item.label)] ?? 'other';
  return (previews.rows.find(row => row.family === family) ?? previews.rows.find(row => row.family === undefined)).type_label;
};

/** One item's facts, by the ids in item_facts. */
export function releaseItemFacts(item, now = Date.now()) {
  return {
    id: item.id, label: item.label, kind: kindOf(item), where: item.where ?? '', size: item.byte_length, state: item.state_label, by: item.by ?? '', count: item.name_count,
    days_deleted: Math.max(0, Math.floor((now - Date.parse(item.set_aside_at)) / DAY_MS)),
  };
}

const whole = (value, what) => {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) throw refusal(`${what} is a whole number of 0 or more, or null.`);
  return value;
};

/** A person's rows, checked; each needs a when (a rule group or null) and at least one of after_days and storage_above_bytes. */
export function checkReleaseRules(rows) {
  if (!Array.isArray(rows)) throw refusal('Send the release rules as a list.');
  if (rows.length > data.rules_most) throw refusal(`Keep at most ${data.rules_most} release rules.`);
  const ids = new Set();
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !Object.hasOwn(row, 'when')) {
      throw refusal('Each release rule needs when: null for everything or a rule group.');
    }
    const id = String(row?.id ?? `rule-${index + 1}`);
    if (ids.has(id)) throw refusal(`Two release rules are called ${id}.`);
    ids.add(id);
    const when = row.when;
    if (when !== null && (!when || when.kind !== 'group' || !Array.isArray(when.rules))) throw refusal('when is a rule group { kind: "group", combinator, negate, rules } over the item facts, or null for everything.');
    const after_days = whole(row.after_days, 'after_days');
    const storage_above_bytes = whole(row.storage_above_bytes, 'storage_above_bytes');
    if (after_days === null && storage_above_bytes === null) throw refusal('Say after how many days (after_days) or above what storage (storage_above_bytes) the rule gives storage back.');
    const order = row.order ?? data.orders[0].id;
    if (!data.orders.some(known => known.id === order)) throw refusal(`order is one of ${data.orders.map(known => known.id).join(', ')}.`);
    return { id, label: String(row.label ?? '').slice(0, 200), on: row.on !== false, when, after_days, storage_above_bytes, order };
  });
}

/** Which items leave now and when every other one will. */
export async function releasePlan({ items, rules, keptBytes, finalStates, filterRows, now = Date.now() }) {
  const facts = items.map(item => releaseItemFacts(item, now));
  const covered = async rule => {
    if (rule.when === null) return items.map((_, index) => index);
    const namesAComparison = node => node?.kind === 'rule' || (node?.kind === 'group' && node.rules.some(namesAComparison));
    if (!namesAComparison(rule.when)) throw refusal(`Release rule ${rule.id} has no comparison. Use when: null to cover everything.`);
    const result = await filterRows({ tree: rule.when, fields: data.item_facts, rows: facts });
    // The shared row filter intentionally ignores unfinished rules for browsing. A release rule deletes bytes;
    // ignoring an unsupported condition would broaden it to unrelated files, so refuse the whole plan.
    if (result.incomplete?.length) throw refusal(`Release rule ${rule.id} has an unfinished condition. Choose a supported field and comparison.`);
    return result.matches;
  };
  const leaves = items.map(item => (finalStates.has(item.state) && item.due_at ? { at: Date.parse(item.due_at), because: 'keep-for' } : { at: null, because: null }));
  const storageRules = [];
  for (const rule of rules.filter(row => row.on)) {
    const indices = await covered(rule);
    if (rule.after_days !== null) {
      for (const index of indices) {
        const at = Date.parse(items[index].set_aside_at) + rule.after_days * DAY_MS;
        if (leaves[index].at === null || at < leaves[index].at) leaves[index] = { at, because: rule.id };
      }
    }
    if (rule.storage_above_bytes !== null) storageRules.push({ rule, indices });
  }
  const leavingNow = new Set(leaves.flatMap((leave, index) => (leave.at !== null && leave.at <= now ? [index] : [])));
  let kept = keptBytes - [...leavingNow].reduce((sum, index) => sum + items[index].byte_length, 0);
  const above = new Map();
  for (const { rule, indices } of storageRules) {
    const first = rule.order === 'largest' ? (a, b) => items[b].byte_length - items[a].byte_length : (a, b) => Date.parse(items[a].set_aside_at) - Date.parse(items[b].set_aside_at);
    for (const index of [...indices].sort(first)) {
      if (leavingNow.has(index)) continue;
      if (kept > rule.storage_above_bytes) { leavingNow.add(index); leaves[index] = { at: now, because: rule.id }; kept -= items[index].byte_length; }
      else if (!above.has(index)) above.set(index, rule.storage_above_bytes);
    }
  }
  const leaving = Array.from({ length: data.forecast_days }, (_, day) => ({ day: new Date(now + day * DAY_MS).toISOString().slice(0, 10), bytes: 0, items: 0 }));
  leaves.forEach((leave, index) => {
    if (leave.at === null) return;
    const day = Math.max(0, Math.floor((leave.at - now) / DAY_MS));
    if (day >= leaving.length) return;
    leaving[day].bytes += items[index].byte_length;
    leaving[day].items += 1;
  });
  return {
    now: [...leavingNow].map(index => items[index].id),
    items: items.map((item, index) => ({ id: item.id, leaves_at: leaves[index].at === null ? null : new Date(leaves[index].at).toISOString(), because: leaves[index].because, when_storage_above: above.get(index) ?? null })),
    leaving, kept_after: kept,
  };
}

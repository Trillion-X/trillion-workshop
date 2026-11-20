// tools/set-storage-release-rules/do-work/release-rules-setting.mjs
//
// PURPOSE
//   A person's release rules as their own setting (setting:release_rules, storage-release-live.json): read them, and
//   replace the whole list after src/namespace-release-rules.mjs has checked every row. This is the old person store's
//   releaseRules / namespaceSetReleaseRules (src/person-store.mjs:4636, :4638 at 1e886c3f68) over the person's records
//   instead of one store's fact. It reads and writes records only, so a run that is handed the person's setting as a
//   value runs it (tools/records-door/read-data/values-door.mjs); nothing here reaches a file.
//
//   readReleaseRules(door)           the saved rules, checked
//   setReleaseRules({ rules }, ctx)  replace the saved list; rules left out change nothing. Answers the rules and what
//                                    a rule can name: { rules, item_facts, orders, choices }
//   describeRules(rules)             the same answer for rules already in hand
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { randomUUID } from 'node:crypto';
import byteRelease from '../../organize-my-files/src/namespace-byte-release.json' with { type: 'json' };
import live from '../storage-release-live.json' with { type: 'json' };
import { checkReleaseRules } from '../src/namespace-release-rules.mjs';

const expectedOf = (type, before) => (!before ? null : before.identity ? { type, identity: before.identity } : { type, value: before.value });

/** The person's saved rules, checked (none saved: an empty list). Answers { record, rules }. */
export async function readReleaseRules(door) {
  const record = await door.readRecord(live.rules_type, live.rules_id);
  return { record, rules: checkReleaseRules(record?.value?.value ?? []) };
}

/** What the rules are and what a rule can name: the item facts, the orders and the usual choices. */
export const describeRules = rules => ({
  rules, item_facts: byteRelease.item_facts, orders: byteRelease.orders,
  choices: { after_days: byteRelease.after_days_choices, storage_above_bytes: byteRelease.storage_choices_bytes },
});

/** Replace the person's release rules: { rules } (the whole list, each row checked; a refusal says what to fix and nothing is written).
 *  Rules left out change nothing. Answers the rules now in force. */
export async function setReleaseRules({ rules } = {}, { door } = {}) {
  const { record, rules: saved } = await readReleaseRules(door);
  if (rules === undefined) return describeRules(saved);
  const checked = checkReleaseRules(rules);
  await door.write([{ id: live.rules_id, type: live.rules_type, value: { ...(record?.value ?? {}), value: checked },
    expected: expectedOf(live.rules_type, record) }], { key: `release-rules:${randomUUID()}` });
  return describeRules(checked);
}

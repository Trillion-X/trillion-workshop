// src/backing-automations.mjs
//
// Purpose: a setting on a guide screen (Plan, Connections, Account, ...) that something automatic stands
// behind says so on its own: every rule or schedule whose `backs` names that screen and that setting's id is listed
// under the setting, where the shared automation hover card previews it and a press opens it in the editor.
//
// Non-Negotiable Invariants:
//   1. The link lives in the rule's or schedule's DATA (backs: [{ screen, item }]); no screen and no id is named here.
//      `screen` is a workspace surface id (src/workspace/surfaces.json); a guide screen is found by the surfaces whose
//      surface_input.screen is its name, so the same back reaches a guide screen and a workspace screen alike.
//   2. Rows, the items under them and a catalog's fields are matched alike by their id; what a screen already listed
//      is kept. A catalog field lists only what no row or item of its section already shows, so a rule is said once.
//   3. Reading the person's automations can fail without failing the screen: then nothing is added.

import surfaces from './workspace/screens.mjs';
import { automationOpenId } from './automation-open-id.mjs';

/** The surface ids that show the guide screen with this name. */
export function surfacesShowing(name) {
  return new Set((surfaces.surfaces ?? []).filter(surface => surface.surface_input?.screen === name).map(surface => surface.surface_id));
}

/** The person's rules and schedules that name what they stand behind ({ rules, schedules } as list_* answer them). */
export async function backingAutomations(person) {
  const read = async path => {
    const answer = await person.fetch(new Request(`https://person${path}`)).catch(() => null);
    return answer?.ok ? answer.json() : null;
  };
  const [rules, schedules] = await Promise.all([read('/automations/rules'), read('/automations/schedules')]);
  return [
    ...(rules?.rules ?? []).map(rule => ({ id: automationOpenId(rule.rule_id), label: rule.label, on: rule.enabled !== false, backs: rule.backs })),
    ...(schedules?.schedules ?? []).map(schedule => ({ id: automationOpenId(schedule.schedule_id), label: schedule.label, on: schedule.enabled !== false, backs: schedule.backs })),
  ].filter(item => Array.isArray(item.backs) && item.backs.length);
}

/** The guide screen `name`'s description with each backed row, item or catalog field carrying `automations`
 *  ({ id, label, on }). */
export function withBackingAutomations(name, description, automations) {
  if (!description || !automations.length) return description;
  const shownOn = surfacesShowing(name);
  const behind = new Map();
  for (const automation of automations) for (const back of automation.backs) {
    if (!shownOn.has(back?.screen) || typeof back.item !== 'string') continue;
    behind.set(back.item, [...(behind.get(back.item) ?? []), { id: automation.id, label: automation.label, on: automation.on }]);
  }
  if (!behind.size) return description;
  const mark = node => {
    const found = behind.get(node.id);
    if (!found) return node;
    const listed = node.automations ?? [];
    return { ...node, automations: [...listed, ...found.filter(item => !listed.some(held => held.id === item.id))] };
  };
  const withoutShown = (field, rows) => {
    const shown = new Set(rows.flatMap(row => [row, ...(row.items ?? [])]).flatMap(node => (node.automations ?? []).map(item => item.id)));
    const left = (field.automations ?? []).filter(item => !shown.has(item.id));
    const { automations, ...rest } = field;
    return left.length ? { ...rest, automations: left } : rest;
  };
  return {
    ...description,
    sections: (description.sections ?? []).map(section => {
      const rows = section.rows ? section.rows.map(row => ({ ...mark(row), ...(row.items ? { items: row.items.map(mark) } : {}) })) : undefined;
      return {
        ...section,
        ...(rows ? { rows } : {}),
        ...(section.catalog?.fields ? { catalog: { ...section.catalog, fields: section.catalog.fields.map(field => withoutShown(mark(field), rows ?? [])) } } : {}),
      };
    }),
  };
}

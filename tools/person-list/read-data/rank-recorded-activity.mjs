// tools/person-list/read-data/rank-recorded-activity.mjs
//
// Ranks people by the activity records the person's own records hold. Run by `tool:rank-people-by-recorded-activity`
// through `records-door/do-work/run-an-export.mjs`, which calls rankRecordedActivity(input, { door }).
//
// An activity record is { person, kind, at } by default; `fields` names where a record keeps each of the three
// (a dotted path such as "material.created_at"), so a record shaped any other way is read by DATA, not by code.
import { rankActivity } from './rank-activity.mjs';

const ACTIVITY_KIND = 'person-activity';
const DEFAULT_FIELDS = { person: 'person', kind: 'kind', at: 'at' };
const pathValue = (record, path) => String(path).split('.').reduce((held, key) => (held && typeof held === 'object' ? held[key] : undefined), record);

/** The person's `person-activity` records, read through the door (the row's rights name this one kind). */
export async function readRecordedActivity({ door, fields = {} }) {
  const where = { ...DEFAULT_FIELDS, ...fields };
  const activity = [];
  for await (const record of door.list({ type: ACTIVITY_KIND })) {
    const value = record?.value ?? {};
    activity.push({ person: pathValue(value, where.person), kind: pathValue(value, where.kind), at: pathValue(value, where.at) });
  }
  return activity;
}

/** { weights, metrics, levels, rank_by?, now?, fields? } -> { ranked, rank_by } */
export async function rankRecordedActivity(input, { door }) {
  const { fields, ...scoring } = input;
  return rankActivity({ ...scoring, activity: await readRecordedActivity({ door, fields }) });
}

// src/workspace/note-review.mjs
//
// PURPOSE
//   The pure decisions behind a meeting note's Summary and Action Items tabs: what the saved action-items result
//   holds as items, how they group by who owns them, the task each item becomes, and what a chosen summary template
//   and language ask the person's AI for. Words and choices are DATA (meeting-review.json); nothing here reads or writes.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An item is its words and, when the saved result names one, its speaker; an item with no words is dropped.
//   2. An item's task key is made from the file's identity and the item's position, so adding the same list twice
//      is one task each (the task owner keeps a task per request key).
//   3. Every length is cut to the task owner's own limits, passed in; nothing here names a limit of its own.

const OWNER_KEYS = ['speaker', 'owner', 'assignee', 'assigned_to', 'who'];
const WORD_KEYS = ['text', 'task', 'title', 'description', 'action', 'label', 'name'];
const line = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function itemOf(value) {
  if (typeof value === 'string') return line(value) ? { text: line(value), speaker: '' } : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const textKey = WORD_KEYS.find(key => typeof value[key] === 'string' && line(value[key]));
  if (!textKey) return null;
  const speakerKey = OWNER_KEYS.find(key => typeof value[key] === 'string' && line(value[key]));
  return { text: line(value[textKey]), speaker: speakerKey ? line(value[speakerKey]) : '' };
}

/** The items of every saved action-items result (each a list, or an object holding one), in saved order. */
export function actionItemsOf(values) {
  const items = [];
  for (const value of values) {
    const list = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items
      : Array.isArray(value?.action_items) ? value.action_items : Array.isArray(value?.actionItems) ? value.actionItems : [value];
    for (const entry of list) { const item = itemOf(entry); if (item) items.push({ ...item, index: items.length }); }
  }
  return items;
}

/** Items grouped by speaker in first-seen order; those with none come last under `fallback`. */
export function groupBySpeaker(items, fallback) {
  const groups = new Map();
  for (const item of items) {
    const name = item.speaker || fallback;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  const named = [...groups].filter(([name]) => name !== fallback), rest = groups.get(fallback);
  return [...named, ...(rest ? [[fallback, rest]] : [])].map(([speaker, list]) => ({ speaker, items: list }));
}

/** The task one item becomes: created once per (file, position), with the note it came from. */
export function taskForItem({ identity, item, limits, minutes }) {
  const speaker = item.speaker ? `${item.speaker}: ` : '';
  return {
    action: 'create', title: `${speaker}${item.text}`.slice(0, limits.title_chars), duration_minutes: minutes,
    description: item.text.slice(0, limits.description_chars),
    source_id: `note:${identity}:${item.index}`.slice(0, limits.source_id_chars),
    request_key: `note-${identity.replace(/[^A-Za-z0-9_-]/g, '-')}-${item.index}`.slice(0, 160),
  };
}

/** The task id the task owner gives a request key (src/calendar-tasks.mjs `calendar-<key>`). */
export const taskIdOf = request => `calendar-${request.request_key}`;

/** What the re-run asks for: the chosen template's words (or the person's own) and the chosen language's name. */
export function summaryAsk({ templates, languages, template, language, own }) {
  const chosenOwn = own.find(row => row.id === template);
  const asked = chosenOwn?.text ?? templates.find(row => row.id === template)?.ask ?? '';
  const spoken = languages.find(row => row.id === language)?.ask ?? '';
  return { summary_template: asked, summary_language: spoken };
}

/** The saved rating (`up` or `down`) from the feedback results, newest last; '' when none. */
export const ratingOf = values => {
  const last = values.filter(value => value && (value.rating === 'up' || value.rating === 'down')).at(-1);
  return last ? last.rating : '';
};

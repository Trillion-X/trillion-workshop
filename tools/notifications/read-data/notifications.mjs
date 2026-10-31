// tools/notifications/read-data/notifications.mjs
//
// A person's notification choices and the notices recorded for them, kept as their own records and reached through the
// run's records door (tools/records-door). Nothing here delivers a notice, names a choice or infers who a notice is for:
// the options of a setting, and the audience of an event, are what the person's records say.
//
// Records:
//   notification-setting  id notification-setting:<setting>  { title?, description?, options: [{ id | value, label?, description? }], default? }
//   notification-choice   id notification-choice:<setting>  { value, at }
//   notification-event    id notification-event:<notification_id>  the event as it was given
//   notification-event-rules  id notification-event-rules:events  { kinds?: [text], privacy_classes?: [text] }
//     what the person's events may be called and how private they may be; with none, any words are accepted
export const SETTING = 'notification-setting';
export const CHOICE = 'notification-choice';
export const EVENT = 'notification-event';
export const EVENT_RULES = 'notification-event-rules';

const MOST = 100;
const USUAL = 20;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.length > 0 ? value : '');
const words = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const sorted = value => (Array.isArray(value) ? value.map(sorted) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value);
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

function settingNamed(input) {
  const setting = object(input) ? text(input.setting) : '';
  if (!setting) throw new Error('Say which setting: pass its name as setting.');
  return setting;
}

async function described(door, setting) {
  const descriptor = await door.read(SETTING, `${SETTING}:${setting}`);
  if (!object(descriptor)) return null;
  const options = (Array.isArray(descriptor.options) ? descriptor.options : []).filter(object)
    .map((option, index) => ({ id: text(option.id) || text(option.value) || text(option.key) || `option:${index}`, label: text(option.label), description: text(option.description) }))
    .map(option => ({ ...option, label: option.label || option.id }));
  return { descriptor, options };
}

const noSetting = setting => `There is no notification setting ${setting}. Save its description as a ${SETTING} record, with the options a person may choose from.`;

/**
 * tool:my-notification-choice: the options a setting describes, which one the person chose (or the setting's default),
 * and whether that choice is one of the options. A saved choice the options no longer hold is reported, not corrected.
 */
export async function myNotificationChoice(input, { door }) {
  const setting = settingNamed(input);
  const found = await described(door, setting);
  if (!found) return { setting, heading: setting, explanation: '', options: [], current: null, status: 'missing', said: noSetting(setting) };
  const { descriptor, options } = found;
  const kept = await door.read(CHOICE, `${CHOICE}:${setting}`);
  const current = (object(kept) && text(kept.value)) || text(descriptor.default) || null;
  const status = options.length === 0 ? 'empty' : current !== null && !options.some(option => option.id === current) ? 'invalid' : 'ready';
  const said = {
    empty: 'No choices are described for this setting.',
    invalid: 'The saved choice is not one of the options this setting describes.',
    ready: current === null ? 'No choice is saved yet.' : `The current choice is ${current}.`,
  }[status];
  return {
    setting, heading: text(descriptor.title) || setting, explanation: text(descriptor.description),
    options: options.map(option => ({ ...option, current: option.id === current })), current, status, said,
  };
}

/**
 * tool:choose-my-notification-choice: keeps one of the setting's described options as the person's choice. A setting
 * that is not described, or describes no options, has nothing to choose from: that is said in words and nothing is kept.
 */
export async function chooseMyNotificationChoice(input, { door }) {
  const setting = settingNamed(input);
  const choice = text(input.choice);
  if (!choice) throw new Error('Say what to choose: pass one option id as choice.');
  const found = await described(door, setting);
  if (!found) return { setting, choice, previous: null, changed: false, said: `${noSetting(setting)} Nothing was chosen.` };
  const { options } = found;
  if (options.length === 0) return { setting, choice, previous: null, changed: false, said: `The setting ${setting} describes no choices, so nothing was chosen.` };
  if (!options.some(option => option.id === choice)) throw new Error(`${choice} is not an option of ${setting}. The options are ${options.map(option => option.id).join(', ')}.`);
  const kept = await door.read(CHOICE, `${CHOICE}:${setting}`);
  const previous = (object(kept) && text(kept.value)) || null;
  if (previous === choice) return { setting, choice, previous, changed: false, said: `${setting} was already ${choice}.` };
  await door.write([{ id: `${CHOICE}:${setting}`, type: CHOICE, value: { value: choice, at: new Date().toISOString() } }], { key: `${CHOICE}:${setting}:${previous ?? 'none'}:${choice}` });
  return { setting, choice, previous, changed: true, said: `${setting} is now ${choice}.` };
}

// The names an event may carry for one of its fields, when the person's rules limit them.
async function ruleProblems(event, door) {
  const rules = await door.read(EVENT_RULES, `${EVENT_RULES}:events`);
  if (!object(rules)) return [];
  const problems = [];
  for (const [field, allowed] of [['kind', rules.kinds], ['privacy_class', rules.privacy_classes]]) {
    if (Array.isArray(allowed) && allowed.length > 0 && text(event[field]) && !allowed.includes(event[field])) {
      problems.push(`${field} ${event[field]} is not one of the ${field === 'kind' ? 'kinds' : 'privacy classes'} your ${EVENT_RULES} record allows: ${allowed.join(', ')}.`);
    }
  }
  return problems;
}

const REQUIRED_TEXT = ['notification_id', 'kind', 'conversation_ref', 'privacy_class', 'title', 'body', 'occurred_at'];
const REQUIRED_LISTS = ['audience_refs', 'source_refs', 'proof_refs'];
const OPTIONAL_TEXT = ['operationId', 'transitionId', 'idempotencyKey'];

function eventProblems(event) {
  if (!object(event)) return ['Pass the event as an object.'];
  const problems = [];
  for (const key of REQUIRED_TEXT) if (!text(event[key])) problems.push(`${key} is required and must be words.`);
  for (const key of REQUIRED_LISTS) {
    if (!Array.isArray(event[key]) || event[key].length === 0 || !event[key].every(text)) problems.push(`${key} is required and must list at least one non-empty reference.`);
  }
  for (const key of OPTIONAL_TEXT) if (key in event && typeof event[key] !== 'string') problems.push(`${key} must be words when given.`);
  const known = new Set([...REQUIRED_TEXT, ...REQUIRED_LISTS, ...OPTIONAL_TEXT]);
  for (const key of Object.keys(event)) if (!known.has(key)) problems.push(`${key} is not a field of a notification event.`);
  return problems;
}

/**
 * tool:record-a-notification: keeps one event for the audience the caller names. The caller owns the effect that
 * happened; this records the event and delivers nothing, infers no audience, and keeps the first event of an id: the
 * same event again changes nothing, a different one under the same id is refused.
 */
export async function recordANotification(input, { door }) {
  const problems = eventProblems(input);
  if (problems.length === 0) problems.push(...await ruleProblems(input, door));
  if (problems.length) throw new Error(`The notification was not recorded. ${problems.join(' ')}`);
  const id = input.notification_id;
  const kept = await door.read(EVENT, `${EVENT}:${id}`);
  if (object(kept)) {
    if (!same(kept, input)) throw new Error(`A different notification is already recorded as ${id}. Use a new notification_id for a new event.`);
    return { notification_id: id, recorded: false, said: `${id} was already recorded.` };
  }
  await door.write([{ id: `${EVENT}:${id}`, type: EVENT, value: input }], { key: `${EVENT}:${id}` });
  return { notification_id: id, recorded: true, said: `${id} is recorded for ${words(input.audience_refs.length, 'audience', 'audiences')}; nothing was delivered.` };
}

/** tool:my-notification-events: the recorded events that name this audience, newest occurrence first. */
export async function myNotificationEvents(input, { door }) {
  const audience = object(input) ? text(input.audience) : '';
  if (!audience) throw new Error('Say whose events to read: pass the audience reference as audience.');
  const most = Math.max(1, Math.min(MOST, Number(input.limit) || USUAL));
  const events = [];
  for await (const record of door.list({ type: EVENT })) {
    if (object(record.value) && Array.isArray(record.value.audience_refs) && record.value.audience_refs.includes(audience)) events.push(record.value);
  }
  events.sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
  const shown = events.slice(0, most);
  return { audience, events: shown, said: `${words(shown.length, 'event', 'events')} for ${audience}, newest first${events.length > shown.length ? `; ${events.length - shown.length} older not shown` : ''}.` };
}

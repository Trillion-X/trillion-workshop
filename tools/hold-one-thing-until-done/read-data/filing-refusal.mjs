// read-data/filing-refusal.mjs
//
// PURPOSE
//   A thing filed on the person's own Waiting on you list is refused when it gives them nothing to press or do
//   (invariant 7 of needs-you-hold.mjs, `controlOf`): a row that reaches the person with no control is a row no one can
//   finish. The refusal says what the row needs, so the AI that filed it fixes it (gives it the place where it is done,
//   a press, or steps) or does the thing itself. Marking a row done is never refused.
//
//   The words are DATA (`hold.no_control` in the Waiting on you config). The config (list, sources, sections, finishes)
//   is the caller's: this module keeps none of it. Only the refusal rule is here; nothing calls it on a filing path yet
//   (switching it on waits for the owner's word, question 32 of the short list).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: the list, its source, its section and the words are read from the config the caller passes; no name of a
//      list, source or screen is written here.
//   2. Marking a row done is never refused (`done_sets.values` on its source).
//   3. A place that is a whole narrowable screen is never the one thing to do, even with a control beside it
//      (`whole_screen`), and a place that is not a the app screen is refused (`not_a_screen`).

import { cardFieldsOf } from '../../workspace-screens/web/src/card-sections.mjs';
import { controlOf } from './needs-you-hold.mjs';

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

// The person's own list's source and section: the source whose finishing sets a row of that list.
function ownSource(config) {
  const name = Object.keys(config.sources ?? {}).find(key => config.sources[key].done_sets?.list === config.list?.id);
  return name ? { name, source: config.sources[name], section: (config.sections ?? []).find(row => row.read?.from === name) } : null;
}

/** Why a row filed on the person's own list (`config.list`) would reach them with no control, in the config's words
 *  (`hold.no_control.refused`, `whole_screen`, `not_a_screen`), or null when it has one or is being marked done. The row
 *  is read the way its source reads it (`cardFieldsOf`) and finished the way its section finishes it. `opensScreen`
 *  says whether an address opens a the app screen; `opensWhole` whether that screen is a whole narrowable one. */
export function rowControlRefusal(config, values, opensScreen = () => true, opensWhole = () => false) {
  const { source, section } = ownSource(config) ?? {};
  if (!source || !section) return null;
  if (Object.entries(source.done_sets.values ?? {}).every(([field, value]) => values?.[field] === value)) return null;
  const card = cardFieldsOf(source, { id: '', values: values ?? {} });
  const address = typeof card.does_in === 'string' ? card.does_in.trim() : '';
  if (address && opensScreen(address) && opensWhole(address)) {
    return fill(config.hold.no_control.whole_screen, { title: card.title ?? '', address, path: address.split(/[?#]/)[0] });
  }
  if (controlOf(config, section, card, opensScreen)) return null;
  const words = config.hold.no_control;
  return fill(address ? words.not_a_screen : words.refused, { title: card.title ?? '', address });
}

const QUOTES = '"\'“”‘’';
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The saved login a row's words quote, as { field, title } (invariant 4): `field` is the row field its source reads
 *  as `uses_login`, `title` the longest of `titles` quoted whole in any of the row's words; null when the row already
 *  links a login, its source reads no such field, or no title is quoted. */
export function loginNamedIn(config, values, titles) {
  const path = ownSource(config)?.source.card?.uses_login?.[0];
  const field = Array.isArray(path) && path[0] === 'values' && path.length === 2 ? path[1] : null;
  if (!field || (typeof values?.[field] === 'string' && values[field].trim())) return null;
  const words = Object.values(values ?? {}).filter(value => typeof value === 'string').join('\n');
  const title = [...titles].filter(name => typeof name === 'string' && name.trim())
    .sort((a, b) => b.length - a.length)
    .find(name => new RegExp(`[${QUOTES}]${escaped(name.trim())}[${QUOTES}]`, 'i').test(words));
  return title ? { field, title: title.trim() } : null;
}

/** A saved login a row links with quotes around its title (`"Google Gmail"`, as an AI copies a quoted name), as
 *  { field, title } with the clean title (the saved login's own spelling when one matches in any case), or null when the
 *  linked login has no quotes to strip. */
export function loginUnquoted(config, values, titles = []) {
  const path = ownSource(config)?.source.card?.uses_login?.[0];
  const field = Array.isArray(path) && path[0] === 'values' && path.length === 2 ? path[1] : null;
  const given = field && typeof values?.[field] === 'string' ? values[field] : '';
  const clean = given.trim().replace(new RegExp(`^[${QUOTES}\\s]+|[${QUOTES}\\s]+$`, 'g'), '');
  if (!field || !clean || clean === given) return null;
  return { field, title: titles.find(name => typeof name === 'string' && name.trim().toLowerCase() === clean.toLowerCase())?.trim() ?? clean };
}

/** Why a row filed on the person's own list would only ask the person to open an app on their computer, in the DATA's
 *  words (`hold.open_an_app.refused`), or null: the app opens a closed app itself (invariant 5). The row's title
 *  must ask to open, launch or start (`ask`) and the title or why speak of an app or the computer (`about`), and
 *  not be about the app itself (`except`) nor be done in a the app screen (`does_in`). Marking a row done is never refused. */
export function rowOpenAppRefusal(config, values) {
  const { source } = ownSource(config) ?? {};
  const words = config.hold?.open_an_app;
  if (!source || !words) return null;
  if (Object.entries(source.done_sets.values ?? {}).every(([field, value]) => values?.[field] === value)) return null;
  const card = cardFieldsOf(source, { id: '', values: values ?? {} });
  const title = typeof card.title === 'string' ? card.title : '';
  if (typeof card.does_in === 'string' && card.does_in.trim()) return null;
  const why = Object.values(values ?? {}).filter(value => typeof value === 'string').join('\n');
  if (!new RegExp(words.ask, 'i').test(title) || new RegExp(words.except, 'i').test(title)) return null;
  if (!new RegExp(words.about, 'i').test(`${title}\n${why}`)) return null;
  return fill(words.refused, { title });
}

/** The rows just kept on the person's own list (`kept`: [{ id, values }]) whose done is said in words
 *  (`unchecked.words_field`) but which carry no rule the app checks (the list's field of `unchecked.rule_kind`) and are
 *  not settled, as [{ row_id, said }] in the DATA's words naming what the app can check (`facts.sources`, the sources
 *  of src/done-when-facts.json). Such a row is kept (invariant 2's spirit: a filing is never refused for it), but it
 *  waits until the person says it is done, so the AI that filed it is told while it can still add the rule. */
export function uncheckedWaitingRows(config, kept, facts) {
  const words = config.unchecked;
  if (!words || !Array.isArray(kept)) return [];
  const fields = config.list.fields ?? [];
  const rule = fields.find(field => field.kind === words.rule_kind)?.id;
  const settling = fields.find(field => Array.isArray(field.settles) && field.settles.length);
  const sources = Object.entries(facts?.sources ?? {}).map(([id, def]) => `${def.prefix ? `${def.prefix}<${def.arg}>` : id} (${def.label})`).join('; ');
  return kept.flatMap(row => {
    const values = row?.values ?? {};
    const said = values[words.words_field];
    if (typeof said !== 'string' || !said.trim() || (rule && values[rule]) || (settling && settling.settles.includes(values[settling.id]))) return [];
    return [{ row_id: row.id, said: fill(words.said, { title: values[config.list.title_field] ?? row.id, done_when: said.trim(), sources }) }];
  });
}

/** Why a filing that says only the person can do it (invariant 8) would be refused, in the DATA's words
 *  (`hold.only_you_untried.refused`), or null: the filing gives `field` and the row, with what it already holds
 *  (`values`), says nothing in `tried_field`. Marking a row done is never refused. */
export function rowUntriedRefusal(config, given, values) {
  const { source } = ownSource(config) ?? {};
  const words = config.hold?.only_you_untried;
  if (!source || !words) return null;
  if (Object.entries(source.done_sets.values ?? {}).every(([field, value]) => values?.[field] === value)) return null;
  const said = value => typeof value === 'string' && value.trim() !== '';
  if (!said(given?.[words.field]) || said(values?.[words.tried_field])) return null;
  return fill(words.refused, { title: values?.[config.list.title_field] ?? '' });
}

const group = (combinator, rules) => ({ kind: 'group', combinator, negate: false, rules });
const dateMs = value => (typeof value === 'number' ? value : Number.isFinite(Date.parse(value ?? '')) ? Date.parse(value) : null);

/** The done-when check to make before a row that asks the person for facts is filed (invariant 9), as
 *  { rule, from, until } (`from`, `until` in ms), or null when the row does not ask for facts (`before_asking.asks`
 *  over `ask_fields`) or is being marked Done. The rule is over `arrived`: any arrival of one of the DATA's `routes`
 *  within the row's window (`from_field`..`until_field`, else the last `default_hours` hours before `now`). */
export function beforeAskingCheck(config, values, now = Date.now()) {
  const words = config.before_asking;
  const { source } = ownSource(config) ?? {};
  if (!words || !source) return null;
  if (Object.entries(source.done_sets.values ?? {}).every(([field, value]) => values?.[field] === value)) return null;
  const asked = words.ask_fields.map(field => values?.[field]).filter(value => typeof value === 'string').join('\n');
  if (!new RegExp(words.asks, 'i').test(asked)) return null;
  const given = { from: dateMs(values?.[words.from_field]), until: dateMs(values?.[words.until_field]) };
  const until = given.until ?? now;
  const from = given.from ?? until - words.default_hours * 3600000;
  const { route_field: route, time_field: time, ...rest } = words.rule;
  const test = (field, operator, params) => ({ kind: 'rule', field, operator, params });
  return { from, until, rule: { ...rest, tree: group('and', [group('or', words.routes.map(name => test(route, 'is_text', { text: name }))), test(time, 'between', { min: from, max: until })]) } };
}

/** Why a row that asks the person for facts is refused while their own arrivals cover its window, in the DATA's words
 *  (`before_asking.words.refused`), or null: nothing arrived (`found` is empty), or the row's `read_field` names one
 *  of the arrivals (a file name, or any words when the arrivals carry no file names). `found` is every row the done-when
 *  check passed (`check(rule, { list: true }).found`), `window` the { from, until } of beforeAskingCheck. */
export function rowArrivalsRefusal(config, values, found, window) {
  const words = config.before_asking;
  if (!words || !Array.isArray(found) || !found.length) return null;
  const names = found.flatMap(row => String(row?.files ?? '').split('\n')).map(name => name.trim()).filter(Boolean);
  const read = String(values?.[words.read_field] ?? '').toLowerCase();
  if (read.trim() && (!names.length || names.some(name => read.includes(name.split('/').pop().toLowerCase())))) return null;
  const iso = ms => new Date(ms).toISOString();
  const shown = found.slice(0, words.list_most);
  const arrivals = shown.map(row => fill(words.words.arrival, { route: row.route, at: Number.isFinite(row.at) ? iso(row.at) : row.at, files: String(row.files ?? '').split('\n').filter(Boolean).join(', ') }).trim()).join('; ');
  return fill(words.words.refused, {
    title: values?.[config.list.title_field] ?? '', count: found.length, more: found.length > shown.length ? fill(words.words.more, { rest: found.length - shown.length }) : '', from: iso(window.from), until: iso(window.until),
    places: [...new Set(found.map(row => row.route))].join(', '), arrivals, read_field: words.read_field, from_field: words.from_field, until_field: words.until_field,
  });
}

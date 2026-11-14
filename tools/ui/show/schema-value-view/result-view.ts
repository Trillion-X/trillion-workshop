// parts/ui/show/schema-value-view/result-view.ts
//
// PURPOSE
//   Turns what a tool handed back into a designed view. It reads the SHAPE of the data (a failure, a status with
//   checks, one record, a list of records, a set of numbers, text, a web address, nothing) and picks the view that
//   shape has in result-views.json (status card, summary card, item list, table, timeline, metric tiles, error card,
//   link card, empty state). Machine fields (ids, hashes, cursors, JSON text) are not shown; a moment becomes a
//   human time; the headline of a status is a sentence built from its own data ("Live, checks loaded, version from
//   3:08 PM"). SchemaValueView draws the answer with shared parts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names a tool, a workflow or a field. Which keys play which part, the words, the limits and
//      the shape-to-view rows are DATA in result-views.json; this file only evaluates conditions about structure.
//   2. No raw data is the headline, and none is hidden behind a toggle: a machine field is simply not a thing a person
//      reads. When every field of a value is a machine field, the value reads as nothing came back, never as its ids.
//   3. Pure and deterministic: the same value, schema, `now` and time zone give the same view, so it is tested
//      without a browser.
//
// KEY CONCEPTS
//   Shape rows: the first row whose `when` holds names the view. Roles: the keys that mean title, summary, state,
//   time. Phrases: a state word, the yes/no flags and the moments of a record, joined into its headline sentence.

import rules from './result-views.json';
import { relativeWhen } from '../relative-time/relative-time';
import { plainLabel, valuePieces, type JsonSchema, type ValuePiece } from './value-shape';

type Obj = Record<string, unknown>;
export type Tone = 'good' | 'bad' | 'working' | 'neutral';
export type StateView = { word: string; tone: Tone };
export type Fact = { label: string; value: string; href?: string };
export type Item = { title: string | null; state: StateView | null; summary: string | null; time: string | null; facts: Fact[]; chips: string[]; children: ResultView[] };

export type ResultView =
  | { view: 'empty-state'; message: string }
  | { view: 'error-card'; message: string; title: string }
  | { view: 'text'; label: string | null; text: string; long: boolean }
  | { view: 'link-card'; label: string | null; href: string; text: string }
  | { view: 'bullets'; label: string | null; items: string[] }
  | { view: 'status-card'; shape: string; label: string | null; headline: string; sub: string | null; tone: Tone; summary: string | null; facts: Fact[]; children: ResultView[] }
  | { view: 'summary-card'; shape: string; label: string | null; title: string | null; state: StateView | null; summary: string | null; facts: Fact[]; children: ResultView[] }
  | { view: 'metric-tiles'; label: string | null; tiles: { label: string; value: string }[] }
  | { view: 'table'; label: string | null; columns: string[]; rows: string[][] }
  | { view: 'item-list'; label: string | null; items: Item[] }
  | { view: 'timeline'; label: string | null; items: { id: string; time: string; title: string; detail?: string }[] }
  | { view: 'pieces'; label: string | null; pieces: ValuePiece[] };

export type ResultViewOptions = { schema?: JsonSchema; now?: number; timeZone?: string };
type Ctx = { now: number; timeZone?: string; depth: number };
type Shape = { id: string; view: string; when: Record<string, unknown>; state_words?: Record<string, Record<string, string>> };

const SHAPES = rules.shapes as Shape[];
const ROLES = rules.roles;
const LIMITS = rules.limits;
const WORDS = rules.words;
const MACHINE_KEY = new RegExp(rules.machine.key, 'i');
const MACHINE_VALUES = rules.machine.value.map(pattern => new RegExp(pattern));
const MACHINE_WORDS = new RegExp(rules.machine.words_in_text, 'gi');
const MOMENT = new RegExp(rules.values.moment);
const DAY_IN_TEXT = /\b(\d{4})-(\d{2})-(\d{2})\b(?![T:])/g;
const MOMENT_IN_TEXT = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z| ?UTC|[+-]\d{2}:?\d{2})?/g;
const SLUG = new RegExp(rules.values.slug);
const WEB_ADDRESS = new RegExp(rules.values.web_address);
const TIME_KEY = new RegExp(ROLES.time, 'i');
const STATE_WORDS = rules.state_words as Record<string, Record<string, string>>;
const STATE_TONE = rules.state_tone as Record<string, Record<string, Tone>>;
const FLAG_PHRASES = rules.flag_phrases as Record<string, [string, string]>;
const TIME_PHRASES = rules.time_phrases as Record<string, string>;

const isObject = (value: unknown): value is Obj => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isScalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const sentence = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');

export const isMachineKey = (key: string) => MACHINE_KEY.test(key);
export const isMachineValue = (value: unknown) => typeof value === 'string' && MACHINE_VALUES.some(pattern => pattern.test(value));

// ---------------------------------------------------------------------------------------------------------------------
// Moments, numbers and words

/** A moment as a clock time the reader can place: "3:08 PM" today, "yesterday 3:08 PM", "Sep 3, 3:08 PM". */
export function clockWhen(ms: number, now: number, timeZone?: string): string {
  const part = (options: Intl.DateTimeFormatOptions, at = ms) => new Intl.DateTimeFormat('en-US', { ...options, timeZone }).format(at);
  const day = (at: number) => part({ year: 'numeric', month: '2-digit', day: '2-digit' }, at);
  const time = part({ hour: 'numeric', minute: '2-digit' });
  if (day(ms) === day(now)) return time;
  if (day(ms) === day(now - 86_400_000)) return `yesterday ${time}`;
  const sameYear = part({ year: 'numeric' }) === part({ year: 'numeric' }, now);
  return `${part(sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })}, ${time}`;
}

const momentOf = (value: unknown, key?: string): number | null => {
  if (typeof value === 'string' && MOMENT.test(value)) { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null; }
  if (typeof value === 'number' && value >= 1e11 && value < 1e14 && key !== undefined && TIME_KEY.test(key)) return value;
  return null;
};

const number = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: LIMITS.decimals }).format(value);

/** Words with machine pieces taken out: ids and long hashes go, a timestamp inside a sentence reads as a clock time. */
export function cleanText(text: string, ctx: Pick<Ctx, 'now' | 'timeZone'>): string {
  return text
    .replace(MOMENT_IN_TEXT, found => { const iso = found.replace(' UTC', '').replace(' ', 'T'); const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`); return Number.isFinite(ms) ? clockWhen(ms, ctx.now, ctx.timeZone) : found; })
    .replace(DAY_IN_TEXT, (found, y, mo, d) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(Number(y) === new Date(ctx.now).getUTCFullYear() ? {} : { year: 'numeric' }), timeZone: 'UTC' }).format(Date.UTC(Number(y), Number(mo) - 1, Number(d))))
    .replace(MACHINE_WORDS, '')
    .replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}

function scalarWords(value: unknown, key: string, ctx: Ctx): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? WORDS.yes : WORDS.no;
  if (typeof value === 'number') { const ms = momentOf(value, key); return ms === null ? number(value) : relativeWhen(ms, ctx.now); }
  const text = String(value);
  if (MOMENT.test(text)) { const ms = Date.parse(text); if (Number.isFinite(ms)) return relativeWhen(ms, ctx.now); }
  if (SLUG.test(text)) return sentence(text.replace(/-/g, ' '));
  return cleanText(text, ctx);
}

function listWords(values: unknown[], key: string, ctx: Ctx): string {
  const shown = values.filter(value => !isMachineValue(value)).map(value => scalarWords(value, key, ctx)).filter(Boolean);
  const head = shown.slice(0, LIMITS.list_items_shown).join(', ');
  return shown.length > LIMITS.list_items_shown ? `${head}, ${fill(WORDS.more, { n: String(shown.length - LIMITS.list_items_shown) })}` : head;
}

const labelOf = (key: string, schema?: JsonSchema) => schema?.title?.trim() || plainLabel(key);

/** The first sentence of some words when they run long; the rest comes back as the remainder. */
function splitHeadline(text: string): { head: string; rest: string | null } {
  if (text.length <= LIMITS.headline_chars) return { head: text, rest: null };
  const cut = text.search(/[.!?](\s|$)/);
  if (cut < 0 || cut + 1 >= text.length) return { head: text, rest: null };
  return { head: text.slice(0, cut + 1), rest: text.slice(cut + 1).trim() || null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Fields of a record

/** The keys a person may read: schema order first, no machine key, no machine value, nothing empty. */
function visibleKeys(value: Obj, schema?: JsonSchema): string[] {
  const named = Object.keys(schema?.properties ?? {}).filter(key => key in value);
  const all = [...named, ...Object.keys(value).filter(key => !named.includes(key))];
  const texts = ['said', 'summary', 'message', 'description'].map(key => value[key]).filter((v): v is string => typeof v === 'string').join(' ');
  return all.filter(key => {
    const v = value[key];
    if (v === null || v === undefined || v === '' || isMachineKey(key) || isMachineValue(v)) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    // A list of sentences that the record's own summary already says is not said twice.
    if (Array.isArray(v) && v.length > 0 && v.every(entry => typeof entry === 'string') && texts && (v as string[]).every(entry => texts.includes(entry))) return false;
    return true;
  });
}

function stateOf(key: string, value: unknown, override?: Record<string, Record<string, string>>): StateView | null {
  if (typeof value === 'boolean') {
    const words = override?.[key] ?? STATE_WORDS[key] ?? { true: sentence(plainLabel(key).toLowerCase()), false: `Not ${plainLabel(key).toLowerCase()}` };
    const tone = STATE_TONE[key]?.[String(value)] ?? (value ? 'good' : 'bad');
    return { word: words[String(value)], tone };
  }
  if (typeof value === 'string' && value.length <= 24 && !isMachineValue(value)) {
    const lower = value.toLowerCase();
    const tones = rules.state_values as Record<string, string[]>;
    const tone = (['good', 'bad', 'working'] as const).find(name => tones[name].includes(lower)) ?? 'neutral';
    return { word: sentence(plainLabel(value.replace(/\s+/g, '_')).toLowerCase()), tone };
  }
  return null;
}

type Described = Item & {
  moments: { key: string; ms: number; nested?: string }[];
  flags: { key: string; label: string; value: boolean }[];
  headline: string | null;
  stateKey: string | null;
};

function describe(value: Obj, schema: JsonSchema | undefined, ctx: Ctx, override?: Record<string, Record<string, string>>): Described {
  const keys = visibleKeys(value, schema);
  const out: Described = { title: null, state: null, summary: null, time: null, facts: [], chips: [], children: [], moments: [], flags: [], headline: null, stateKey: null };
  const pick = (names: string[], accept: (v: unknown) => boolean) => names.find(name => keys.includes(name) && accept(value[name]));
  const titleKey = pick(ROLES.title, v => typeof v === 'string');
  const stateKey = pick(ROLES.state, v => typeof v === 'boolean' || (typeof v === 'string' && v.length <= 24));
  const summaryKey = pick(ROLES.summary, v => typeof v === 'string' || (Array.isArray(v) && v.every(isScalar)));
  const headlineKey = pick(ROLES.headline, v => typeof v === 'string');
  if (titleKey) out.title = cleanText(String(value[titleKey]), ctx);
  if (stateKey) { out.state = stateOf(stateKey, value[stateKey], override); out.stateKey = stateKey; }
  if (summaryKey) {
    const v = value[summaryKey];
    out.summary = Array.isArray(v) ? listWords(v, summaryKey, ctx) : cleanText(String(v), ctx);
  }
  if (headlineKey) out.headline = cleanText(String(value[headlineKey]), ctx);
  for (const key of keys) {
    if (key === titleKey || key === stateKey || key === summaryKey) continue;
    const v = value[key];
    const label = labelOf(key, schema?.properties?.[key]);
    const childSchema = schema?.properties?.[key];
    const ms = momentOf(v, key);
    if (ms !== null) { out.moments.push({ key, ms }); continue; }
    if (typeof v === 'boolean') { out.flags.push({ key, label, value: v }); continue; }
    if (isScalar(v)) {
      const text = scalarWords(v, key, ctx);
      if (!text) continue;
      // What the state already says is not said again as a fact.
      if (stateKey && typeof v === 'string' && String(value[stateKey]).toLowerCase() === v.toLowerCase()) continue;
      if (typeof v === 'string' && WEB_ADDRESS.test(v)) out.facts.push({ label, value: v.replace(/^https?:\/\//, '').replace(/\/$/, ''), href: v });
      else if (typeof v === 'string' && text.length > LIMITS.words_chars) out.children.push({ view: 'text', label, text, long: true });
      else out.facts.push({ label, value: text });
      continue;
    }
    if (Array.isArray(v)) {
      if (v.every(isScalar) && !v.some(entry => typeof entry === 'string' && WEB_ADDRESS.test(entry))) {
        const text = listWords(v, key, ctx); if (text) out.facts.push({ label, value: text }); continue;
      }
      const child = viewOf(v, childSchema, label, { ...ctx, depth: ctx.depth + 1 });
      if (child.view !== 'empty-state') out.children.push(child);
      continue;
    }
    if (isObject(v)) {
      const inner = visibleKeys(v, childSchema);
      if (inner.length === 0) continue;
      const innerMoments = inner.filter(name => momentOf(v[name], name) !== null);
      if (innerMoments.length === inner.length) { out.moments.push({ key, ms: momentOf(v[innerMoments[0]], innerMoments[0]) as number, nested: label }); continue; }
      if (inner.every(name => isScalar(v[name]) && typeof v[name] !== 'boolean') && inner.length <= 4) {
        out.facts.push({ label, value: inner.map(name => `${labelOf(name, childSchema?.properties?.[name]).toLowerCase()} ${scalarWords(v[name], name, ctx)}`).join(', ') });
        continue;
      }
      const child = viewOf(v, childSchema, label, { ...ctx, depth: ctx.depth + 1 });
      if (child.view !== 'empty-state') out.children.push(child);
    }
  }
  const first = out.moments.find(moment => !moment.nested) ?? out.moments[0];
  if (first) out.time = relativeWhen(first.ms, ctx.now);
  out.chips = out.flags.filter(flag => flag.value).map(flag => flag.label);
  return out;
}

const momentPhrase = (moment: { key: string; ms: number; nested?: string }, ctx: Ctx) => {
  const time = clockWhen(moment.ms, ctx.now, ctx.timeZone);
  if (moment.nested) return fill(TIME_PHRASES.nested, { parent: moment.nested.toLowerCase(), time });
  const template = TIME_PHRASES[moment.key] ?? TIME_PHRASES.default;
  return fill(template, { label: plainLabel(moment.key).toLowerCase().replace(/ (at|on)$/, ''), time });
};

const flagPhrase = (flag: { key: string; label: string; value: boolean }) => {
  const phrases = FLAG_PHRASES[flag.key];
  if (phrases) return phrases[flag.value ? 0 : 1];
  return flag.value ? flag.label.toLowerCase() : `no ${flag.label.toLowerCase()}`;
};

// ---------------------------------------------------------------------------------------------------------------------
// Shape conditions

type Profile = { error: string | null; has: (keys: string[]) => boolean; state: boolean; headline: boolean; numbers: number; onlyNumbers: boolean };

function profileOf(value: Obj, schema?: JsonSchema): Profile {
  const keys = visibleKeys(value, schema);
  const errorKey = ROLES.error.find(name => keys.includes(name) && typeof value[name] === 'string');
  const numeric = keys.filter(key => typeof value[key] === 'number' && momentOf(value[key], key) === null);
  return {
    error: errorKey && keys.length <= 3 ? String(value[errorKey]) : null,
    has: names => names.every(name => name in value),
    state: ROLES.state.some(name => keys.includes(name) && (typeof value[name] === 'boolean' || (typeof value[name] === 'string' && String(value[name]).length <= 24))),
    headline: ROLES.headline.some(name => keys.includes(name) && typeof value[name] === 'string'),
    numbers: numeric.length,
    onlyNumbers: keys.length > 0 && keys.every(key => typeof value[key] === 'number'),
  };
}

function recordsFit(list: Obj[], schema: JsonSchema | undefined, when: Record<string, unknown>, ctx: Ctx): boolean {
  const rows = list.map(item => describe(item, schema, { ...ctx, depth: 9 }));
  const most = (test: (row: Described) => boolean) => rows.filter(test).length * 2 > rows.length;
  if (when.times_at_least !== undefined && rows.filter(row => row.moments.length > 0).length < Number(when.times_at_least)) return false;
  if (when.titles && !most(row => row.title !== null)) return false;
  if (when.no_summary && rows.some(row => row.summary !== null || row.headline !== null)) return false;
  if (when.no_title_and_state && rows.some(row => row.title !== null && row.state !== null)) return false;
  if (when.short_columns_at_most !== undefined) return tableOf(list, schema, ctx) !== null;
  return true;
}

function shapeFor(value: unknown, schema: JsonSchema | undefined, ctx: Ctx): Shape | null {
  const empty = value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
    || (isObject(value) && visibleKeys(value, schema).length === 0) || isMachineValue(value);
  const profile = isObject(value) ? profileOf(value, schema) : null;
  const records = Array.isArray(value) && value.length > 0 && value.every(isObject) ? value as Obj[] : null;
  const named = isObject(value) && visibleKeys(value, schema).length > 0 && visibleKeys(value, schema).every(key => isObject(value[key]) && visibleKeys(value[key] as Obj).length > 0);
  for (const row of SHAPES) {
    const when = row.when;
    if (when.empty) { if (empty) return row; continue; }
    if (empty) continue;
    if (when.error_field) { if (profile?.error) return row; continue; }
    if (when.web_address) { if (typeof value === 'string' && WEB_ADDRESS.test(value)) return row; continue; }
    if (when.words) { if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return row; continue; }
    if (when.named_records) { if (named && !records) return row; continue; }
    if (when.records) { if (records && recordsFit(records, schema?.items, when, ctx)) return row; continue; }
    if (when.record) {
      if (!profile) continue;
      if (when.has && !profile.has(when.has as string[])) continue;
      if (when.state && !profile.state) continue;
      if (when.headline && !profile.headline) continue;
      if (when.numbers_at_least !== undefined && profile.numbers < Number(when.numbers_at_least)) continue;
      if (when.nothing_else && !profile.onlyNumbers) continue;
      return row;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Views

function tableOf(list: Obj[], schema: JsonSchema | undefined, ctx: Ctx): { columns: string[]; rows: string[][] } | null {
  const keys: string[] = [];
  for (const item of list) for (const key of visibleKeys(item, schema)) if (!keys.includes(key)) keys.push(key);
  // Addresses keep their navigation through the existing linked fact/list views.
  const plain = (v: unknown) => isScalar(v) && !(typeof v === 'string' && WEB_ADDRESS.test(v));
  const short = (v: unknown) => plain(v) || (Array.isArray(v) && v.every(plain));
  if (keys.length === 0 || keys.length > LIMITS.table_columns || !list.every(item => keys.every(key => !(key in item) || short(item[key])))) return null;
  const rows = list.map(item => keys.map(key => { const v = item[key]; return Array.isArray(v) ? listWords(v, key, ctx) : scalarWords(v, key, ctx); }));
  if (rows.some(row => row.some(cell => cell.length > LIMITS.short_cell_chars))) return null;
  return { columns: keys.map(key => labelOf(key, schema?.properties?.[key])), rows };
}

function itemOf(value: Obj, schema: JsonSchema | undefined, ctx: Ctx, fallbackTitle?: string): Item {
  const d = describe(value, schema, ctx);
  // The compact fact limit never removes a link the person can act on.
  const inList = d.facts.filter((fact, index) => index < LIMITS.facts_in_item || fact.href);
  return { title: d.title ?? fallbackTitle ?? null, state: d.state, summary: d.summary ?? d.headline, time: d.time, facts: inList, chips: d.chips, children: d.children };
}

function statusView(shape: Shape, value: Obj, schema: JsonSchema | undefined, label: string | null, ctx: Ctx): ResultView {
  const d = describe(value, schema, ctx, shape.state_words);
  const phrases = [
    ...(d.state ? [d.state.word] : []),
    ...d.flags.map(flagPhrase),
    ...d.moments.map(moment => momentPhrase(moment, ctx)),
  ];
  const tone: Tone = d.state?.tone ?? (d.flags.some(flag => !flag.value) ? 'bad' : 'neutral');
  const line = phrases.length ? sentence(phrases.join(', ')) : null;
  if (d.headline) {
    const { head, rest } = splitHeadline(d.headline);
    const sub = [d.title && d.title !== d.headline ? d.title : null, line].filter(Boolean).join(' · ') || null;
    return { view: 'status-card', shape: shape.id, label, headline: head, sub, tone, summary: rest ?? (d.summary && d.summary !== d.headline ? d.summary : null), facts: d.facts, children: d.children };
  }
  return { view: 'status-card', shape: shape.id, label, headline: line ?? (d.title ?? ''), sub: line && d.title ? d.title : null, tone, summary: d.summary, facts: d.facts, children: d.children };
}

/** A value as a designed view, picked by its shape. */
export function viewOf(value: unknown, schema: JsonSchema | undefined, label: string | null, ctx: Ctx): ResultView {
  if (Array.isArray(value) && value.length > 0 && value.every(isScalar)) {
    const shown = value.filter(entry => !isMachineValue(entry) && scalarWords(entry, label ?? '', ctx));
    if (shown.some(entry => typeof entry === 'string' && WEB_ADDRESS.test(entry))) {
      return { view: 'item-list', label, items: shown.map(entry => {
        const href = typeof entry === 'string' && WEB_ADDRESS.test(entry) ? entry : null;
        return { title: href ? null : scalarWords(entry, label ?? '', ctx), summary: null, state: null, time: null, chips: [], children: [],
          facts: href ? [{ label: WORDS.open_link, value: href.replace(/^https?:\/\//, '').replace(/\/$/, ''), href }] : [] };
      }) };
    }
    const items = shown.map(entry => scalarWords(entry, label ?? '', ctx)).filter(Boolean);
    return items.length ? { view: 'bullets', label, items } : { view: 'empty-state', message: WORDS.nothing };
  }
  const shape = shapeFor(value, schema, ctx);
  if (!shape || ctx.depth > 4) return fallback(value, schema, label);
  switch (shape.view) {
    case 'empty-state': return { view: 'empty-state', message: WORDS.nothing };
    case 'error-card': return { view: 'error-card', title: WORDS.failure_title, message: profileOf(value as Obj, schema).error as string };
    case 'link-card': return { view: 'link-card', label, href: value as string, text: (value as string).replace(/^https?:\/\//, '').replace(/\/$/, '') };
    case 'text': { const text = scalarWords(value, label ?? '', ctx); return { view: 'text', label, text, long: text.length > LIMITS.words_chars || text.includes('\n') }; }
    case 'status-card': return statusView(shape, value as Obj, schema, label, ctx);
    case 'metric-tiles': {
      const obj = value as Obj;
      return { view: 'metric-tiles', label, tiles: visibleKeys(obj, schema).map(key => ({ label: labelOf(key, schema?.properties?.[key]), value: number(obj[key] as number) })) };
    }
    case 'timeline': {
      const items = (value as Obj[]).map((record, index) => {
        const d = describe(record, schema?.items, { ...ctx, depth: 9 });
        return { id: String(index), time: d.moments[0] ? clockWhen(d.moments[0].ms, ctx.now, ctx.timeZone) : '', title: d.title ?? '', ...(d.state ? { detail: d.state.word } : {}) };
      });
      return { view: 'timeline', label, items };
    }
    case 'table': { const table = tableOf(value as Obj[], schema?.items, ctx) as { columns: string[]; rows: string[][] }; return { view: 'table', label, ...table }; }
    case 'item-list':
      if (Array.isArray(value)) return { view: 'item-list', label, items: (value as Obj[]).map(record => itemOf(record, schema?.items, ctx)) };
      return { view: 'item-list', label, items: visibleKeys(value as Obj, schema).map(key => itemOf((value as Obj)[key] as Obj, schema?.properties?.[key], ctx, labelOf(key, schema?.properties?.[key]))) };
    case 'summary-card': {
      const d = describe(value as Obj, schema, ctx);
      const flagFacts = d.flags.map(flag => ({ label: flag.label, value: flag.value ? WORDS.yes : WORDS.no }));
      const momentFacts = d.moments.map(moment => ({ label: moment.nested ?? plainLabel(moment.key), value: relativeWhen(moment.ms, ctx.now) }));
      const facts = [...d.facts, ...flagFacts, ...momentFacts];
      // A wrapper around one thing (a record that only holds a list) shows that thing, not an empty card around it.
      if (!d.title && !d.state && !d.summary && facts.length === 0 && d.children.length === 1) {
        return d.children[0];
      }
      return { view: 'summary-card', shape: shape.id, label, title: d.title, state: d.state, summary: d.summary, facts, children: d.children };
    }
    default: return fallback(value, schema, label);
  }
}

/** Every field in plain words, for a value no row of shapes describes. Machine fields are still left out. */
function fallback(value: unknown, schema: JsonSchema | undefined, label: string | null): ResultView {
  return { view: 'pieces', label, pieces: valuePieces(withoutMachineFields(value), schema, label) };
}

export function withoutMachineFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMachineFields);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).filter(([key, v]) => !isMachineKey(key) && !isMachineValue(v)).map(([key, v]) => [key, withoutMachineFields(v)]));
  return value;
}

/** The designed view of a tool's result. `now` and `timeZone` are only for tests. */
export function resultView(value: unknown, options: ResultViewOptions = {}): ResultView {
  return viewOf(value, options.schema, null, { now: options.now ?? Date.now(), timeZone: options.timeZone, depth: 0 });
}

/** Every word the view says in its headline and summary places, for checks that no machine field leaks. */
export function sayings(view: ResultView): string[] {
  switch (view.view) {
    case 'status-card': return [view.headline, view.sub ?? '', view.summary ?? '', ...view.facts.map(f => `${f.label} ${f.value}`), ...view.children.flatMap(sayings)];
    case 'summary-card': return [view.title ?? '', view.summary ?? '', ...view.facts.map(f => `${f.label} ${f.value}`), ...view.children.flatMap(sayings)];
    case 'item-list': return view.items.flatMap(item => [item.title ?? '', item.summary ?? '', item.time ?? '', ...item.facts.map(f => `${f.label} ${f.value}`), ...item.chips, ...item.children.flatMap(sayings)]);
    case 'table': return [...view.columns, ...view.rows.flat()];
    case 'timeline': return view.items.flatMap(item => [item.time, item.title, item.detail ?? '']);
    case 'metric-tiles': return view.tiles.flatMap(tile => [tile.label, tile.value]);
    case 'error-card': return [view.title, view.message];
    case 'text': return [view.text];
    case 'link-card': return [view.text];
    case 'bullets': return view.items;
    case 'empty-state': return [view.message];
    default: return [];
  }
}

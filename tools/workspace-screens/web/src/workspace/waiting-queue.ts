// src/workspace/waiting-queue.ts
//
// PURPOSE
//   What is waiting on the person (src/waiting-on-you.json, the answer GET /work/api/waiting-on-you gives), read as one
//   queue and as the way each thing in it is finished. Home's Needs you stack (needs-you.tsx) and the one-at-a-time
//   queue (waiting-screen.tsx, the screen at /waiting) both read it from here, so a thing finishes the same way wherever
//   it is shown.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a kind of waiting thing, a section, a finish or a tool: every one is the answer's DATA.
//   2. The queue is every section's cards in the DATA's order (most urgent first); its total counts what each section
//      holds (`total`, else its cards), so "3 of 214" is true even when a section sends only its first cards.
//   3. A card's validated task-specific `response` wins. Without one, its finish is the answer's `finishes` row
//      whose `choice` is the card's `finish`, else its section's `finish` (the DATA's default); a malformed response
//      opens safely, and a legacy card with neither response nor finish uses its section's form, or else opens.
//   4. A run's input value is one of: from the card (`card`), from a box (`field`), fixed (`value`), or words filled
//      from the boxes, then the card (`template`, `{name}` for each); a box of kind `file` hands its file as
//      `[{ identity }]`; a box of kind `record` hands the title of the row chosen (a tool that takes a plain name), or the
//      part a `{ field, part }` names (`id`, `title`, `list_id`). A value left empty is left out, and a run whose `when` names an empty box or card field is
//      skipped.
//   5. A section with `batch` is ONE thing, its every card done in one pass: one box per card (its title, its clip), and
//      the section's form runs once for each box filled, the box's words standing for the form's first box.
//   6. Words said about one waiting thing away from the screen (a spoken or typed answer to a notice about it,
//      `finishByWords`) finish it the same way: a press finishes only on words the caller counts as done, a form's
//      words fill its one box that takes words and its runs follow, a thing Trillion checks itself is only said, and
//      a thing that needs more than words (a file, several boxes, a batch, opening it) stays waiting for the screen.
//   7. A thing's words are read as what they are: numbered lines are its steps, one each (`detailParts`), and a step's
//      short value after its last `: ` is a value to copy (`stepValue`); everything else is a passage to read.
//   8. A thing is named by its queue key, its card's id, or the id of any card a batch holds, so a link to one unnamed
//      voice (`/waiting?thing=<card id>`, the address its source gives it) opens that pass (`queueThing`).
//   9. A call an AI proposes (`response` kind `call`: one Workshop tool, its proposed input, and `amend`, the boxes the
//      person may change) is a form like any other: each `amend` box starts with the proposed value (`proposed`), every
//      other input is fixed as proposed, so the person can change only what `amend` names and runs exactly the call they
//      approved, edited or not. A box whose proposed value is a number, true/false or a list/object hands its edited
//      words back in that type (the tool's own input schema still checks them when it runs). Words confirming it
//      (`finishByWords`) approve the call as proposed.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { recordPart, recordText, suggestionsIn, validRecordField, type RecordFrom, type RecordNew, type RecordSuggestion } from 'trillion-workshop/tools/ui/show/record-picker/record-value.ts';
import { STEP_LINE, batchCard, thingKeyOf } from 'trillion-workshop/tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs';

export type Spec = { card: string } | { field: string; part?: RecordPart } | { value: unknown } | { template: string };
/** Which part of a record field's chosen row a run reads: its title (a tool taking a plain name), its id or its list. */
export type RecordPart = 'id' | 'title' | 'list_id';
export type Run = { tool_id: string; when?: string[]; input: Record<string, Spec> };
export type FormField = {
  name: string; label: string; placeholder?: string; optional?: boolean; kind?: string; takes?: string;
  options?: { value: string; label: string }[];
  /** `record`: where its rows come from, where a new one is made, and the card field holding suggestions. */
  from?: RecordFrom; new?: RecordNew; suggest?: string;
  /** The suggestions of this card (`suggest` read from it), added when the form is built for a card. */
  suggestions?: RecordSuggestion[];
  /** The value an AI proposed for this box (invariant 9): the box starts with it, and an edit is handed back in its type. */
  proposed?: unknown;
};
export type SectionForm = { title: string; submit: string; fields: FormField[]; runs: Run[] };
export type Finish = { choice: string; press?: string; said?: string; form?: { fields: FormField[]; runs: Run[] }; checked?: string };
export function clipRangeOf(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [start, end] = value;
  return typeof start === 'number' && Number.isFinite(start) && start >= 0
    && typeof end === 'number' && Number.isFinite(end) && end > start ? [start, end] : null;
}

export type NeedsCard = {
  id: string; title?: string; detail?: string; at?: string; action?: string; address?: string; clip?: string; clip_at?: [number, number]; clip_status?: 'short_clip' | 'full_recording' | 'not_found' | 'not_checked';
  opens?: { screen?: string; input?: Record<string, unknown> } | { link: string }; done_by_opening?: boolean; finish?: string;
  [field: string]: unknown;
};
/** A section done in one pass instead of card by card (52 unnamed voices are one thing): its words, `{count}` filled. */
export type SectionBatch = { title: string; detail?: string; action?: string; submit: string; placeholder?: string; none?: string; requires?: string; why?: string; also?: string; unavailable?: string };
export type NeedsSection = { id: string; title: string; action?: string; icon?: string; on_home?: boolean; hold?: boolean; batch?: SectionBatch; form?: SectionForm; supplemental?: { cursor_param: string; page_size: number }; cursor?: string | null; has_more?: boolean; all_done?: string; finish?: string; total?: number; cards: NeedsCard[] };
export type NeedsAnswer = { sections: NeedsSection[]; finishes?: Finish[] };

export const mergeSupplementalPage = (answer: NeedsAnswer, page: NeedsAnswer, sectionId: string): NeedsAnswer => ({
  ...answer,
  sections: answer.sections.map(section => {
    if (section.id !== sectionId) return section;
    const extra = page.sections.find(candidate => candidate.id === sectionId);
    if (!extra) return section;
    const seen = new Set(section.cards.map(card => card.id));
    const additions = extra.cards.filter(card => {
      if (seen.has(card.id)) return false;
      seen.add(card.id);
      return true;
    });
    const cards = [...section.cards, ...additions];
    return { ...section, ...extra, total: (section.total ?? section.cards.length) + additions.length, cards };
  }),
});

/** Follow DATA-declared pages until a required batch has an eligible card or the source is exhausted. */
export async function loadSupplementalPages(
  answer: NeedsAnswer,
  readPage: (query: string, cursor: string, signal?: AbortSignal) => Promise<NeedsAnswer>,
  signal?: AbortSignal,
): Promise<NeedsAnswer> {
  let current = answer;
  for (const original of answer.sections) {
    const paging = original.supplemental;
    if (!paging || !original.batch?.requires || eligibleBatchCards(original).length || original.has_more !== true) continue;
    let section = current.sections.find(row => row.id === original.id) ?? original;
    const requested = new Set<string>();
    while (true) {
      if (signal?.aborted) return current;
      const cursor = section.cursor;
      if (typeof cursor !== 'string' || !cursor || requested.has(cursor)) break;
      requested.add(cursor);
      const page = await readPage(paging.cursor_param, cursor, signal);
      if (signal?.aborted) return current;
      const next = page.sections.find(row => row.id === section.id);
      if (!next) break;
      current = mergeSupplementalPage(current, page, section.id);
      section = current.sections.find(row => row.id === original.id) ?? section;
      if (eligibleBatchCards(section).length || next.has_more !== true) break;
    }
  }
  return current;
}

/** Choose the surviving held task at the departed task's former rank. */
export function successorAfterRemoval<T extends { key: string }>(key: string, previous: readonly { key: string }[], current: readonly T[]): T | null {
  if (!current.length) return null;
  const index = previous.findIndex(item => item.key === key);
  return current[Math.min(Math.max(index, 0), current.length - 1)] ?? null;
}

/** A task-specific response surface carried by one card. The person's Waiting on you list stores this as JSON text so
 *  the existing typed list owner can create, edit, read and delete it. It is parsed and validated here, once, before
 *  either human surface or finishByWords uses it. Passwords and secrets are deliberately not a field kind: credentials
 *  belong on the service's own page, reached with an open response. */
export type CardResponse =
  | { kind: 'open'; label?: string; finishes?: boolean }
  | { kind: 'press'; label: string; said?: string }
  | { kind: 'checked'; checked: string }
  | { kind: 'form'; label: string; submit: string; said?: string; fields: FormField[]; runs: Run[] };

const fieldKinds = new Set(['text', 'long-text', 'link', 'file', 'email', 'phone', 'number', 'date', 'choice', 'boolean', 'record']);
const parts = new Set(['id', 'title', 'list_id']);
const word = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function validSpec(value: unknown, fields: Set<string>): value is Spec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as object);
  // A field may say which part of a chosen record it reads (`part`); nothing else takes one.
  if (keys.length === 2 && keys.includes('field') && keys.includes('part')) return parts.has((value as Record<string, unknown>).part as string) && fields.has(word((value as Record<string, unknown>).field) ?? '');
  if (keys.length !== 1 || !['card', 'field', 'value', 'template'].includes(keys[0])) return false;
  if (own(value as object, 'value')) return true;
  const named = word((value as Record<string, unknown>)[keys[0]]);
  return Boolean(named && (keys[0] !== 'field' || fields.has(named)));
}

function validRun(value: unknown, fields: Set<string>): value is Run {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  if (!word(run.tool_id) || !run.input || typeof run.input !== 'object' || Array.isArray(run.input)) return false;
  if (run.when !== undefined && (!Array.isArray(run.when) || run.when.some(name => !word(name)))) return false;
  return Object.values(run.input as Record<string, unknown>).every(spec => validSpec(spec, fields));
}

function parsedResponse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

/** A validated card response. null means the card has no response and may use its legacy finish. invalid means it
 *  tried to carry one but it was unsafe or malformed, so the task stays recoverable by opening it instead. */
export function responseOf(value: unknown): CardResponse | 'invalid' | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parsedResponse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid';
  const response = parsed as Record<string, unknown>;
  if (response.kind === 'open') {
    const label = response.label === undefined ? undefined : word(response.label);
    if (response.label !== undefined && !label) return 'invalid';
    if (response.finishes !== undefined && typeof response.finishes !== 'boolean') return 'invalid';
    return { kind: 'open', ...(label ? { label } : {}), ...(typeof response.finishes === 'boolean' ? { finishes: response.finishes } : {}) };
  }
  if (response.kind === 'press') {
    const label = word(response.label);
    const said = response.said === undefined ? undefined : word(response.said);
    return label && (response.said === undefined || said) ? { kind: 'press', label, ...(said ? { said } : {}) } : 'invalid';
  }
  if (response.kind === 'checked') {
    const checked = word(response.checked);
    return checked ? { kind: 'checked', checked } : 'invalid';
  }
  if (response.kind === 'call') return proposedCallForm(response);
  if (response.kind !== 'form' || !Array.isArray(response.fields) || !Array.isArray(response.runs)) return 'invalid';
  const label = word(response.label);
  const submit = word(response.submit);
  const said = response.said === undefined ? undefined : word(response.said);
  if (!label || !submit || (response.said !== undefined && !said) || !response.runs.length || response.runs.length > 20) return 'invalid';
  const fields = validFields(response.fields);
  if (!fields || !response.runs.every(run => validRun(run, new Set(fields.map(field => field.name))))) return 'invalid';
  return { kind: 'form', label, submit, ...(said ? { said } : {}), fields, runs: response.runs as Run[] };
}

/** One form box checked, or null when it is malformed (a box of a response form, or a box of a proposed call). */
function validField(value: unknown): FormField | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const field = value as Record<string, unknown>;
  const name = word(field.name);
  const fieldLabel = word(field.label);
  const kind = field.kind === undefined ? 'long-text' : word(field.kind);
  if (!name || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || !fieldLabel || !kind || !fieldKinds.has(kind)) return null;
  const placeholder = field.placeholder === undefined ? undefined : word(field.placeholder);
  if (field.placeholder !== undefined && !placeholder) return null;
  if (field.optional !== undefined && typeof field.optional !== 'boolean') return null;
  const takes = field.takes === undefined ? undefined : word(field.takes);
  if (field.takes !== undefined && (!takes || kind !== 'file')) return null;
  let options: { value: string; label: string }[] | undefined;
  if (kind === 'choice') {
    if (!Array.isArray(field.options) || !field.options.length || field.options.length > 50) return null;
    options = [];
    const values = new Set<string>();
    for (const option of field.options) {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
      const optionValue = word((option as Record<string, unknown>).value);
      const optionLabel = word((option as Record<string, unknown>).label);
      if (!optionValue || !optionLabel || values.has(optionValue)) return null;
      values.add(optionValue);
      options.push({ value: optionValue, label: optionLabel });
    }
  } else if (field.options !== undefined) return null;
  if (kind === 'record' ? !validRecordField(field) : field.from !== undefined || field.new !== undefined || field.suggest !== undefined) return null;
  return { name, label: fieldLabel, ...(placeholder ? { placeholder } : {}), ...(field.optional === true ? { optional: true } : {}),
    ...(field.kind !== undefined ? { kind } : {}), ...(takes ? { takes } : {}), ...(options ? { options } : {}),
    ...(kind === 'record' ? { from: field.from as RecordFrom, ...(field.new ? { new: field.new as RecordNew } : {}), ...(field.suggest ? { suggest: field.suggest as string } : {}) } : {}) };
}

/** Form boxes, 1 to 20 with distinct names, or null when any is malformed. */
function validFields(values: unknown[], most = 20): FormField[] | null {
  if (!values.length || values.length > most) return null;
  const fields = values.map(validField);
  if (fields.some(field => !field)) return null;
  const names = new Set(fields.map(field => field!.name));
  return names.size === fields.length ? fields as FormField[] : null;
}

/** A proposed call (invariant 9) as the form it is: each `amend` box starts with its proposed value, every other input is
 *  fixed as proposed, and the one run is the tool with those inputs. 'invalid' when malformed. */
function proposedCallForm(response: Record<string, unknown>): CardResponse | 'invalid' {
  const label = word(response.label);
  const submit = word(response.submit);
  const said = response.said === undefined ? undefined : word(response.said);
  const toolId = word(response.tool_id);
  const input = response.input;
  if (!label || !submit || (response.said !== undefined && !said) || !toolId || !input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(response.amend)) return 'invalid';
  const amend = validFields(response.amend);
  if (!amend) return 'invalid';
  const proposed = input as Record<string, unknown>;
  const amendable = new Set(amend.map(field => field.name));
  const fields = amend.map(field => (own(proposed, field.name) ? { ...field, proposed: proposed[field.name] } : field));
  const fixed = Object.entries(proposed).filter(([name]) => !amendable.has(name)).map(([name, value]) => [name, { value }] as const);
  const run: Run = { tool_id: toolId, input: Object.fromEntries([...fixed, ...amend.map(field => [field.name, { field: field.name }] as const)]) };
  return { kind: 'form', label, submit, ...(said ? { said } : {}), fields, runs: [run] };
}

/** A proposed value as the words its box starts with. */
const proposedWords = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);

/** The words each box of a proposed call starts with (invariant 9): the screen's `start` for the form. */
export const startOf = (fields: FormField[]): Record<string, string> =>
  Object.fromEntries(fields.filter(field => field.proposed !== undefined && field.proposed !== null).map(field => [field.name, proposedWords(field.proposed)]));

/** A box's edited words handed back in the type of its proposed value; words that do not read as that type stay words,
 *  so the tool's own input schema refuses them in its own words. */
function inProposedType(words: string, proposed: unknown): unknown {
  if (typeof proposed === 'number') { const number = Number(words); return words.trim() && Number.isFinite(number) ? number : words; }
  if (typeof proposed === 'boolean') return words === 'true' ? true : words === 'false' ? false : words;
  if (proposed && typeof proposed === 'object') { try { return JSON.parse(words); } catch { return words; } }
  return words;
}

export type QueueItem = { key: string; section: NeedsSection; card: NeedsCard };

export const known = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== '';

/** A batch section's cards as the one thing the person does in one pass (trillion-workshop tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs `batchCard`, the
 *  same card the hold holds). */
export const eligibleBatchCards = (section: NeedsSection, cards = section.cards) =>
  section.batch?.requires ? cards.filter(card => Boolean(card[section.batch!.requires!])) : cards;

export const unavailableBatchCount = (section: NeedsSection, cards = section.cards) =>
  section.batch?.requires ? cards.length - eligibleBatchCards(section, cards).length : 0;

export const batchCardOf = (section: NeedsSection, cards = section.cards): NeedsCard & { batch: NeedsCard[] } => {
  const eligible = eligibleBatchCards(section, cards);
  const card = batchCard(section, cards) as NeedsCard & { batch: NeedsCard[] };
  const first = eligible[0];
  return { ...card, ...(first?.opens ? { opens: first.opens } : {}), ...(first?.address ? { address: first.address } : {}), batch: eligible };
};

/** Every waiting thing, one after another, in the answer's order; a batch section is one thing (invariant 5). Each
 *  thing's key is the one the hold, take-me-there and the screen at /waiting/<key> name it by (trillion-workshop tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs
 *  `thingKeyOf`). */
export const queueOf = (answer: NeedsAnswer | null | undefined): QueueItem[] =>
  (answer?.sections ?? []).flatMap(section => section.batch
    ? (eligibleBatchCards(section).length ? [{ key: thingKeyOf(section, eligibleBatchCards(section)[0]), section, card: batchCardOf(section) }] : [])
    : section.cards.map(card => ({ key: thingKeyOf(section, card), section, card })));

/** Whether a queue item is the thing an id names: its queue key, its card's id, or one of the cards a batch holds
 *  (invariant 8). */
const isThing = (item: QueueItem, thing: string) =>
  item.key === thing || item.card.id === thing || (Array.isArray(item.card.batch) && (item.card.batch as NeedsCard[]).some(card => card.id === thing));

/** The one waiting thing a key names (invariant 8), else the card whose id ends with it (a card's id without its
 *  source); a card inside a batch section names that whole batch, the one thing it is done in. */
export function queueThing(answer: NeedsAnswer | null | undefined, key: string): QueueItem | null {
  const queue = queueOf(answer);
  return queue.find(item => isThing(item, key))
    ?? queue.find(item => [item.card, ...(Array.isArray(item.card.batch) ? item.card.batch as NeedsCard[] : [])].some(card => card.id.endsWith(`:${key}`)))
    ?? null;
}

/** How many things wait, counting what each section holds beyond the cards it sent; a batch section counts once. */
export const totalOf = (answer: NeedsAnswer | null | undefined) =>
  (answer?.sections ?? []).reduce((sum, section) => sum + (section.batch ? Math.min(1, eligibleBatchCards(section).length) : Math.max(section.total ?? 0, section.cards.length)), 0);

/** The way this card is finished, from the answer's `finishes`: the card's own choice, else its section's; null when
 *  neither names one the answer has. */
export function finishOf(answer: NeedsAnswer | null | undefined, section: NeedsSection, card: NeedsCard): Finish | null {
  const choice = typeof card.finish === 'string' && card.finish ? card.finish : section.finish;
  return (choice && answer?.finishes?.find(finish => finish.choice === choice)) || null;
}

/** `{name}` in words, filled from the boxes (a chosen record by its title), then the card; a name neither has is left empty. */
export const filledWords = (template: string, card: NeedsCard, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_whole, name: string) => (known(values[name]) ? recordText(values[name]) : known(card[name]) ? String(card[name]) : ''));

/** The form's fields for one card: each record field carrying the suggestions its `suggest` card field holds. */
export const fieldsFor = (fields: FormField[], card: NeedsCard): FormField[] =>
  fields.map(field => (field.kind === 'record' && field.suggest ? { ...field, suggestions: suggestionsIn(card[field.suggest]) } : field));

/** One input value of a run. */
export function valueOf(spec: Spec, card: NeedsCard, values: Record<string, string>, fields: FormField[] = []): unknown {
  if ('card' in spec) return card[spec.card];
  if ('template' in spec) return filledWords(spec.template, card, values);
  if ('field' in spec) {
    const value = values[spec.field];
    const box = fields.find(field => field.name === spec.field);
    // A chosen record answers a run with its title (a tool taking a plain name), or the part the run asks for.
    if (box?.kind === 'record') return recordPart(value, spec.part);
    if (box?.kind === 'file') return known(value) ? [{ identity: value }] : value;
    return box && box.proposed !== undefined && typeof value === 'string' ? inProposedType(value, box.proposed) : value;
  }
  return spec.value;
}

/** The runs to make, in order, each with its filled input: skipped when `when` names something empty. */
export function runsOf(runs: Run[], card: NeedsCard, values: Record<string, string>, fields: FormField[] = []) {
  return runs
    .filter(run => !(run.when ?? []).some(name => !known(values[name] ?? card[name])))
    .map(run => ({
      tool_id: run.tool_id,
      input: Object.fromEntries(Object.entries(run.input)
        .map(([name, spec]) => [name, valueOf(spec, card, values, fields)] as const)
        .filter(([, value]) => Array.isArray(value) ? value.length > 0 : known(value))),
    }));
}

/** What finishing a card looks like, first from its validated response and then the legacy finish fallback: a press
 *  that marks it done, a form whose runs finish it, words saying Trillion takes it off itself, or opening it. */
export type Way =
  | { kind: 'batch'; batch: SectionBatch; form: SectionForm; cards: NeedsCard[] }
  | { kind: 'press'; finish: Finish }
  | { kind: 'form'; finish: Finish; fields: FormField[]; runs: Run[]; submit: string }
  | { kind: 'checked'; finish: Finish }
  | { kind: 'section-form'; form: SectionForm }
  | { kind: 'open'; label?: string; finishes?: boolean };

export function wayOf(answer: NeedsAnswer | null | undefined, section: NeedsSection, card: NeedsCard): Way {
  if (section.batch && section.form && Array.isArray(card.batch)) return { kind: 'batch', batch: section.batch, form: section.form, cards: card.batch as NeedsCard[] };
  const response = responseOf(card.response);
  if (response === 'invalid') return { kind: 'open' };
  if (response?.kind === 'open') return response;
  if (response?.kind === 'checked') return { kind: 'checked', finish: { choice: response.checked, checked: response.checked } };
  if (response?.kind === 'press') return { kind: 'press', finish: { choice: response.label, press: response.label, ...(response.said ? { said: response.said } : {}) } };
  if (response?.kind === 'form') {
    const finish: Finish = { choice: response.label, press: response.submit, ...(response.said ? { said: response.said } : {}), form: { fields: response.fields, runs: response.runs } };
    return { kind: 'form', finish, fields: response.fields, runs: response.runs, submit: response.submit };
  }
  const finish = finishOf(answer, section, card);
  if (finish?.checked) return { kind: 'checked', finish };
  if (finish?.form) return { kind: 'form', finish, fields: finish.form.fields, runs: finish.form.runs, submit: finish.press ?? finish.choice };
  if (finish) return { kind: 'press', finish };
  if (section.form) return { kind: 'section-form', form: section.form };
  return { kind: 'open' };
}

/** Where the card opens on the web, when it has its own place (a link); a screen inside Trillion is not one. */
export const linkOf = (card: NeedsCard) => (card.opens && 'link' in card.opens && card.opens.link) || null;

/** What words said about one waiting thing do (invariant 6), as a plan the caller carries out: `gone` (it no longer
 *  waits), `checked` (Trillion takes it off itself; `said`), `by-screen` (words cannot finish it), `not-done` (a press
 *  the words did not say was done), or `finish` (`runs` to make in order, then `mark` it done when the screen would). */
export type WordsPlan =
  | { did: 'gone' } | { did: 'by-screen' } | { did: 'not-done' } | { did: 'checked'; said: string }
  | { did: 'finish'; runs: { tool_id: string; input: Record<string, unknown> }[]; mark: boolean; said: string | null };

// A confirmation must account for the entire reply using the action's affirmative phrases. Finding "done" at an
// edge loses negation, uncertainty and contradictions. Unicode stays intact so DATA can declare any language.
function confirmsDone(text: string, doneSays: string[]): boolean {
  const normalize = (words: string) => words.normalize('NFKC').toLowerCase().replace(/’/gu, "'")
    .replace(/[.,!;。！，；]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const said = normalize(String(text));
  if (!said || said.includes('?')) return false;
  const phrases = [...new Set(doneSays.map(normalize).filter(Boolean))];
  const starts = new Set([0]);
  for (const start of starts) for (const phrase of phrases) {
    if (!said.startsWith(phrase, start)) continue;
    const end = start + phrase.length;
    if (end === said.length) return true;
    if (said[end] === ' ') starts.add(end + 1);
  }
  return false;
}

export function finishByWords(answer: NeedsAnswer | null | undefined, cardId: string, text: string, doneSays: string[] = []): WordsPlan {
  const found = (answer?.sections ?? []).flatMap(section => section.cards.map(card => ({ section, card }))).find(({ card }) => card.id === cardId);
  if (!found) return { did: 'gone' };
  const { section, card } = found;
  const way = wayOf(answer, section, card);
  if (way.kind === 'checked') return { did: 'checked', said: way.finish.checked ?? '' };
  if (way.kind === 'press') {
    const done = confirmsDone(text, doneSays);
    return done ? { did: 'finish', runs: [], mark: true, said: way.finish.said ?? null } : { did: 'not-done' };
  }
  const form = way.kind === 'form' ? { fields: way.fields, runs: way.runs, mark: true, said: way.finish.said ?? null }
    : way.kind === 'section-form' ? { fields: way.form.fields, runs: way.form.runs, mark: false, said: null } : null;
  // A proposed call whose every needed box holds a proposal is approved as proposed by words saying so (invariant 9).
  const proposal = form ? startOf(form.fields) : {};
  if (form && form.fields.some(field => field.proposed !== undefined) && form.fields.every(field => field.optional || known(proposal[field.name])) && confirmsDone(text, doneSays)) {
    return { did: 'finish', runs: runsOf(form.runs, card, proposal, form.fields), mark: form.mark, said: form.said };
  }
  const takesWords = form?.fields.filter(field => field.kind !== 'file') ?? [];
  const needed = form?.fields.filter(field => !field.optional) ?? [];
  if (!form || takesWords.length !== 1 || needed.some(field => field !== takesWords[0])) return { did: 'by-screen' };
  return { did: 'finish', runs: runsOf(form.runs, card, { [takesWords[0].name]: String(text).trim() }, form.fields), mark: form.mark, said: form.said };
}

/** A waiting thing's words read as what they are (invariant 7): the passage before its numbered steps, the steps one
 *  each, and the passage after them; words with no numbered lines are all `before`. */
export type DetailParts = { before: string; steps: string[]; after: string };
export function detailParts(detail: string | undefined): DetailParts {
  const lines = String(detail ?? '').split('\n');
  const first = lines.findIndex(line => STEP_LINE.test(line));
  if (first < 0) return { before: lines.join('\n').trim(), steps: [], after: '' };
  let last = first;
  lines.forEach((line, index) => { if (STEP_LINE.test(line)) last = index; });
  const between = lines.slice(first, last + 1);
  return {
    before: lines.slice(0, first).join('\n').trim(),
    steps: between.filter(line => STEP_LINE.test(line)).map(line => line.match(STEP_LINE)![1].trim()),
    after: [...between.filter(line => line.trim() && !STEP_LINE.test(line)), ...lines.slice(last + 1)].join('\n').trim(),
  };
}

/** One step split into where to go and the value to enter there (`Network > FTP > Host Name: 192.168.1.20`), when the
 *  part after its last `: ` is short enough to be a value to copy rather than words to read; else all words. */
export function stepValue(step: string, most = { characters: 40, words: 5 }): { label: string; value?: string } {
  const at = step.lastIndexOf(': ');
  if (at < 0) return { label: step };
  const value = step.slice(at + 2).trim().replace(/[.;]$/, '');
  if (!value || value.length > most.characters || value.split(/\s+/).length > most.words) return { label: step };
  return { label: step.slice(0, at).trim(), value };
}

// tools/guided-tours: a guided tour an AI writes for the moment a person is in, as DATA, and the writes that keep it.
// Pure: the caller passes the person's current records, the tour settings DATA (tools/tours-screen/read-data/tours.json),
// the urgency levels, the judge of words and the clock. It returns the writes to make and what to say; nothing is written
// here. Ported from the older repository's src/tours.mjs definitionOf, save, remove and show (commit b6ae0ebf81), with
// the same messages. The word judge and the walkthrough fold are the callers' (their homes are other owners), so a
// definition is checked by what the caller passes in.
import { pointingProblem } from './pointing-problem.mjs';

const text = value => (typeof value === 'string' ? value.trim() : '');
const slug = value => text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const toursOf = (current, settings) => (Array.isArray(current[settings.tours_label]) ? current[settings.tours_label] : []);

// The definition as the tour host will run it, or the reason it cannot run. `earlier` is the tour being changed, if any.
export function defineTour(input, { earlier = null, by = null, now, settings, urgencyLevels = [], judgeWords, isRunnable }) {
  const tour = input && typeof input === 'object' ? input : {};
  const title = text(tour.title);
  if (!title) throw new Error('tour needs title: what the tour shows, in a few words.');
  const steps = Array.isArray(tour.steps) ? tour.steps : [];
  if (!steps.length || steps.length > settings.steps_max) throw new Error(`tour needs between 1 and ${settings.steps_max} steps.`);
  const id = earlier?.id ?? `${settings.id_prefix}${text(tour.id) ? slug(tour.id) : slug(title) || globalThis.crypto.randomUUID()}`;
  // Every step dims and blurs the page when it shows centred, unless the AI chose its own look for it.
  const named = steps.map((step, at) => ({ look: settings.step_look, ...step, id: text(step?.id) || `step-${at + 1}` }));
  for (const step of named) {
    if (!step.content || typeof step.content !== 'object' || !text(step.content.content_kind))
      throw new Error(`Step ${step.id} needs content: { content_kind, payload }; read_tours card_kinds lists the kinds.`);
  }
  if (new Set(named.map(step => step.id)).size !== named.length) throw new Error('Each step needs its own id.');
  for (const step of named) {
    const problem = pointingProblem(step, settings.pointing);
    if (problem) throw new Error(`Step ${step.id} ${problem}`);
  }
  const triggers = Array.isArray(tour.triggers) ? tour.triggers : [];
  const askedByNameTriggers = triggers.filter(trigger => trigger?.reason === 'asked-by-name');
  const taskKey = askedByNameTriggers.find(trigger => typeof trigger.once_key === 'string')?.once_key;
  const consumeOn = askedByNameTriggers.find(trigger => Array.isArray(trigger.consume_on))?.consume_on;
  const askedByName = {
    reason: 'asked-by-name',
    on_event: { event_kind: 'walkthrough-requested', match: { walkthrough_id: id } },
    ...(taskKey ? { once_key: taskKey } : {}),
    ...(consumeOn ? { consume_on: consumeOn } : {}),
  };
  const own = triggers.filter(trigger => trigger?.reason !== askedByName.reason);
  const definition = {
    kind: 'walkthrough-definition',
    id,
    revision: (earlier?.revision ?? 0) + 1,
    title,
    ...(text(tour.summary) ? { summary: text(tour.summary) } : {}),
    entry_step: named.some(step => step.id === text(tour.entry_step)) ? text(tour.entry_step) : named[0].id,
    steps: named,
    triggers: [askedByName, ...own],
    look: { ...settings.look, ...(tour.look && typeof tour.look === 'object' ? tour.look : {}) },
    progress_style: tour.progress_style && typeof tour.progress_style === 'object' ? tour.progress_style : settings.progress_style,
    // A tour that plays itself: { step_ms, after_ms }, read by the tour host.
    ...(tour.play && typeof tour.play === 'object' && Number(tour.play.step_ms) > 0 ? { play: {
      step_ms: Math.min(Number(tour.play.step_ms), 60000),
      ...(Number(tour.play.after_ms) > 0 ? { after_ms: Math.min(Number(tour.play.after_ms), 60000) } : {}),
    } } : {}),
    // How much it matters, one of the tour host's urgency levels; an urgent tour that starts by itself passes rules that hold the rest.
    ...(urgencyLevels.some(level => level.id === tour.urgency) ? { urgency: tour.urgency } : {}),
    by: by ?? earlier?.by ?? null,
    saved_at: now().toISOString(),
  };
  if (!isRunnable(definition)) throw new Error('This tour is not one the tour host can run: each step needs an id and content, and entry_step must name a step.');
  if (JSON.stringify(definition).length > settings.tour_chars_max) throw new Error(`A tour is at most ${settings.tour_chars_max} characters of DATA; split it.`);
  const findings = judgeWords({ title: definition.title, summary: definition.summary, steps: definition.steps });
  if (findings.length) throw new Error(`Rewrite these words before saving the tour:\n${findings.join('\n')}`);
  return definition;
}

// The writes that save a tour: the tour list, its category filing (filed by the caller's group owner), and the show ask.
// The categories are read by the caller, which passes `fileInCategory(current, tourId, category)` -> writes.
export function planSaveTour({ input = {}, current, settings, now, judgeWords, isRunnable, fileInCategory = () => [] }) {
  const tours = toursOf(current, settings);
  const askedId = text(input.tour?.id);
  const earlier = tours.find(tour => tour.id === askedId || tour.id === `${settings.id_prefix}${slug(askedId)}`) ?? null;
  if (!earlier && tours.length >= settings.tours_max) throw new Error(`The person keeps at most ${settings.tours_max} tours; remove one first (remove_tour).`);
  const by = text(input.by) || null;
  const definition = defineTour(input.tour, { earlier, by, now, settings, urgencyLevels: settings.urgency_levels, judgeWords, isRunnable });
  const kept = earlier ? tours.map(tour => (tour.id === earlier.id ? definition : tour)) : [definition, ...tours];
  const category = text(input.category) || (earlier ? null : settings.default_category);
  const writes = [
    { address_label: settings.tours_label, payload: kept },
    ...(category ? fileInCategory(current, definition.id, category) : []),
    ...(input.show_now === true ? [showAsk({ id: definition.id, by, now, settings })] : []),
  ];
  return {
    writes,
    result: {
      tour: { tour_id: definition.id, title: definition.title, steps: definition.steps.length, revision: definition.revision, category },
      said: `${earlier ? 'Changed' : 'Kept'} the tour ${definition.title}${input.show_now === true ? '; it starts now on the person\'s open page' : ''}.`,
    },
  };
}

export function planRemoveTour({ tour_id, current, settings, unfileFromCategories = () => [] }) {
  const id = text(tour_id);
  const tours = toursOf(current, settings);
  if (!tours.some(tour => tour.id === id)) throw new Error(`There is no tour ${id || '(none named)'}; read_tours gives every tour_id.`);
  return {
    writes: [{ address_label: settings.tours_label, payload: tours.filter(tour => tour.id !== id) }, ...unfileFromCategories(current, id)],
    result: { removed: id, said: `Removed the tour ${id}.` },
  };
}

// A show ask: one tour by id, or (next: true) the next tour waiting to show by itself.
export function planShowTour({ input = {}, now, settings }) {
  const id = text(input.tour_id);
  if (!id && input.next !== true) throw new Error('Say which tour with tour_id (read_tours gives every tour_id), or next: true for the next one waiting.');
  return {
    writes: [showAsk({ id: id || null, by: text(input.by) || null, now, settings })],
    result: id
      ? { shown: id, said: `The tour ${id} starts now on the person's open page.` }
      : { shown: 'next', said: 'The next waiting tour starts now on the person\'s open page, if their show rules let one show.' },
  };
}

const showAsk = ({ id, by, now, settings }) => ({
  address_label: settings.show_label,
  payload: { ...(id ? { tour_id: id } : { next: true }), asked_at: now().toISOString(), by },
});

// tools/guided-tours: a tour an AI writes for the moment, checked and turned into the writes that keep it. Made-up tours.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defineTour, planRemoveTour, planSaveTour, planShowTour } from '../do-work/define-a-tour-for-the-moment.mjs';

const settings = {
  tours_label: 'guided-overlay::own-walkthroughs',
  show_label: 'guided-overlay::show-asked',
  id_prefix: 'own-',
  default_category: 'From your AIs',
  tours_max: 2,
  steps_max: 3,
  tour_chars_max: 4000,
  look: { spotlight: { blur_px: 6 } },
  step_look: { backdrop: { opacity: 0.45 } },
  progress_style: { style: 'segmented' },
  urgency_levels: [{ id: 'urgent' }, { id: 'normal' }],
  pointing: {
    shows_itself: ['picture', 'placeable-surface'],
    page_wide: ['[data-sidebar-'],
    too_vague: ['*', 'main'],
  },
};
const now = () => new Date('2026-11-20T09:00:00.000Z');
const noWords = () => [];
const runnable = () => true;
const step = (query = '[data-tile="bakery"]') => ({
  content: { content_kind: 'glance', payload: { title: 'A step' } },
  target_ref: { from: 'selector', query },
  target_preparation: { surface: { id: 'bakery-screen' } },
});
const tour = (extra = {}) => ({ title: 'Your week', steps: [step()], ...extra });
const define = (input, extra = {}) => defineTour(input, { now, settings, urgencyLevels: settings.urgency_levels, judgeWords: noWords, isRunnable: runnable, ...extra });

test('a tour needs a title and between one and steps_max steps', () => {
  assert.throws(() => define({ steps: [step()] }), /tour needs title/);
  assert.throws(() => define({ title: 'x', steps: [] }), /between 1 and 3 steps/);
  assert.throws(() => define(tour({ steps: [step(), step(), step(), step()] })), /between 1 and 3 steps/);
});

test('the id comes from the title and each step gets an id when it has none', () => {
  const made = define(tour());
  assert.equal(made.id, 'own-your-week');
  assert.equal(made.steps[0].id, 'step-1');
  assert.equal(made.revision, 1);
  assert.equal(made.steps[0].look.backdrop.opacity, 0.45);
});

test('two steps with one id are refused, and a step that points at nothing is refused with the reason', () => {
  assert.throws(() => define(tour({ steps: [{ ...step(), id: 'a' }, { ...step(), id: 'a' }] })), /Each step needs its own id/);
  assert.throws(() => define(tour({ steps: [{ content: { content_kind: 'glance' } }] })), /points at nothing/);
});

test('the asked-by-name trigger is built first, and the own triggers are kept beside it', () => {
  const made = define(tour({ triggers: [{ reason: 'page-entered', on_event: { event_kind: 'page-entered' } }] }));
  assert.deepEqual(made.triggers[0].on_event, { event_kind: 'walkthrough-requested', match: { walkthrough_id: 'own-your-week' } });
  assert.equal(made.triggers[1].reason, 'page-entered');
});

test('an urgency that is not a level is dropped, and a word finding refuses the save', () => {
  assert.equal(define(tour({ urgency: 'loud' })).urgency, undefined);
  assert.equal(define(tour({ urgency: 'urgent' })).urgency, 'urgent');
  assert.throws(() => define(tour(), { judgeWords: () => ['a stock heading'] }), /Rewrite these words/);
});

test('saving a new tour writes the list with it first, files it, and asks to show it now', () => {
  const plan = planSaveTour({
    input: { tour: tour(), show_now: true, by: 'Claude' },
    current: { [settings.tours_label]: [] },
    settings, now, judgeWords: noWords, isRunnable: runnable,
    fileInCategory: (current, id, category) => [{ address_label: 'group::categories', payload: { id, category } }],
  });
  assert.equal(plan.writes[0].payload[0].id, 'own-your-week');
  assert.equal(plan.writes[1].payload.category, 'From your AIs');
  assert.equal(plan.writes[1].address_label, 'group::categories');
  assert.deepEqual(plan.writes[2], { address_label: settings.show_label, payload: { tour_id: 'own-your-week', asked_at: '2026-11-20T09:00:00.000Z', by: 'Claude' } });
  assert.match(plan.result.said, /Kept the tour Your week; it starts now/);
});

test('saving over a tour changes it in place with the next revision, and no new show ask unless asked', () => {
  const earlier = define(tour());
  const plan = planSaveTour({
    input: { tour: { id: 'own-your-week', title: 'Your week', steps: [step()] } },
    current: { [settings.tours_label]: [earlier] },
    settings, now, judgeWords: noWords, isRunnable: runnable,
  });
  assert.equal(plan.writes[0].payload[0].revision, 2);
  assert.equal(plan.writes.length, 1);
  assert.match(plan.result.said, /^Changed the tour/);
});

test('a new tour is refused once the person keeps tours_max', () => {
  const full = [define(tour({ title: 'One' })), define(tour({ title: 'Two' }))];
  assert.throws(() => planSaveTour({
    input: { tour: tour({ title: 'Three' }) }, current: { [settings.tours_label]: full }, settings, now, judgeWords: noWords, isRunnable: runnable,
  }), /keeps at most 2 tours/);
});

test('removing a tour keeps the others; a missing tour is refused', () => {
  const kept = define(tour({ title: 'Keep me' }));
  const gone = define(tour({ title: 'Gone' }));
  const plan = planRemoveTour({ tour_id: gone.id, current: { [settings.tours_label]: [kept, gone] }, settings });
  assert.deepEqual(plan.writes[0].payload.map(t => t.id), [kept.id]);
  assert.deepEqual(plan.result, { removed: gone.id, said: `Removed the tour ${gone.id}.` });
  assert.throws(() => planRemoveTour({ tour_id: 'own-none', current: { [settings.tours_label]: [kept] }, settings }), /no tour own-none/);
});

test('showing a tour asks for it by id, or the next one waiting; with neither it is refused', () => {
  assert.deepEqual(planShowTour({ input: { tour_id: 'own-a', by: 'ChatGPT' }, now, settings }).writes[0].payload,
    { tour_id: 'own-a', asked_at: '2026-11-20T09:00:00.000Z', by: 'ChatGPT' });
  assert.deepEqual(planShowTour({ input: { next: true }, now, settings }).writes[0].payload,
    { next: true, asked_at: '2026-11-20T09:00:00.000Z', by: null });
  assert.throws(() => planShowTour({ input: {}, now, settings }), /Say which tour/);
});

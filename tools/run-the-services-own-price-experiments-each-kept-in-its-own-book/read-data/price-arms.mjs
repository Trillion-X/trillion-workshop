// Which price an observer is shown, and which offers they are shown: the arms of this service's own price experiments.
//
// Ported from old trillion src/price-experiments.mjs (armKey, armOf, assignArm, shownOffers) and src/payment.mjs
// (experimentsIn, assignArm, assignArms, offersShownTo, notePricesShown). An observer lands on the same arm of a running
// experiment every time: the sticky_hash split of the one candidate scorer (tools/funnels-screen/read-data/
// score-candidates.ts, owner of scoreCandidates), over `<experiment id>:<observer>`. The experiments are DATA
// (live-experiments.json, the live published record); an arm whose offer cannot take payment now is never served, and the
// caller says which arms are open.
import { scoreCandidates } from 'trillion-workshop/tools/funnels-screen/read-data/score-candidates.ts';

/** The offer an arm stands for: its offer id, else its price id, else its own id. */
export const armKey = arm => arm.offer_id ?? arm.price_id ?? arm.id;

/** The arm of `experiment` whose id or offer is `key`, or undefined. */
export const armOf = (experiment, key) => experiment.arms.find(arm => arm.id === key || armKey(arm) === key);

/** The arm an observer is shown in one experiment: the sticky arm of a running experiment among the arms `isOpen`
 *  lets through, the winner of a settled one (when open), none of a stopped one. `isOpen(arm)` says whether an arm's
 *  offer can take payment now. Pure: the same answer every time. */
export function assignArm(observer, experiment, isOpen = () => true) {
  if (experiment.state === 'stopped') return null;
  if (experiment.state === 'settled') {
    const winner = armOf(experiment, experiment.result?.winner);
    return winner && isOpen(winner) ? winner.id : null;
  }
  const split = Object.fromEntries(experiment.arms.filter(arm => arm.weight > 0 && isOpen(arm)).map(arm => [arm.id, arm.weight]));
  if (!Object.keys(split).length) return null;
  const surface = { address: experiment.id, candidates: Object.keys(split).map(candidate_id => ({ candidate_id })) };
  const decider = { accepts_trust: [], score: { op: 'sticky_hash', of: { fact_path: ['observer'] }, split: { split } } };
  const facts = [{ path: ['observer'], value: `${experiment.id}:${observer}`, trust_ref: 'trust:this-service' }];
  return scoreCandidates(surface, facts, decider).winner?.candidate_id ?? null;
}

/** An observer's arm in every experiment, `{ <surface>: arm id or null }`, without keeping anything. */
export const assignArms = (observer, experiments, isOpen) => Object.fromEntries(experiments.map(experiment => [experiment.surface, assignArm(observer, experiment, isOpen)]));

/** The offers one observer is shown: every offer that is no experiment's arm, the arms chosen for them (`chosen`, arm
 *  ids or offer keys), and any offer they already hold (`holds`). `keyOf` reads an offer's key. */
export function shownOffers({ offers, experiments, chosen = [], holds = () => false, keyOf = offer => offer.id }) {
  const picked = new Set(chosen);
  const arms = new Map(experiments.flatMap(experiment => experiment.arms.map(arm => [armKey(arm), arm])));
  return offers.filter(offer => {
    const arm = arms.get(keyOf(offer));
    return !arm || holds(offer) || picked.has(arm.id) || picked.has(armKey(arm));
  });
}

/** Counts the prices `observer` was just shown: one `price_shown` interaction per running experiment it quotes, kept by
 *  the interactions owner (tools/see-customers-and-their-journeys/read-data/interactions.mjs createInteractions).
 *  `interactions` is that owner's result; `store` is what its noteInteractions keeps into. A robot's look is not counted. */
export function notePricesShown(interactions, store, experiments, arms, observer, agent = undefined) {
  if (!observer || (agent !== undefined && interactions.isRobot(agent))) return Promise.resolve();
  const events = experiments.filter(experiment => experiment.state === 'running' && arms?.[experiment.surface])
    .map(experiment => interactions.serverEvent('price_shown', { experiment: experiment.id, arm: arms[experiment.surface] }));
  return interactions.noteInteractions(store, events, { address: observer, agent: 'price' });
}

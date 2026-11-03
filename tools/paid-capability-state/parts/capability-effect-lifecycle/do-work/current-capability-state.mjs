// parts/capability-effect-lifecycle/do-work/current-capability-state.mjs
//
// Track an effect from start to finish: fold a person's admitted effects (from signed-event-effects) into the
// episodes they belong to and each episode's current state, then into the capabilities the person holds now.
//
//   observedLifecycleFactSet({ effects, lifecycle })            → [{ episode_ref, offer_id, state, started_at, ended_at?, events }]
//   currentCapabilityState({ effects, offers, lifecycle })       → { episodes, active_offers, capabilities, limits }
//     (an offer row that asks for no money is active for everyone unless it is `held_only_when_given`; `limits` names each capability the person holds
//     only within an allowance: { [access_ref]: [allowance row without its access, one per active offer] }. An offer grants an access_ref without limit
//     unless its `allowances` row names that access_ref; any active offer granting it without limit lifts the
//     limit, and otherwise the largest allowance among the active offers applies.)
//   installedLifecycle(id)                                        → the lifecycle row installed with this part
//
// Blind to products and providers: an episode is found by the lifecycle row's `episode_keys`, a state change by
// its `transitions` rows, and a capability by the offer row's `access_refs`. Nothing here names an offer, a
// provider or an effect kind. Pure: the same effects always give the same state, whatever order they arrive in.
import lifecycleData from '../data/effect-lifecycles.json' with { type: 'json' };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const present = value => value !== undefined && value !== null && value !== '';

export function installedLifecycle(id) {
  const found = lifecycleData.lifecycles.find(row => row.id === id);
  if (!found) throw new Error(`${id} is not an installed effect lifecycle.`);
  return found;
}

function episodeOf(effect, lifecycle) {
  const material = object(effect.material) ? effect.material : {};
  for (const key of lifecycle.episode_keys ?? []) if (present(material[key])) return String(material[key]);
  return null;
}

function transitionFor(effect, lifecycle) {
  const material = object(effect.material) ? effect.material : {};
  return (lifecycle.transitions ?? []).find(row => row.effect_kind === effect.kind
    && (!row.when || (row.when.in ?? []).includes(material[row.when.attribute]))) ?? null;
}

const occurredAt = effect => String(effect.material?.occurred_at ?? '');
// Opaque identifiers have the same exact textual order in a host, a device and a durable indexed view.
export const compareLifecycleText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const order = (a, b) => compareLifecycleText(occurredAt(a), occurredAt(b)) || compareLifecycleText(String(a.effect_id), String(b.effect_id));

export function observedLifecycleFactSet({ effects, lifecycle }) {
  if (!object(lifecycle) || !Array.isArray(lifecycle.transitions)) throw new Error('A lifecycle row with transitions is needed.');
  const episodes = new Map();
  for (const effect of [...(effects ?? [])].filter(object).sort(order)) {
    const ref = episodeOf(effect, lifecycle);
    const transition = transitionFor(effect, lifecycle);
    if (!ref || !transition) continue;
    const episode = episodes.get(ref) ?? { episode_ref: ref, offer_id: null, subject: effect.subject, state: null, started_at: null, events: [] };
    // The offer is named by the effect that starts the episode; a later effect may not know it (a renewal of a
    // subscription bought before its offer was recorded), and then the episode keeps the one it has.
    if (!episode.offer_id && present(effect.material?.offer_id)) episode.offer_id = effect.material.offer_id;
    if (transition.to === 'active' && episode.state !== 'active') { episode.started_at = occurredAt(effect); delete episode.ended_at; }
    if (transition.to === 'ended' && episode.state !== 'ended') episode.ended_at = occurredAt(effect);
    episode.state = transition.to;
    episode.events.push({ effect_id: effect.effect_id, kind: effect.kind, at: occurredAt(effect) });
    episodes.set(ref, episode);
  }
  return [...episodes.values()];
}

export function currentCapabilityState({ effects, offers, lifecycle }) {
  const episodes = observedLifecycleFactSet({ effects, lifecycle });
  const offerById = new Map((offers ?? []).filter(object).map(offer => [offer.id, offer]));
  // An offer that asks for no money is held by everyone, with no episode, unless its row says it is only given
  // (`held_only_when_given`): then it is held only through an active episode, like a paid one.
  const free = [...offerById.values()].filter(offer => !offer.held_only_when_given && (offer.price_options ?? []).every(option => !(option?.amount_cents > 0))).map(offer => offer.id);
  const paid = episodes.filter(episode => episode.state === 'active' && offerById.has(episode.offer_id)).map(episode => episode.offer_id);
  const activeOffers = [...new Set([...free, ...paid])];
  const capabilities = [...new Set(activeOffers.flatMap(id => offerById.get(id).access_refs ?? []))].sort();
  const limits = {};
  for (const access of capabilities) {
    const granted = activeOffers.map(id => offerById.get(id)).filter(offer => (offer.access_refs ?? []).includes(access))
      .map(offer => (offer.allowances ?? []).find(row => row?.access === access) ?? null);
    // Every active offer's allowance row for it, as the row says it (count, amount, period); the consumer combines them.
    if (granted.every(Boolean)) limits[access] = granted.map(({ access: _access, ...row }) => row);
  }
  return { episodes, active_offers: activeOffers, capabilities, limits };
}

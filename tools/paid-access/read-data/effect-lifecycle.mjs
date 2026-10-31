// tools/paid-access/read-data/effect-lifecycle.mjs
//
// Track an effect from start to finish: fold a person's effects (read-data/payment-effects.mjs) into the episodes they
// belong to and each episode's current state, then into the capabilities the person holds now. Ported from
// bitfield-packages packages/capability-effect-lifecycle (do-work/current-capability-state.mjs) with its tests.
//
//   observedLifecycleFactSet({ effects, lifecycle })                  -> [{ episode_ref, offer_id, subject, state, started_at, ended_at?, events }]
//   currentCapabilityState({ effects, offers, lifecycle, subject? })  -> { episodes, active_offers, capabilities, limits }
//
// Blind to products and providers: an episode is found by the lifecycle row's `episode_keys`, a state change by its
// `transitions` rows, and a capability by the offer row's `access_refs`. Nothing here names an offer, a provider or an
// effect kind. Pure: the same effects always give the same state, whatever order they arrive in. An offer row that
// asks for no money is active for everyone; `limits` names each capability held only within an allowance
// ({ [access_ref]: [allowance row without its access, one per active offer] }); any active offer that grants it
// without an allowance lifts the limit.
//
// Changed from the package: `subject` (when given) keeps only that person's episodes, judged on the subject of the
// effect that started each episode, so a refund or a cancellation that names someone else's address (or only its own
// provider reference) still ends the episode it belongs to; the installed lifecycle row is the person's own record
// (or read-data/take-payments-events.json), not a table inside the package.

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const present = value => value !== undefined && value !== null && value !== '';

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
const order = (a, b) => occurredAt(a).localeCompare(occurredAt(b)) || String(a.effect_id).localeCompare(String(b.effect_id));

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

export function currentCapabilityState({ effects, offers, lifecycle, subject }) {
  const episodes = observedLifecycleFactSet({ effects, lifecycle }).filter(episode => subject === undefined || episode.subject === subject);
  const offerById = new Map((offers ?? []).filter(object).map(offer => [offer.id, offer]));
  // An offer that asks for no money is held by everyone, with no episode.
  const free = [...offerById.values()].filter(offer => (offer.price_options ?? []).every(option => !(option?.amount_cents > 0))).map(offer => offer.id);
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

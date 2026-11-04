// src/waiting-notice-guard.mjs
//
// PURPOSE
//   The guard every tell has (src/tell-the-person.mjs guardFor): a notice about one waiting or held thing (refs.card is
//   <source>:<id>, as Waiting on you names its cards) is not sent once the thing is not held. One rule for every owner
//   of Waiting on you (the account's own records, src/native-waiting-account-owner.mjs, and src/person-store.mjs), each
//   giving it its own reads.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a thing seen to be gone stops a notice: a notice about no card, a source it cannot read cheaply (voices), or
//      a source that failed to read is sent (null).
//   2. A row of the person's own list (asks:) is not sent when it is gone, Done, or its rule is true now (the rule's
//      check closes it then); every other source is checked by reading just that source and asking whether the card is
//      still among its cards, never the whole of Waiting on you.
//
//   waitingNoticeGuard(refs, owner) → null | (async () → null | { inactive: true, reason })
//     owner.row(id) → Promise<row | null>     the person's own list row, null when gone or hidden on this device
//     owner.closedByRule(id) → Promise<check | null>  settles the rules; the check that closed the row now, else null
//     owner.source(name) → async reader       one source of Waiting on you (src/card-sections.mjs readCardSections)
//     owner.done() → Set<card id>             the cards the person marked done
import { readCardSections } from '../../browse-inspiration-clips/card-sections.mjs';
import { doneWords } from './done-when.mjs';
import waitingOnYouSettings from '../../keep-and-wake-ai-sessions-on-this-computer/src/waiting-on-you.json' with { type: 'json' };

export function waitingNoticeGuard(refs, owner) {
  const [name, ...rest] = String(refs?.card ?? '').split(':');
  const source = waitingOnYouSettings.sources[name];
  if (!source || !rest.length) return null;
  const sets = source.done_sets;
  if (name === 'asks' && sets) {
    const id = rest.join(':');
    return async () => {
      const row = await owner.row(id);
      if (!row) return { inactive: true, reason: doneWords('row_gone') };
      if (row.values?.status === sets.values.status) return { inactive: true, reason: doneWords('row_done') };
      if (!row.values?.done_when_rule) return null;
      const check = await owner.closedByRule(id);
      return check ? { inactive: true, reason: doneWords('already_done', { says: check.says }) } : null;
    };
  }
  if (name === 'voices') return null;
  return async () => {
    const sections = waitingOnYouSettings.sections.filter(section => section.read.from === name).map(section => ({ ...section, limit: Number.MAX_SAFE_INTEGER }));
    const answer = await readCardSections({ [name]: owner.source(name) }, { ...waitingOnYouSettings, sections }, { done: owner.done() });
    if (answer.sections.some(section => section.failed)) return null;
    return answer.sections.some(section => section.cards.some(card => card.id === refs.card)) ? null : { inactive: true, reason: doneWords('no_longer_held') };
  };
}

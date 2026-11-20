// do-work/controls-check.mjs
//
// PURPOSE
//   Which waiting things reach the person with no working control. Pure: it reads the cards it is handed and says, for
//   each one, the control the hold would give it (needs-you-hold.mjs `controlOf`) or why it has none. Nothing is read
//   from the network and no key is used: the caller passes the waiting rows, already shaped as cards.
//
//   The check does not draw the screen a card opens (that needs a read of the screen, a separate step); it checks only
//   that a card's place is a the app screen by the screens' own DATA (placeOfAddress over the surfaces catalog).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Read-only and pure: no fetch, no file, no key. The input is the whole answer; the output is the whole result.
//   2. Blind: nothing here names a kind of card, a screen or a service; the rules and screens come from the input and
//      the screens' own DATA.
//   3. Its own findings are never counted as waiting things: a card whose id starts with `check:` is left out (the check
//      does not file or count itself).

import surfaces from '../../shared-code/src/workspace/screens.mjs';
import { placeOfAddress } from '../../hand-off-jobs-between-agents/src/workspace/addresses.mjs';
import { controlOf } from '../../hold-one-thing-until-done/read-data/needs-you-hold.mjs';

const SELF_PREFIX = 'check:';

/** Whether an address opens a the app screen, judged by the screens' own rows for the origin given. */
export function opensScreenAt(origin) {
  return address => placeOfAddress(surfaces.surfaces, address, origin) !== null;
}

/** The cards with no working control: [{ id, title, why }], judged over every section's cards.
 *  `answer` is { finishes?, sections: [{ id, batch?, finish?, cards: [{ id, title, does_in?, finish?, response?, detail? }] }] }
 *  and `opensScreen(address)` says whether an address opens a screen. */
export function cardsWithoutControl(answer, opensScreen = () => true) {
  const broken = [];
  let checked = 0;
  for (const section of answer?.sections ?? []) {
    for (const card of section.cards ?? []) {
      if (String(card.id ?? '').startsWith(SELF_PREFIX)) continue;
      checked += 1;
      const control = controlOf({ finishes: answer.finishes ?? [] }, section, card, opensScreen);
      if (control) continue;
      const why = card.does_in ? `does_in ${card.does_in} opens no screen` : 'nothing to press, no place in the app, no steps';
      broken.push({ id: card.id, title: card.title ?? section.id ?? '', why });
    }
  }
  return { checked, without_control: broken.length, broken };
}

// The tool's entry: the input on stdin is { origin?, finishes?, sections }, the output on stdout is the result.
if (import.meta.url === `file://${process.argv[1]}`) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const opensScreen = input.origin ? opensScreenAt(input.origin) : () => false;
  process.stdout.write(JSON.stringify(cardsWithoutControl(input, opensScreen)));
}

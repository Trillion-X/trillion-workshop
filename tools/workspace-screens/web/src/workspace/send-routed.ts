// src/workspace/send-routed.ts
//
// PURPOSE
//   What happens after the shared message box sends: the share goes through the device outbox (share-outbox.ts), the work
//   it started is handed to the box, and the person is told in words whether it was sent, connected to pursuits or kept.
//   Fetched when something is sent (and by the tray), so the page's first load does not carry it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A share the account could not be reached for is said as kept, never as failed.
//   2. A delivery that stopped partway throws the account's own words, naming the places it did reach.
//   3. Words are DATA (send-routed.json, send-choices.json).

import words from './send-choices.json';
import route from './send-routed.json';
import { deviceOutbox, fill, listed } from './send-choices';
import type { Delivered as OutboxResult } from './share-outbox';
import type { RunRef } from 'trillion-workshop/tools/hand-work-to-ais/web/src/workspace/job-run.tsx';

/** What to tell the person about one delivery: kept on this device, kept by the account, connected to pursuits, or sent to places. */
export function routedWords(result: OutboxResult): string {
  if (result.state === 'kept') return route.kept;
  const answer = result.answer;
  if (answer.queued) return route.kept;
  const titles = (answer.connected?.pursuits ?? []).map(row => row.title).filter(Boolean);
  if (titles.length) return fill(route.on_it_with, { pursuits: listed(titles) });
  const sentTo = listed((answer.delivered ?? []).map(place => place.label));
  return sentTo ? fill(words.sent, { places: sentTo }) : route.on_it;
}

/** Sends the box's share through the outbox, hands the work it started to `started`, and answers what to tell the person. */
export async function deliverFromBox(body: Record<string, unknown>, started: (runs: RunRef[]) => void): Promise<string> {
  const result = await (await deviceOutbox()).deliver(body);
  if (result.state === 'sent') {
    started((result.answer.handoff_ids ?? []).map(handoff => ({ handoff })));
    if (result.answer.stopped_at) {
      const sentTo = listed((result.answer.delivered ?? []).map(place => place.label));
      throw new Error(`${result.answer.stopped_at.error}${sentTo ? ` ${fill(words.sent, { places: sentTo })}.` : ''}`);
    }
  }
  return routedWords(result);
}

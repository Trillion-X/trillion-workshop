// tools/suggest-what-to-ask-on-a-screen/ideas-for-a-screen.mjs
//
// The written ideas for what to ask an AI on one screen, as one run: work-examples.mjs examplesFor, unchanged, over
// its DATA file workspace/examples.json (keyed by screen). Each idea is { id, title, detail, do_this, from: 'written' },
// do_this being the request a person's AI would be handed for it.
//
//   ideasForAScreen({ screen }) -> { heading, count_words, words, examples }
//
// Inputs: screen, a screen key of examples.json (calendar, marketplace, home, files, ...).
// Refuses: a screen that is not a non-empty string, and a screen examples.json has no row for (the answer names the
// screens it does have).
//
// What the run never does: it hands nothing to an AI (the screen's Do this for me POST is the Worker's), reads no
// published stories (the pool is the Worker's: none are added), and asks no account which tools it has (no person
// is given, so no capability ideas are added). It reads only examples.json and writes nothing.
import examples from './workspace/examples.json' with { type: 'json' };
import { examplesFor } from './work-examples.mjs';

export async function ideasForAScreen({ screen } = {}) {
  const known = Object.keys(examples.screens);
  if (typeof screen !== 'string' || !screen.trim()) throw new Error(`Give screen: a screen key, one of ${known.join(', ')}.`);
  if (!Object.hasOwn(examples.screens, screen)) throw new Error(`No ideas are written for screen ${JSON.stringify(screen)}; use one of ${known.join(', ')}.`);
  const found = await examplesFor(screen, { stories: async () => [], origin: '', person: null, about: {} });
  if (!found) throw new Error(`Screen ${JSON.stringify(screen)} has no written ideas; use one of ${known.join(', ')}.`);
  return found;
}

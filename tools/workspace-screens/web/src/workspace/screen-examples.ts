// src/workspace/screen-examples.ts
//
// Every screen of the workspace opens with ideas for what to do there: the shared examples strip
// (parts/ui/show/examples-strip) above the screen, filled from /work/api/examples?screen=<key> (src/work-examples.mjs,
// whose authored rows are src/workspace/examples.json and whose capability ideas are read from the current pursuit
// or exact offered tool). "Do this for me" hands the reconstructed example to the person's AI.
import type { ExampleItem, ExamplesStripWords } from '../../parts/ui/show/examples-strip';
import { postJson, readJson } from './api';

type Unmount = () => void;
type Examples = { heading: string; count_words: string; words: ExamplesStripWords; examples: ExampleItem[]; capabilities_unavailable?: boolean };

// Mounts `mount` beneath the screen's examples strip inside `element`; returns the unmount for both. `about` is the
// pane's own input (an open space's id), which the Worker puts into the row's words when it hands an example over.
export function withExamples(element: HTMLElement, screen: string, mount: (host: HTMLElement) => Unmount, about: Record<string, unknown> = {}): Unmount {
  const strip = document.createElement('div');
  strip.className = 'trillion-screen-examples';
  const body = document.createElement('div');
  body.className = 'trillion-screen-body';
  element.classList.add('trillion-pane-with-examples');
  element.replaceChildren(strip, body);
  const unmountScreen = mount(body);
  let unmountStrip: Unmount = () => {};
  let open = true;
  const unmount = () => {
    open = false;
    unmountStrip();
    unmountScreen?.();
    element.classList.remove('trillion-pane-with-examples');
    element.replaceChildren();
  };
  // The source catalog decides whether an unlisted screen has a current capability; this client does not carry a
  // second hardcoded allowlist. Unknown screens quietly receive the endpoint's ordinary no-examples answer.
  const query = new URLSearchParams({ screen });
  for (const key of ['id', 'tool_id', 'space_id']) {
    const value = about[key];
    if (typeof value === 'string') query.set(key, value);
  }
  Promise.all([readJson<Examples>(`/work/api/examples?${query}`), import('../../parts/ui/show/examples-strip')])
    .then(([found, { mountExamplesStrip }]) => {
      // An answer without a list of examples leaves the screen as it is, never takes it down.
      if (!open || !Array.isArray(found?.examples)) return;
      unmountStrip = mountExamplesStrip(strip, {
        heading: found.heading,
        countWords: found.count_words,
        words: found.words,
        examples: found.examples,
        onDo: async example => {
          const answer = await postJson<{ said: string; copy_request?: string }>('/work/api/examples/do', { screen, example_id: example.id, ...(Object.keys(about).length ? { about } : {}) });
          return { said: answer.said, ...(answer.copy_request ? { copy: answer.copy_request } : {}) };
        },
      });
      if (found.capabilities_unavailable) {
        const note = document.createElement('p');
        note.className = 'trillion-examples-unavailable';
        note.textContent = 'Trillion could not check the current tools for more ideas. Try opening this section again later.';
        strip.append(note);
      }
    })
    // A screen without examples, or examples that could not be read, leaves the screen as it is.
    .catch(() => {});
  return unmount;
}

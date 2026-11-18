// src/workspace/value-view.tsx
//
// PURPOSE
//   The script of the view an AI app (ChatGPT, Claude) draws for the answer of any operation the engine's door runs (its
//   one tool names this view in its `_meta.ui.resourceUri`: trillion-rust src/mcp/hosts.rs `tool_meta`, `resources`).
//   The answer is drawn as it is: tools/ui/show/view-of-a-value/project.mjs turns the value into a screen of shared parts,
//   and the parts screen (./parts-screen.tsx) mounts it, so no operation needs a screen written for it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names an operation, a record kind or a field; which parts draw an answer is the rows of
//      view-of-a-value.json, read by project.mjs.
//   2. The view holds no credential: a call the screen makes goes to the app as a tool call, which the app makes as the
//      person who connected it (ai-app-bridge.mjs `callTool`).
//   3. Fixed addresses: the build writes this script and its look as value-view.js and value-view.css, which the front
//      door serves; the view's document (the door's own, naming its origin) loads them. The frame opens no live channel
//      and reads no person's data by itself.
//   4. Every answer is drawn, a refusal too (the door's `{code, outcome}`, drawn by the rows' own error row).
//   5. A press sends only what the answer on the screen offered (project.mjs invariant 6), through the one tool, each with
//      a fresh request key, and its answer is drawn in place: an answer is a screen, and a press's answer is the next one.

import { connectToAiApp } from '../../../../ui/show/ai-app-bridge/ai-app-bridge.mjs';
import { projectValue } from '../../../../ui/show/view-of-a-value/project.mjs';
import { mountPartsScreen, type PartsScreenHandle } from './parts-screen';

const HOST_ID = 'value-view';
const content = document.getElementById(HOST_ID) as HTMLElement;
let screen: PartsScreenHandle | null = null;
// What the answer on the screen offers to run (project.mjs `requests`): a press sends only these.
let offered: Record<string, unknown> = {};

// The look's tokens come with the view's stylesheet (the look every page starts with); the page's own rules apply.
document.body.classList.add('screen-look-page');

type Offer = { address: string; method: string; input?: Record<string, unknown>; fill?: string };

/** The fixed input of an offer with the screen's own input put at its `fill` pointer. */
function filled(offer: Offer, input: unknown): Record<string, unknown> {
  const whole = structuredClone(offer.input ?? {});
  const steps = (offer.fill ?? '').split('/').slice(1).map(step => step.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!steps.length) return { ...whole, ...(input && typeof input === 'object' ? input as Record<string, unknown> : {}) };
  let here: Record<string, unknown> = whole;
  for (const step of steps.slice(0, -1)) here = (here[step] && typeof here[step] === 'object' ? here[step] : (here[step] = {})) as Record<string, unknown>;
  here[steps.at(-1)!] = input ?? {};
  return whole;
}

/** Draws one answer, and keeps what it offers to run. */
function show(value: unknown, isError = false) {
  const drawn = projectValue(isError && typeof value === 'string' ? { error: {}, message: value } : value);
  offered = drawn.requests;
  screen ??= mountPartsScreen(content, { call: (name, input) => press(name, input) });
  screen.requests(offered);
  screen.show(drawn.spec);
  requestAnimationFrame(() => app.reportSize());
}

/** A press: the one tool, as the person who connected the app, with a key of its own so a repeat never runs twice. Its
 * answer is drawn in place by the same rows. */
async function press(name: string, params: Record<string, unknown> = {}) {
  const offer = offered[name] as Offer | undefined;
  if (!offer || typeof offer.address !== 'string' || typeof offer.method !== 'string') throw new Error('This answer offers nothing by that name.');
  const answer = await app.callTool('run_resource_operation', { address: offer.address, method: offer.method, request_key: crypto.randomUUID(), input: filled(offer, params.input) });
  show(answer);
  return answer;
}

const app = connectToAiApp(window, {
  appName: HOST_ID, content,
  onToolResult: ({ structuredContent, content: blocks, isError }) => {
    // An answer with no structured value is drawn from its words.
    show(structuredContent ?? (blocks as { text?: string }[]).map(block => block?.text).filter(Boolean).join('\n'), isError);
  },
});
new ResizeObserver(() => app.reportSize()).observe(content);

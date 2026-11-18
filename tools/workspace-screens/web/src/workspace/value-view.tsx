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

import { connectToAiApp } from '../../../../ui/show/ai-app-bridge/ai-app-bridge.mjs';
import { projectValue } from '../../../../ui/show/view-of-a-value/project.mjs';
import { mountPartsScreen, type PartsScreenHandle } from './parts-screen';

const HOST_ID = 'value-view';
const content = document.getElementById(HOST_ID) as HTMLElement;
let screen: PartsScreenHandle | null = null;

// The look's tokens come with the view's stylesheet (the look every page starts with); the page's own rules apply.
document.body.classList.add('screen-look-page');

const app = connectToAiApp(window, {
  appName: HOST_ID, content,
  onToolResult: ({ structuredContent, content: blocks, isError }) => {
    // An answer with no structured value is drawn from its words.
    const value = structuredContent ?? (blocks as { text?: string }[]).map(block => block?.text).filter(Boolean).join('\n');
    screen ??= mountPartsScreen(content, { call: (name, input) => app.callTool(name, input) });
    screen.show(projectValue(isError && typeof value === 'string' ? { error: {}, message: value } : value).spec);
    requestAnimationFrame(() => app.reportSize());
  },
});
new ResizeObserver(() => app.reportSize()).observe(content);

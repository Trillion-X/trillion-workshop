// src/workspace/account-own-answers.ts
//
// PURPOSE
//   The answers a signed-in page served from files gives itself, for what the account keeps nothing of. A tool's saved
//   screen context belongs to a screen tool the account saved itself (keep-and-wake-ai-sessions-on-this-computer
//   src/workshop.mjs screenContext); such a page keeps no saved tools, so a tool opens on its own input ({ tool_id }), as
//   that owner answers for every tool the account did not save, and a named saved context is gone (410), as it answers
//   for one it cannot find. Every other address goes on to the account's door (account-door.ts).

import type { PageAnswer } from './api';

const SCREEN_CONTEXT = '/work/api/workshop/screen-context';

/** This page's own answer to `path`, or null when the account's door answers it. */
export function answerHere(path: string, init: RequestInit): PageAnswer | null {
  if (new URL(path, location.origin).pathname !== SCREEN_CONTEXT) return null;
  const asked = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { tool_id?: string; screen_context_id?: string };
  if (asked.screen_context_id !== undefined) return { status: 410, body: { error: 'This saved screen context is unavailable.' } };
  return { status: 200, body: { input: { tool_id: asked.tool_id } } };
}
